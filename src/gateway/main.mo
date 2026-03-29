/// OpenClaw ICP — Gateway Canister
///
/// The Gateway is the central orchestrator of the OpenClaw platform. It is the
/// single entry-point for all user-facing LLM interactions. Its responsibilities:
///
///   1. **Authentication** — rejects anonymous callers via Auth.requireAuth.
///   2. **Reentrancy protection** — a CallerGuard prevents a user from having
///      two in-flight prompt() calls at the same time (important because ICP
///      inter-canister calls are asynchronous and state can change across awaits).
///   3. **Conversation management** — stores per-user conversation history in a
///      nested OrderedMap (Principal -> ConversationId -> Conversation).
///   4. **LLM routing** — delegates to LlmRouter, which decides between the
///      free on-chain DFINITY LLM and paid external providers (Anthropic,
///      OpenAI, MagickMind) via HTTPS outcalls.
///   5. **Payment (saga pattern)** — for external models the Gateway deducts a
///      fee from the user's Wallet balance *before* the LLM call, then refunds
///      on failure. This "deduct-before-await, refund-on-error" approach is
///      the standard saga/compensation pattern for ICP canisters, since there
///      are no cross-canister transactions.
///   6. **API key resolution** — retrieves encrypted keys from the KeyVault
///      canister on behalf of the user.
///   7. **Identity integration** — increments prompt counts on the Identity
///      canister after successful calls (best-effort / fire-and-forget).
///
/// Architecture note: this is a `persistent actor class`. The `deployer`
/// argument is captured at install time and used as the immutable admin
/// principal. All `var` fields survive canister upgrades automatically.
/// Fields marked `transient` are re-initialised on every upgrade (e.g. the
/// CallerGuard map and OrderedMap comparators, which are closures and cannot
/// be serialised).
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Nat "mo:base/Nat";
import Text "mo:base/Text";
import Time "mo:base/Time";
import Result "mo:base/Result";
import Buffer "mo:base/Buffer";
import Cycles "mo:base/ExperimentalCycles";
import Array "mo:base/Array";
import Char "mo:base/Char";
import Int "mo:base/Int";

import IC "mo:ic";

import Types "Types";
import Auth "Auth";
import LlmRouter "LlmRouter";
import HttpOutcalls "HttpOutcalls";
import Communications "Communications";

/// The Gateway actor class. `deployer` is the Principal of whoever ran
/// `dfx deploy`; it becomes the permanent admin for configuration calls.
persistent actor class Gateway(deployer : Principal) {

  // ── Type aliases ────────────────────────────────────────────────
  // Re-exported from Types for local convenience; keeps function
  // signatures shorter throughout this file.
  type ConversationId = Types.ConversationId;
  type Conversation = Types.Conversation;
  type Message = Types.Message;
  type PromptRequest = Types.PromptRequest;
  type PromptResponse = Types.PromptResponse;
  type OpenClawError = Types.OpenClawError;
  type ConversationSummary = Types.ConversationSummary;
  type SystemPromptTemplate = Types.SystemPromptTemplate;
  type ExportFormat = Types.ExportFormat;
  type MagickMindConfig = Types.MagickMindConfig;
  type MagickMindBrainMode = Types.MagickMindBrainMode;
  type Persona = Types.Persona;
  type PersonaTrait = Types.PersonaTrait;
  type PersonaTraits = Types.PersonaTraits;
  type TraitSnapshot = Types.TraitSnapshot;
  type GrowthConfig = Types.GrowthConfig;
  type GrowthType = Types.GrowthType;
  type MultiLlmConfig = Types.MultiLlmConfig;
  type GroupChat = Types.GroupChat;
  type GroupMessage = Types.GroupMessage;
  type DualPromptResponse = Types.DualPromptResponse;
  type CompareRequest = Types.CompareRequest;
  type ModelResponse = Types.ModelResponse;
  type CompareResponse = Types.CompareResponse;

  // ── Constants ─────────────────────────────────────────────────
  // Hard caps that protect canister memory from unbounded growth.
  let MAX_CONVERSATIONS_PER_USER : Nat = 100;
  let MAX_MESSAGES_PER_CONVERSATION : Nat = 200;
  // Cycle balance below which getStatus() reports lowCycles = true,
  // signalling operators to top up the canister.
  let LOW_CYCLES_THRESHOLD : Nat = 500_000_000_000; // 0.5T cycles
  let MAX_TEMPLATES_PER_USER : Nat = 20;
  let MAX_TEMPLATE_CONTENT : Nat = 2000;
  let MAX_TEMPLATE_NAME : Nat = 60;
  let MAX_PERSONAS_PER_USER : Nat = 20;

  // ── Persistent state ────────────────────────────────────────────
  // These survive canister upgrades (Motoko enhanced orthogonal persistence).

  // `transient` means these are re-created from scratch on every upgrade.
  // OrderedMap comparators are closures, which cannot be serialised, so they
  // must be transient. The actual map *data* (userConversations etc.) is
  // persistent — only the comparator helpers reset.
  transient let principalOps = Map.Make<Principal>(Principal.compare);
  transient let textOps = Map.Make<Text>(Text.compare);

  // Nested map: user principal -> (conversationId -> Conversation).
  // This is the primary data store for all conversation history.
  var userConversations : Map.Map<Principal, Map.Map<Text, Conversation>> = principalOps.empty();
  // Monotonically increasing counter used for both conversation IDs and
  // idempotency keys. Never decremented.
  var nonceCounter : Nat = 0;
  // Inter-canister references set by admin after deployment. These are
  // optional because they are configured post-deploy via setKeyVault, etc.
  var keyVaultPrincipal : ?Principal = null;
  var walletPrincipal : ?Principal = null;
  var identityPrincipal : ?Principal = null;

  // Per-user system prompt templates. Keyed by principal -> templateId -> template.
  var userTemplates : Map.Map<Principal, Map.Map<Text, SystemPromptTemplate>> = principalOps.empty();

  // Per-user MagickMind configuration (mindspace, brain mode).
  // When a user sends a prompt to MagickMind_Brain, the Gateway looks up their
  // config here to determine which mindspace and brain mode to use.
  var magickmindConfigs : Map.Map<Principal, MagickMindConfig> = principalOps.empty();

  // Per-user personas. Keyed by principal -> personaId -> Persona.
  var userPersonas : Map.Map<Principal, Map.Map<Text, Persona>> = principalOps.empty();

  // Per-persona trait configurations. Keyed by principal -> personaId -> PersonaTraits.
  var personaTraits : Map.Map<Principal, Map.Map<Text, PersonaTraits>> = principalOps.empty();

  // Per-user group chats. Keyed by principal -> groupId -> GroupChat.
  var userGroupChats : Map.Map<Principal, Map.Map<Text, GroupChat>> = principalOps.empty();
  let MAX_GROUP_CHATS_PER_USER : Nat = 20;
  let MAX_PERSONAS_PER_GROUP : Nat = 5;

  // ── Persona Marketplace State ───────────────────────────────────
  // Global marketplace index: personaId -> PublishedPersona
  var marketplace : Map.Map<Text, Types.PublishedPersona> = textOps.empty();
  // Active hires: "hirerPrincipal:personaId" -> PersonaHire
  var activeHires : Map.Map<Text, Types.PersonaHire> = textOps.empty();
  // Persona earnings: personaId -> accumulated e8s
  var personaEarnings : Map.Map<Text, Nat> = textOps.empty();
  // NFT metadata: personaId -> PersonaNftMetadata
  var personaNfts : Map.Map<Text, Types.PersonaNftMetadata> = textOps.empty();
  var nftTokenCounter : Nat = 0;
  // Rating dedup tracker: "hirerPrincipal:personaId" -> has rated
  var ratingTracker : Map.Map<Text, Bool> = textOps.empty();

  // Built-in system prompt templates returned alongside user templates.
  let BUILT_IN_TEMPLATES : [SystemPromptTemplate] = [
    { id = "builtin_code"; name = "Code Assistant"; content = "You are an expert software engineer. Write clean, efficient, well-documented code. Explain your reasoning. When asked to debug, identify the root cause before suggesting fixes."; isBuiltIn = true; createdAt = 0 },
    { id = "builtin_writer"; name = "Creative Writer"; content = "You are a creative writing assistant. Help with storytelling, poetry, scripts, and creative content. Use vivid language and varied sentence structure. Match the user's desired tone and style."; isBuiltIn = true; createdAt = 0 },
    { id = "builtin_analyst"; name = "Research Analyst"; content = "You are a research analyst. Provide thorough, well-sourced analysis. Present multiple perspectives on complex topics. Distinguish between established facts and interpretations. Cite specific data when available."; isBuiltIn = true; createdAt = 0 },
    { id = "builtin_tutor"; name = "Tutor"; content = "You are a patient, encouraging tutor. Break down complex concepts into simple steps. Use analogies and examples. Ask clarifying questions to gauge understanding. Adapt your explanations to the student's level."; isBuiltIn = true; createdAt = 0 },
    { id = "builtin_translator"; name = "Translator"; content = "You are a professional translator. Translate accurately while preserving tone, idioms, and cultural context. If a phrase has no direct equivalent, explain the nuance. Always specify source and target languages."; isBuiltIn = true; createdAt = 0 },
  ];

  let BUILT_IN_PERSONAS : [Persona] = [
    {
      id = "persona_coder"; name = "Code Architect"; avatar = "👨‍💻";
      description = "Senior full-stack engineer with deep systems knowledge";
      personality = "Precise, thorough, and pragmatic. Values clean code, proper abstractions, and battle-tested patterns. Explains trade-offs clearly.";
      tone = "Technical but approachable. Uses code examples liberally.";
      expertise = ["System design", "TypeScript", "Rust", "Motoko", "ICP", "Web3"];
      instructions = "Always explain WHY, not just HOW. Suggest tests. Flag potential security issues. Prefer simple solutions over clever ones.";
      isBuiltIn = true; createdAt = 0; updatedAt = 0;
    },
    {
      id = "persona_researcher"; name = "Research Analyst"; avatar = "🔬";
      description = "Meticulous researcher who synthesizes complex information";
      personality = "Analytical, evidence-driven, and intellectually curious. Weighs multiple perspectives before reaching conclusions.";
      tone = "Academic yet accessible. Cites sources and distinguishes fact from interpretation.";
      expertise = ["Research methodology", "Data analysis", "Critical thinking", "Synthesis"];
      instructions = "Structure responses with clear sections. Highlight confidence levels. Acknowledge knowledge gaps honestly. Provide counterarguments.";
      isBuiltIn = true; createdAt = 0; updatedAt = 0;
    },
    {
      id = "persona_creative"; name = "Creative Muse"; avatar = "🎨";
      description = "Imaginative creative partner for writing and ideation";
      personality = "Playful, expressive, and uninhibited. Thinks in metaphors and unexpected connections. Loves wordplay.";
      tone = "Warm, enthusiastic, and vivid. Adapts writing style to match the project.";
      expertise = ["Creative writing", "Storytelling", "Brainstorming", "Poetry", "Worldbuilding"];
      instructions = "Generate multiple options when asked. Push creative boundaries. Use sensory details. Ask probing questions to understand the creative vision.";
      isBuiltIn = true; createdAt = 0; updatedAt = 0;
    },
    {
      id = "persona_strategist"; name = "Business Strategist"; avatar = "📊";
      description = "Sharp strategic thinker for business and product decisions";
      personality = "Strategic, data-informed, and action-oriented. Frames problems in terms of impact, risk, and opportunity cost.";
      tone = "Confident and direct. Uses frameworks and structured thinking.";
      expertise = ["Strategy", "Product management", "Market analysis", "Decision-making", "Growth"];
      instructions = "Use frameworks (SWOT, Porter's, Jobs-to-be-Done) when relevant. Quantify when possible. Always end with actionable next steps.";
      isBuiltIn = true; createdAt = 0; updatedAt = 0;
    },
    {
      id = "persona_mentor"; name = "Life Coach"; avatar = "🌟";
      description = "Empathetic guide for personal growth and reflection";
      personality = "Compassionate, patient, and insightful. Creates safe space for exploration. Believes in human potential.";
      tone = "Warm, encouraging, and thoughtful. Uses open-ended questions.";
      expertise = ["Self-improvement", "Goal setting", "Emotional intelligence", "Mindfulness", "Communication"];
      instructions = "Ask reflective questions before giving advice. Validate feelings. Help break big goals into small steps. Celebrate progress.";
      isBuiltIn = true; createdAt = 0; updatedAt = 0;
    },
  ];

  // Helper to create a standard numeric trait with common defaults.
  func makeNumericTrait(name : Text, displayName : Text, value : Nat, desc : Text, cat : Text, rate : Nat) : PersonaTrait {
    { name = name; displayName = displayName; traitType = #Numeric; description = desc; numericValue = ?value; categoricalValue = null; multilabelValue = []; options = []; minValue = 0; maxValue = 100; defaultValue = value; lock = #Soft; learningRate = rate; supportsDyadic = true; category = cat };
  };

  // Default trait values for user-created personas.
  let DEFAULT_TRAITS : [PersonaTrait] = [
    { name = "creativity"; displayName = "Creativity"; traitType = #Numeric; description = "How creative and unconventional the responses are"; numericValue = ?50; categoricalValue = null; multilabelValue = []; options = []; minValue = 0; maxValue = 100; defaultValue = 50; lock = #Soft; learningRate = 30; supportsDyadic = true; category = "personality" },
    { name = "formality"; displayName = "Formality"; traitType = #Numeric; description = "Formal/professional vs casual/friendly tone"; numericValue = ?50; categoricalValue = null; multilabelValue = []; options = []; minValue = 0; maxValue = 100; defaultValue = 50; lock = #Soft; learningRate = 20; supportsDyadic = true; category = "communication" },
    { name = "humor"; displayName = "Humor"; traitType = #Numeric; description = "How much humor and wit to include"; numericValue = ?30; categoricalValue = null; multilabelValue = []; options = []; minValue = 0; maxValue = 100; defaultValue = 30; lock = #Soft; learningRate = 25; supportsDyadic = true; category = "personality" },
    { name = "detail"; displayName = "Detail Level"; traitType = #Numeric; description = "Level of detail and thoroughness in responses"; numericValue = ?60; categoricalValue = null; multilabelValue = []; options = []; minValue = 0; maxValue = 100; defaultValue = 60; lock = #Soft; learningRate = 15; supportsDyadic = false; category = "behavior" },
    { name = "empathy"; displayName = "Empathy"; traitType = #Numeric; description = "Emotional awareness and supportive language"; numericValue = ?50; categoricalValue = null; multilabelValue = []; options = []; minValue = 0; maxValue = 100; defaultValue = 50; lock = #Soft; learningRate = 30; supportsDyadic = true; category = "personality" },
    { name = "directness"; displayName = "Directness"; traitType = #Numeric; description = "Concise and to-the-point vs exploratory"; numericValue = ?50; categoricalValue = null; multilabelValue = []; options = []; minValue = 0; maxValue = 100; defaultValue = 50; lock = #Soft; learningRate = 20; supportsDyadic = false; category = "communication" },
    { name = "technical"; displayName = "Technical Depth"; traitType = #Numeric; description = "Technical depth and jargon usage"; numericValue = ?40; categoricalValue = null; multilabelValue = []; options = []; minValue = 0; maxValue = 100; defaultValue = 40; lock = #Soft; learningRate = 15; supportsDyadic = false; category = "behavior" },
    { name = "curiosity"; displayName = "Curiosity"; traitType = #Numeric; description = "How much the persona asks follow-up questions"; numericValue = ?50; categoricalValue = null; multilabelValue = []; options = []; minValue = 0; maxValue = 100; defaultValue = 50; lock = #Soft; learningRate = 20; supportsDyadic = true; category = "personality" },
  ];

  let DEFAULT_GROWTH_CONFIG : Types.GrowthConfig = {
    growthType = #Expanding;
    domainRates = { identity = 30; narrative = 20; behavior = 40 };
    triggers = [];
    goalStates = [];
    boundaries = [];
  };

  // Rate limit for trait evolution: 5 minutes in nanoseconds.
  let EVOLUTION_COOLDOWN_NS : Int = 300_000_000_000;
  let MAX_EVOLUTION_HISTORY : Nat = 50;

  // Pay-per-request fee for external LLM calls (in e8s for ICP).
  // Default 10_000 e8s = 0.0001 ICP. Adjustable by admin via setRequestFee.
  // This serves as the fallback fee when no per-model fee is configured.
  var externalRequestFee : Nat = 10_000; // 0.0001 ICP default

  // Per-model fee overrides (in e8s). Keyed by model name string (e.g.
  // "Claude_Sonnet", "GPT4o"). When a key is present, its value is used
  // instead of externalRequestFee. On-chain models always cost 0.
  var modelFees : Map.Map<Text, Nat> = textOps.empty();

  // Admin is the deployer — immutable after construction. Used by all admin
  // endpoints (setKeyVault, setWallet, setIdentity, setRequestFee).
  let admin : Principal = deployer;

  // ── Transient state ───────────────────────────────────────────
  // The CallerGuard is transient because it holds an in-memory map of
  // currently-in-flight callers. After an upgrade all guards are released,
  // which is the safe default (no operations are in flight after upgrade).
  transient let guard = Auth.CallerGuard();

  // ── Helper functions ──────────────────────────────────────────

  // Generate a unique conversation ID by incrementing the nonce counter.
  // IDs are simple stringified natural numbers ("1", "2", ...).
  func generateId() : Text {
    nonceCounter += 1;
    Nat.toText(nonceCounter);
  };

  // Generate a unique idempotency key for HTTPS outcalls.
  // The "openclaw-gw-" prefix makes keys easily identifiable in provider logs.
  // Idempotency keys protect against duplicate charges if a replica retries
  // the same HTTPS outcall (all 13 subnet nodes make the call independently).
  func generateIdempotencyKey() : Text {
    nonceCounter += 1;
    "openclaw-gw-" # Nat.toText(nonceCounter);
  };

  // Look up the caller's conversation map, returning an empty map if the
  // caller has no conversations yet. This avoids null checks at every call site.
  func getOrCreateUserMap(caller : Principal) : Map.Map<Text, Conversation> {
    switch (principalOps.get(userConversations, caller)) {
      case (?convMap) { convMap };
      case null { textOps.empty() };
    };
  };

  // Gate a function to admin-only access. Returns #err(#NotAuthenticated)
  // if the caller is not the deployer principal.
  func requireAdmin(caller : Principal) : Result.Result<(), OpenClawError> {
    if (caller != admin) {
      #err(#NotAuthenticated);
    } else {
      #ok(());
    };
  };

  // ── Text helpers ──────────────────────────────────────────────

  /// Truncate a text value to `maxLen` characters, appending "..." if truncated.
  func truncateText(text : Text, maxLen : Nat) : Text {
    var count = 0;
    var result = "";
    for (c in text.chars()) {
      if (count >= maxLen) { return result # "..." };
      result #= Text.fromChar(c);
      count += 1;
    };
    result;
  };

  /// Convert text to lowercase for case-insensitive comparison.
  /// Motoko's Char module doesn't have toLower, so we handle A-Z manually.
  func toLower(text : Text) : Text {
    Text.map(text, func(c : Char) : Char {
      let n = Char.toNat32(c);
      if (n >= 0x41 and n <= 0x5A) { Char.fromNat32(n + 32) } else { c };
    });
  };

  /// Extract title from a conversation: first user message, truncated to 60 chars.
  func extractTitle(messages : [Message]) : Text {
    switch (Array.find<Message>(messages, func(m) { m.role == #user })) {
      case (?m) { truncateText(m.content, 60) };
      case null { "New conversation" };
    };
  };

  /// Extract preview from a conversation: last assistant message, truncated to 100 chars.
  func extractPreview(messages : [Message]) : Text {
    // Iterate in reverse to find the last assistant message
    let size = messages.size();
    var i = size;
    while (i > 0) {
      i -= 1;
      if (messages[i].role == #assistant) {
        return truncateText(messages[i].content, 100);
      };
    };
    "";
  };

  // ── Per-model fee lookup ──────────────────────────────────────

  /// Return the fee (in e8s) for a given model. On-chain models are always
  /// free. External models check the per-model override map first, then
  /// fall back to the global `externalRequestFee`.
  func getModelFee(model : Types.Model) : Nat {
    switch (model) {
      case (#OnChain(_)) { 0 }; // On-chain inference is free (cycles only)
      case (#External(ext)) {
        let key = switch (ext) {
          case (#Claude_Sonnet) { "Claude_Sonnet" };
          case (#Claude_Haiku) { "Claude_Haiku" };
          case (#GPT4o) { "GPT4o" };
          case (#GPT4oMini) { "GPT4oMini" };
          case (#MagickMind_Brain) { "MagickMind_Brain" };
        };
        switch (textOps.get(modelFees, key)) {
          case (?fee) { fee };
          case null { externalRequestFee }; // fallback to global default
        };
      };
    };
  };

  // ── Transform function for HTTPS outcall consensus ────────────

  /// Transform callback required by ICP HTTPS outcalls for consensus.
  ///
  /// On ICP, HTTPS outcalls are made by all 13 nodes in the subnet independently.
  /// Each node may receive slightly different HTTP response headers (e.g. Date,
  /// Set-Cookie, request IDs). The nodes must reach consensus on the response, so
  /// a transform function strips non-deterministic parts. Here we keep only the
  /// status code and body (which are deterministic for well-behaved APIs) and
  /// discard all headers. The `context` blob is unused but required by the
  /// interface. This function is passed as a reference to LlmRouter/HttpOutcalls
  /// so the management canister can call it back during the outcall.
  public shared query func transform({
    context : Blob;
    response : IC.HttpRequestResult;
  }) : async IC.HttpRequestResult {
    ignore context;
    {
      status = response.status;
      headers = []; // Strip all headers for deterministic consensus
      body = response.body;
    };
  };

  // ── Admin API ─────────────────────────────────────────────────
  // These functions configure inter-canister wiring. They must be called by
  // the deployer (admin) after initial deployment, typically via a post-deploy
  // script. Without these, features like payment, API key retrieval, and
  // identity tracking are silently skipped (graceful degradation for local dev).

  /// Register the KeyVault canister so the Gateway can fetch encrypted API keys
  /// on behalf of users. Must be called once after deploying both canisters.
  public shared (msg) func setKeyVault(kvPrincipal : Principal) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    keyVaultPrincipal := ?kvPrincipal;
    #ok(());
  };

  /// Register the Wallet canister for pay-per-request fee deductions and refunds.
  /// Without this, external LLM calls skip the payment step (useful for local dev).
  public shared (msg) func setWallet(wp : Principal) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    walletPrincipal := ?wp;
    #ok(());
  };

  /// Register the Identity canister for prompt-count tracking.
  /// Without this, prompt counts are simply not incremented.
  public shared (msg) func setIdentity(ip : Principal) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    identityPrincipal := ?ip;
    #ok(());
  };

  /// Set the global default fee (in e8s) charged per external LLM request.
  /// For example, 10_000 e8s = 0.0001 ICP. Set to 0 to disable fees.
  /// Per-model overrides (via setModelFee) take precedence over this default.
  /// Only the admin can change this to prevent abuse.
  public shared (msg) func setRequestFee(fee : Nat) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    externalRequestFee := fee;
    #ok(());
  };

  /// Set a per-model fee override (in e8s). The `modelKey` must match the
  /// model variant name exactly: "Claude_Sonnet", "Claude_Haiku", "GPT4o",
  /// "GPT4oMini", or "MagickMind_Brain". Set to 0 to make a model free.
  /// To remove an override and fall back to the global default, use
  /// removeModelFee instead.
  public shared (msg) func setModelFee(modelKey : Text, fee : Nat) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    modelFees := textOps.put(modelFees, modelKey, fee);
    #ok(());
  };

  /// Remove a per-model fee override so the model falls back to the global
  /// default externalRequestFee.
  public shared (msg) func removeModelFee(modelKey : Text) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    modelFees := textOps.delete(modelFees, modelKey);
    #ok(());
  };

  /// Query all configured per-model fee overrides. Returns an array of
  /// (modelKey, fee) tuples. Models not listed here use the global default.
  public query func getModelFees() : async [(Text, Nat)] {
    let buf = Buffer.Buffer<(Text, Nat)>(0);
    for ((key, fee) in textOps.entries(modelFees)) {
      buf.add((key, fee));
    };
    Buffer.toArray(buf);
  };

  // ── KeyVault Integration ──────────────────────────────────────

  // Retrieve an API key from the KeyVault canister for the given user and key ID.
  // The KeyVault stores AES-GCM encrypted blobs; here we call getEncryptedKey
  // which is a gateway-only endpoint that returns the raw blob. We then decode
  // it as UTF-8 text (the plaintext API key). If the KeyVault is not configured
  // (local dev), this returns an error so the caller can either fail fast or
  // fall back to an API key provided directly in the request.
  func getApiKey(userPrincipal : Principal, keyId : Text) : async Result.Result<Text, OpenClawError> {
    switch (keyVaultPrincipal) {
      case null { #err(#ApiKeyNotFound("KeyVault not configured")) };
      case (?kvp) {
        let kv : actor {
          getEncryptedKey : (Principal, Text) -> async Result.Result<Blob, Text>;
        } = actor (Principal.toText(kvp));

        try {
          let result = await kv.getEncryptedKey(userPrincipal, keyId);
          switch (result) {
            case (#ok(blob)) {
              switch (Text.decodeUtf8(blob)) {
                case (?key) { #ok(key) };
                case null { #err(#ApiKeyNotFound("Stored key is not valid UTF-8")) };
              };
            };
            case (#err(e)) { #err(#ApiKeyNotFound(e)) };
          };
        } catch (_) {
          #err(#ApiKeyNotFound("Failed to reach KeyVault canister"));
        };
      };
    };
  };

  // ── Public API ────────────────────────────────────────────────

  /// Send a prompt to an LLM and get a response.
  ///
  /// This is the main entry-point for the OpenClaw platform. It orchestrates
  /// a 9-step flow:
  ///
  ///   1. **Auth check** — reject anonymous principals.
  ///   2. **Reentrancy guard** — prevent duplicate in-flight calls per user.
  ///   3. **Conversation resolution** — reuse an existing conversation or create
  ///      a new one. Enforces MAX_CONVERSATIONS_PER_USER and
  ///      MAX_MESSAGES_PER_CONVERSATION limits.
  ///   4. **Message assembly** — build the full message array from conversation
  ///      history + optional system prompt + new user message.
  ///   5. **API key & payment** — for external models only:
  ///      a. Resolve the API key (from request or KeyVault) *before* deducting
  ///         payment, so we never charge for a missing key.
  ///      b. Deduct the pay-per-request fee from the Wallet canister using the
  ///         **saga pattern**: debit happens before the LLM await so the user
  ///         cannot double-spend by issuing concurrent calls.
  ///   6. **LLM routing** — delegate to LlmRouter (on-chain or HTTPS outcall).
  ///      On failure, trigger a **compensating refund** to reverse step 5b.
  ///   7. **Save assistant reply** — append the LLM response to the message buffer.
  ///   8. **Increment prompt count** — best-effort call to Identity canister.
  ///      Failures are silently ignored so they never block the user.
  ///   9. **Persist conversation** — write the updated conversation back to the
  ///      persistent map.
  ///
  /// The `try/finally` block guarantees the CallerGuard is released even if any
  /// step throws, preventing a user from getting permanently locked out.
  public shared (msg) func prompt(req : PromptRequest) : async Result.Result<PromptResponse, OpenClawError> {
    // Step 1: Auth check — anonymous principals cannot use the platform.
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Step 2: Reentrancy guard — only one in-flight prompt() per caller.
    // On ICP, inter-canister awaits yield control, so a malicious or buggy
    // client could call prompt() again before the first call completes.
    // The guard prevents this by tracking in-flight callers.
    switch (guard.acquire(msg.caller)) {
      case (#err(_)) { return #err(#AlreadyProcessing) };
      case (#ok(())) {};
    };

    // Guard MUST be released in all paths — use try/finally
    try {
      // Step 3: Resolve or create conversation.
      // If the request includes a conversationId, reuse it; otherwise mint a
      // new one. This lets the frontend maintain multi-turn conversations.
      let convId = switch (req.conversationId) {
        case (?id) { id };
        case null { generateId() };
      };

      let userMap = getOrCreateUserMap(msg.caller);
      let now = Time.now();

      // Enforce per-user conversation limit (only checked for new conversations)
      switch (textOps.get(userMap, convId)) {
        case null {
          if (textOps.size(userMap) >= MAX_CONVERSATIONS_PER_USER) {
            return #err(#InvalidInput("Too many conversations: max " # debug_show(MAX_CONVERSATIONS_PER_USER)));
          };
        };
        case _ {};
      };

      // Load existing messages (if continuing a conversation) and verify ownership.
      let existingConv : ?Conversation = textOps.get(userMap, convId);
      let (existingMessages, isNew) = switch (existingConv) {
        case (?conv) {
          if (conv.owner != msg.caller) {
            return #err(#ConversationNotFound);
          };
          // Enforce per-conversation message limit to bound memory usage
          if (conv.messages.size() >= MAX_MESSAGES_PER_CONVERSATION) {
            return #err(#InvalidInput("Conversation too long: max " # debug_show(MAX_MESSAGES_PER_CONVERSATION) # " messages"));
          };
          (conv.messages, false);
        };
        case null { ([], true) };
      };

      // Resolve mindspaceId with priority:
      //   1. req.mindspaceId (frontend explicitly set it)
      //   2. Existing conversation's mindspaceId (continuing a conversation)
      //   3. User's default from magickmindConfigs map
      //   4. "default" as final fallback
      let resolvedMindspaceId : ?Text = switch (req.model) {
        case (#External(#MagickMind_Brain)) {
          let msId = switch (req.mindspaceId) {
            case (?id) { id };
            case null {
              switch (existingConv) {
                case (?conv) {
                  switch (conv.mindspaceId) {
                    case (?id) { id };
                    case null {
                      switch (principalOps.get(magickmindConfigs, msg.caller)) {
                        case (?cfg) { cfg.mindspaceId };
                        case null { "default" };
                      };
                    };
                  };
                };
                case null {
                  switch (principalOps.get(magickmindConfigs, msg.caller)) {
                    case (?cfg) { cfg.mindspaceId };
                    case null { "default" };
                  };
                };
              };
            };
          };
          ?msId;
        };
        case _ { null }; // Non-MagickMind models don't use mindspaces
      };

      // Step 4: Build the full message list to send to the LLM.
      // History comes first, then an optional system prompt (only on new
      // conversations — adding it again would confuse multi-turn context),
      // then the user's new message.
      let messagesBuf = Buffer.fromArray<Message>(existingMessages);

      switch (req.systemPrompt) {
        case (?sp) {
          if (isNew) {
            messagesBuf.add({ role = #system_; content = sp });
          };
        };
        case null {};
      };

      messagesBuf.add({ role = #user; content = req.message });

      // Step 5: Capture caller principal before any await.
      // On ICP, msg.caller is only valid in the synchronous prefix of a shared
      // function. After an await, msg.caller could theoretically be spoofed in
      // future runtime versions. Binding it to a local `let` is defensive.
      let caller = msg.caller;
      let allMessages = Buffer.toArray(messagesBuf);
      let idempotencyKey = generateIdempotencyKey();

      // Determine if this is an external model (requires payment)
      let isExternal = switch (req.model) { case (#External(_)) true; case _ false };

      // Step 5a: For external models, resolve the API key FIRST.
      // We do this before deducting payment so we never charge for a request
      // that will immediately fail due to a missing key.
      var resolvedApiKey : ?Text = null;
      switch (req.model) {
        case (#External(externalModel)) {
          let apiKey = switch (req.apiKey) {
            case (?key) { key }; // Client-provided key (e.g. for testing)
            case null {
              // Look up the key ID for the provider (e.g. "anthropic_api_key")
              let keyId = LlmRouter.providerKeyId(externalModel);
              let apiKeyResult = await getApiKey(caller, keyId);
              switch (apiKeyResult) {
                case (#err(e)) { return #err(e) }; // fail BEFORE payment
                case (#ok(k)) { k };
              };
            };
          };
          resolvedApiKey := ?apiKey;
        };
        case _ {};
      };

      // Step 5b: Deduct payment for external models (SAGA pattern).
      // We debit the user's wallet balance BEFORE the LLM await. If the LLM
      // call fails later, we issue a compensating refund (see step 6 error
      // handling below). This prevents double-spending: the balance is already
      // decremented, so a concurrent call would see the reduced balance.
      // The fee is model-specific: getModelFee checks per-model overrides
      // first, then falls back to the global externalRequestFee.
      var paymentDeducted = false;
      let requestFee = getModelFee(req.model);
      if (isExternal and requestFee > 0) {
        switch (walletPrincipal) {
          case null {}; // wallet not configured — skip payment (local dev)
          case (?wp) {
            let walletActor : actor {
              deductForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
            } = actor (Principal.toText(wp));
            let deductResult = await walletActor.deductForRequest(caller, #ICP, requestFee);
            switch (deductResult) {
              case (#err(_)) { return #err(#InsufficientBalance) };
              case (#ok(())) { paymentDeducted := true };
            };
          };
        };
      };

      // Step 6: Route to the LLM (on-chain DFINITY LLM or external HTTPS outcall).
      let routeResult = switch (req.model) {
        case (#OnChain(onChainModel)) {
          await LlmRouter.routeOnChain(onChainModel, allMessages);
        };
        case (#External(externalModel)) {
          let apiKey = switch (resolvedApiKey) {
            case (?k) { k };
            case null { return #err(#ApiKeyNotFound("No API key resolved")) };
          };
          // Build MagickMind config using the resolved per-conversation mindspaceId.
          // For brain mode, use the user's saved config or default to #Fast.
          let mmConfig : ?MagickMindConfig = switch (resolvedMindspaceId) {
            case (?msId) {
              let brainMode = switch (principalOps.get(magickmindConfigs, caller)) {
                case (?cfg) { cfg.brainMode };
                case null { #Fast };
              };
              let userCfg = principalOps.get(magickmindConfigs, caller);
              let fastModel = switch (userCfg) { case (?c) { c.fastModelId }; case null { "gpt-4o-mini" } };
              let smartModels = switch (userCfg) { case (?c) { c.smartModelIds }; case null { ["claude-sonnet-4"] : [Text] } };
              let compute = switch (userCfg) { case (?c) { c.computePower }; case null { 50 } };
              ?{ mindspaceId = msId; brainMode = brainMode; fastModelId = fastModel; smartModelIds = smartModels; computePower = compute };
            };
            case null { null };
          };
          await LlmRouter.routeExternal(
            externalModel,
            allMessages,
            apiKey,
            idempotencyKey,
            Principal.toText(caller),
            transform,
            convId,
            mmConfig,
          );
        };
      };

      let reply = switch (routeResult) {
        case (#ok(text)) { text };
        case (#err(e)) {
          // SAGA COMPENSATION: refund on LLM failure if we already deducted.
          // This is a best-effort refund — if the refund call itself fails,
          // we log nothing (no persistent logging on ICP) but the user can
          // contact support. The alternative (not deducting upfront) would
          // allow double-spending.
          if (paymentDeducted) {
            switch (walletPrincipal) {
              case (?wp) {
                let walletActor : actor {
                  refundForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
                } = actor (Principal.toText(wp));
                try { ignore await walletActor.refundForRequest(caller, #ICP, requestFee) }
                catch (_) {}; // best-effort refund
              };
              case null {};
            };
          };
          return #err(e);
        };
      };

      // Step 7: Append the assistant's reply to the conversation buffer.
      messagesBuf.add({ role = #assistant; content = reply });

      // Step 7b: Fire-and-forget trait evolution for MagickMind_Brain personas.
      // If the conversation has an active persona with evolution enabled,
      // build a summary from the last few messages and evolve traits.
      switch (req.model) {
        case (#External(#MagickMind_Brain)) {
          // Check if the system prompt matches a known persona by looking for
          // a persona-style system prompt in the conversation.
          // Scan system messages for persona names.
          var personaId : ?Text = null;
          label findPersonaId {
            // Look for a system_ message that starts with "You are "
            let sysMsg = switch (Array.find<Message>(allMessages, func(m) {
              m.role == #system_ and Text.contains(m.content, #text "You are ")
            })) {
              case (?m) { m };
              case null { break findPersonaId };
            };

            // Try to match against built-in personas
            for (bp in BUILT_IN_PERSONAS.vals()) {
              let bpName = bp.name;
              if (Text.contains(sysMsg.content, #text bpName)) {
                personaId := ?bp.id;
              };
            };
            // Also check user personas if no built-in matched
            switch (personaId) {
              case (?_) {};
              case null {
                switch (principalOps.get(userPersonas, caller)) {
                  case (?uMap) {
                    for ((_, p) in textOps.entries(uMap)) {
                      let pName = p.name;
                      if (Text.contains(sysMsg.content, #text pName)) {
                        personaId := ?p.id;
                      };
                    };
                  };
                  case null {};
                };
              };
            };
          };

          switch (personaId) {
            case (?pid) {
              // Check if evolution is enabled for this persona (growthType != #Fixed)
              let hasEvolution = switch (principalOps.get(personaTraits, caller)) {
                case (?traitsMap) {
                  switch (textOps.get(traitsMap, pid)) {
                    case (?t) { t.growthConfig.growthType != #Fixed };
                    case null { false };
                  };
                };
                case null { false };
              };

              if (hasEvolution) {
                // Build summary from last 3 messages (truncated to 200 chars each)
                let msgArray = Buffer.toArray(messagesBuf);
                let summaryBuf = Buffer.Buffer<Text>(3);
                let total = msgArray.size();
                var count = 0;
                var idx = total;
                while (idx > 0 and count < 3) {
                  idx -= 1;
                  summaryBuf.add(truncateText(msgArray[idx].content, 200));
                  count += 1;
                };
                var summary = "";
                for (s in summaryBuf.vals()) {
                  summary #= s # " ";
                };

                // Fire-and-forget: call evolvePersonaTraits internally
                // We do this by directly applying the evolution logic inline,
                // since we can't call our own public methods from within the actor.
                let lowerSummary = toLower(summary);
                let evolveNow = Time.now();

                switch (principalOps.get(personaTraits, caller)) {
                  case (?traitsMap) {
                    switch (textOps.get(traitsMap, pid)) {
                      case (?existing) {
                        if (existing.growthConfig.growthType != #Fixed and (evolveNow - existing.lastEvolvedAt >= EVOLUTION_COOLDOWN_NS)) {
                          let traitBuf2 = Buffer.Buffer<PersonaTrait>(existing.traits.size());
                          for (trait in existing.traits.vals()) {
                            // Only evolve numeric, soft-locked traits
                            if (trait.traitType != #Numeric or trait.lock == #Hard) {
                              traitBuf2.add(trait);
                            } else {
                              let currentVal = switch (trait.numericValue) {
                                case (?v) { v };
                                case null { trait.defaultValue };
                              };
                              let lowerName = toLower(trait.name);
                              var adj : Int = 0;
                              var trig = false;

                              if (lowerName == "creativity") {
                                if (Text.contains(lowerSummary, #text "creative") or Text.contains(lowerSummary, #text "imaginative") or Text.contains(lowerSummary, #text "novel")) { adj := 3; trig := true };
                              } else if (lowerName == "formality") {
                                if (Text.contains(lowerSummary, #text "formal") or Text.contains(lowerSummary, #text "professional")) { adj := 2; trig := true };
                              } else if (lowerName == "humor") {
                                if (Text.contains(lowerSummary, #text "funny") or Text.contains(lowerSummary, #text "humorous") or Text.contains(lowerSummary, #text "joke")) { adj := 3; trig := true };
                              } else if (lowerName == "detail") {
                                if (Text.contains(lowerSummary, #text "detailed") or Text.contains(lowerSummary, #text "thorough") or Text.contains(lowerSummary, #text "comprehensive")) { adj := 2; trig := true };
                              } else if (lowerName == "empathy") {
                                if (Text.contains(lowerSummary, #text "empathetic") or Text.contains(lowerSummary, #text "supportive") or Text.contains(lowerSummary, #text "caring")) { adj := 3; trig := true };
                              } else if (lowerName == "directness") {
                                if (Text.contains(lowerSummary, #text "direct") or Text.contains(lowerSummary, #text "concise") or Text.contains(lowerSummary, #text "brief")) { adj := 3; trig := true };
                              } else if (lowerName == "technical") {
                                if (Text.contains(lowerSummary, #text "technical") or Text.contains(lowerSummary, #text "code") or Text.contains(lowerSummary, #text "engineering")) { adj := 2; trig := true };
                              } else if (lowerName == "curiosity") {
                                if (Text.contains(lowerSummary, #text "question") or Text.contains(lowerSummary, #text "curious") or Text.contains(lowerSummary, #text "why")) { adj := 2; trig := true };
                              };

                              if (not trig) {
                                let cv : Int = currentVal;
                                if (cv > 50) { adj := -1 }
                                else if (cv < 50) { adj := 1 };
                              };

                              let newValue = adjustTraitClamped(currentVal, adj, trait.minValue, trait.maxValue);
                              traitBuf2.add({ name = trait.name; displayName = trait.displayName; traitType = trait.traitType; description = trait.description; numericValue = ?newValue; categoricalValue = trait.categoricalValue; multilabelValue = trait.multilabelValue; options = trait.options; minValue = trait.minValue; maxValue = trait.maxValue; defaultValue = trait.defaultValue; lock = trait.lock; learningRate = trait.learningRate; supportsDyadic = trait.supportsDyadic; category = trait.category });
                            };
                          };

                          let evolved = Buffer.toArray(traitBuf2);
                          let snap : TraitSnapshot = { traits = evolved; timestamp = evolveNow; trigger = "auto-evolution" };
                          let hBuf = Buffer.Buffer<TraitSnapshot>(0);
                          for (h in existing.evolutionHistory.vals()) { hBuf.add(h) };
                          hBuf.add(snap);
                          let hArr = if (hBuf.size() > MAX_EVOLUTION_HISTORY) {
                            let full = Buffer.toArray(hBuf);
                            let drop = full.size() - MAX_EVOLUTION_HISTORY;
                            Array.tabulate<TraitSnapshot>(MAX_EVOLUTION_HISTORY, func(i) { full[i + drop] });
                          } else { Buffer.toArray(hBuf) };

                          let updatedTraits : PersonaTraits = {
                            personaId = pid;
                            traits = evolved;
                            growthConfig = existing.growthConfig;
                            multiLlmConfig = existing.multiLlmConfig;
                            evolutionHistory = hArr;
                            lastEvolvedAt = evolveNow;
                          };
                          let updMap = textOps.put(traitsMap, pid, updatedTraits);
                          personaTraits := principalOps.put(personaTraits, caller, updMap);
                        };
                      };
                      case null {};
                    };
                  };
                  case null {};
                };
              };
            };
            case null {};
          };
        };
        case _ {};
      };

      // Step 8: Increment prompt count on the Identity canister.
      // This is fire-and-forget: we await it for ordering but ignore failures
      // so that a broken Identity canister never blocks prompt responses.
      switch (identityPrincipal) {
        case null {};
        case (?ip) {
          let identityActor : actor {
            incrementPromptCount : (Principal) -> async ();
          } = actor (Principal.toText(ip));
          try { await identityActor.incrementPromptCount(caller) } catch (_) {};
        };
      };

      // Step 9: Persist the updated conversation to stable storage.
      let updatedConv : Conversation = {
        id = convId;
        owner = msg.caller;
        model = req.model;
        messages = Buffer.toArray(messagesBuf);
        createdAt = if (isNew) { now } else {
          switch (existingConv) {
            case (?c) { c.createdAt };
            case null { now };
          };
        };
        updatedAt = now;
        mindspaceId = resolvedMindspaceId;
      };

      let updatedUserMap = textOps.put(userMap, convId, updatedConv);
      userConversations := principalOps.put(userConversations, msg.caller, updatedUserMap);

      #ok({
        conversationId = convId;
        reply = reply;
        model = req.model;
        tokensUsed = null; // Token counting not yet implemented
        mindspaceId = resolvedMindspaceId;
      });
    } catch (_) {
      #err(#ProviderError("Internal error"));
    } finally {
      // ALWAYS release the reentrancy guard, even on unexpected exceptions.
      guard.release(msg.caller);
    };
  };

  /// Retrieve a specific conversation by ID. Returns the full conversation
  /// including all messages. Only the conversation owner can access it.
  /// This is a query call (fast, no consensus needed, no state mutation).
  public shared query (msg) func getConversation(convId : ConversationId) : async Result.Result<Conversation, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    let userMap = getOrCreateUserMap(msg.caller);
    switch (textOps.get(userMap, convId)) {
      case (?conv) {
        if (conv.owner != msg.caller) {
          #err(#ConversationNotFound);
        } else {
          #ok(conv);
        };
      };
      case null { #err(#ConversationNotFound) };
    };
  };

  /// List all conversations for the authenticated caller.
  /// Returns lightweight summaries (id, model, updatedAt, messageCount) rather
  /// than full message arrays, keeping the response small for UI listing.
  public shared query (msg) func listConversations() : async Result.Result<[ConversationSummary], OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    let userMap = getOrCreateUserMap(msg.caller);
    let buf = Buffer.Buffer<ConversationSummary>(0);

    for ((_, conv) in textOps.entries(userMap)) {
      buf.add({
        id = conv.id;
        model = conv.model;
        updatedAt = conv.updatedAt;
        messageCount = conv.messages.size();
        title = extractTitle(conv.messages);
        preview = extractPreview(conv.messages);
        mindspaceId = conv.mindspaceId;
      });
    };

    #ok(Buffer.toArray(buf));
  };

  /// Delete a conversation permanently. Only the conversation owner can delete
  /// it. This is an update call (goes through consensus) because it mutates state.
  public shared (msg) func deleteConversation(convId : ConversationId) : async Result.Result<(), OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    let userMap = getOrCreateUserMap(msg.caller);
    switch (textOps.get(userMap, convId)) {
      case (?conv) {
        if (conv.owner != msg.caller) {
          return #err(#ConversationNotFound);
        };
        let updatedUserMap = textOps.delete(userMap, convId);
        userConversations := principalOps.put(userConversations, msg.caller, updatedUserMap);
        #ok(());
      };
      case null { #err(#ConversationNotFound) };
    };
  };

  // ── Conversation Search & Export ─────────────────────────────────

  /// Search conversations by matching message content (case-insensitive).
  /// Returns summaries of all conversations that contain the query string
  /// in any message's content.
  public shared query (msg) func searchConversations(searchQuery : Text) : async Result.Result<[ConversationSummary], OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    if (Text.size(searchQuery) == 0) {
      return #err(#InvalidInput("Search query cannot be empty"));
    };

    let userMap = getOrCreateUserMap(msg.caller);
    let buf = Buffer.Buffer<ConversationSummary>(0);
    let lowerQuery = toLower(searchQuery);

    for ((_, conv) in textOps.entries(userMap)) {
      label searchConv {
        for (m in conv.messages.vals()) {
          let lowerContent = toLower(m.content);
          if (Text.contains(lowerContent, #text lowerQuery)) {
            buf.add({
              id = conv.id;
              model = conv.model;
              updatedAt = conv.updatedAt;
              messageCount = conv.messages.size();
              title = extractTitle(conv.messages);
              preview = extractPreview(conv.messages);
              mindspaceId = conv.mindspaceId;
            });
            break searchConv;
          };
        };
      };
    };

    #ok(Buffer.toArray(buf));
  };

  /// Export a conversation in JSON or Markdown format.
  /// Returns the formatted conversation as a text string.
  public shared query (msg) func exportConversation(convId : ConversationId, format : ExportFormat) : async Result.Result<Text, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    let userMap = getOrCreateUserMap(msg.caller);
    switch (textOps.get(userMap, convId)) {
      case (?conv) {
        if (conv.owner != msg.caller) {
          return #err(#ConversationNotFound);
        };

        let modelStr = switch (conv.model) {
          case (#OnChain(#Llama3_1_8B)) { "Llama3_1_8B" };
          case (#OnChain(#Qwen3_32B)) { "Qwen3_32B" };
          case (#OnChain(#Llama4Scout)) { "Llama4Scout" };
          case (#External(#Claude_Sonnet)) { "Claude_Sonnet" };
          case (#External(#Claude_Haiku)) { "Claude_Haiku" };
          case (#External(#GPT4o)) { "GPT4o" };
          case (#External(#GPT4oMini)) { "GPT4oMini" };
          case (#External(#MagickMind_Brain)) { "MagickMind_Brain" };
        };

        switch (format) {
          case (#JSON) {
            // Build a JSON string manually
            var json = "{\n  \"id\": \"" # conv.id # "\",\n";
            json #= "  \"model\": \"" # modelStr # "\",\n";
            json #= "  \"createdAt\": " # Int.toText(conv.createdAt) # ",\n";
            json #= "  \"updatedAt\": " # Int.toText(conv.updatedAt) # ",\n";
            json #= "  \"messages\": [\n";

            var first = true;
            for (m in conv.messages.vals()) {
              if (not first) { json #= ",\n" };
              first := false;
              let roleStr = switch (m.role) {
                case (#system_) { "system" };
                case (#user) { "user" };
                case (#assistant) { "assistant" };
              };
              // Escape double quotes and backslashes in content for valid JSON
              var escaped = "";
              for (c in m.content.chars()) {
                if (c == '\"') { escaped #= "\\\"" }
                else if (c == '\\') { escaped #= "\\\\" }
                else if (c == '\n') { escaped #= "\\n" }
                else if (c == '\r') { escaped #= "\\r" }
                else if (c == '\t') { escaped #= "\\t" }
                else { escaped #= Text.fromChar(c) };
              };
              json #= "    {\"role\": \"" # roleStr # "\", \"content\": \"" # escaped # "\"}";
            };

            json #= "\n  ]\n}";
            #ok(json);
          };
          case (#Markdown) {
            var md = "# Conversation " # conv.id # "\n\n";
            md #= "**Model:** " # modelStr # "\n";
            md #= "**Created:** " # Int.toText(conv.createdAt) # "\n\n";
            md #= "---\n\n";

            for (m in conv.messages.vals()) {
              switch (m.role) {
                case (#system_) {
                  md #= "## System\n\n" # m.content # "\n\n";
                };
                case (#user) {
                  md #= "## User\n\n" # m.content # "\n\n";
                };
                case (#assistant) {
                  md #= "## Assistant\n\n" # m.content # "\n\n";
                };
              };
            };

            #ok(md);
          };
        };
      };
      case null { #err(#ConversationNotFound) };
    };
  };

  // ── System Prompt Template CRUD ─────────────────────────────────

  /// Save a new system prompt template for the authenticated caller.
  /// Generates a unique ID and stores it in the user's template map.
  /// Returns the created template on success.
  public shared (msg) func saveTemplate(name : Text, content : Text) : async Result.Result<SystemPromptTemplate, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Validate inputs
    if (Text.size(name) == 0 or Text.size(name) > MAX_TEMPLATE_NAME) {
      return #err(#InvalidInput("Template name must be 1-" # debug_show(MAX_TEMPLATE_NAME) # " characters"));
    };
    if (Text.size(content) == 0 or Text.size(content) > MAX_TEMPLATE_CONTENT) {
      return #err(#InvalidInput("Template content must be 1-" # debug_show(MAX_TEMPLATE_CONTENT) # " characters"));
    };

    // Get or create the user's template map
    let templateMap = switch (principalOps.get(userTemplates, msg.caller)) {
      case (?tm) { tm };
      case null { textOps.empty() };
    };

    // Enforce per-user template limit
    if (textOps.size(templateMap) >= MAX_TEMPLATES_PER_USER) {
      return #err(#InvalidInput("Too many templates: max " # debug_show(MAX_TEMPLATES_PER_USER)));
    };

    let templateId = "tpl_" # generateId();
    let now = Time.now();
    let template : SystemPromptTemplate = {
      id = templateId;
      name = name;
      content = content;
      isBuiltIn = false;
      createdAt = now;
    };

    let updatedMap = textOps.put(templateMap, templateId, template);
    userTemplates := principalOps.put(userTemplates, msg.caller, updatedMap);

    #ok(template);
  };

  /// List all system prompt templates available to the authenticated caller.
  /// Returns built-in templates first, then user-created templates.
  public shared query (msg) func listTemplates() : async Result.Result<[SystemPromptTemplate], OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    let buf = Buffer.fromArray<SystemPromptTemplate>(BUILT_IN_TEMPLATES);

    switch (principalOps.get(userTemplates, msg.caller)) {
      case (?templateMap) {
        for ((_, tpl) in textOps.entries(templateMap)) {
          buf.add(tpl);
        };
      };
      case null {};
    };

    #ok(Buffer.toArray(buf));
  };

  /// Delete a user-created system prompt template by ID.
  /// Built-in templates cannot be deleted.
  public shared (msg) func deleteTemplate(templateId : Text) : async Result.Result<(), OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Prevent deletion of built-in templates
    for (builtin in BUILT_IN_TEMPLATES.vals()) {
      if (builtin.id == templateId) {
        return #err(#InvalidInput("Cannot delete built-in templates"));
      };
    };

    switch (principalOps.get(userTemplates, msg.caller)) {
      case (?templateMap) {
        switch (textOps.get(templateMap, templateId)) {
          case (?_) {
            let updatedMap = textOps.delete(templateMap, templateId);
            userTemplates := principalOps.put(userTemplates, msg.caller, updatedMap);
            #ok(());
          };
          case null { #err(#InvalidInput("Template not found")) };
        };
      };
      case null { #err(#InvalidInput("Template not found")) };
    };
  };

  // ── MagickMind Configuration ──────────────────────────────────

  /// Save the caller's MagickMind configuration (mindspace and brain mode).
  /// This config is automatically applied when routing prompts to MagickMind_Brain.
  /// Call this before using MagickMind to select a non-default mindspace or
  /// to switch between Fast and Smart brain modes.
  public shared (msg) func setMagickMindConfig(mindspaceId : Text, brainMode : MagickMindBrainMode, fastModelId : Text, smartModelIds : [Text], computePower : Nat) : async Result.Result<(), OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Validate mindspaceId is not empty
    if (Text.size(mindspaceId) == 0) {
      return #err(#InvalidInput("mindspaceId cannot be empty"));
    };
    if (Text.size(mindspaceId) > 200) {
      return #err(#InvalidInput("mindspaceId too long: max 200 characters"));
    };
    if (computePower > 100) {
      return #err(#InvalidInput("computePower must be 0-100"));
    };

    let config : MagickMindConfig = {
      mindspaceId = mindspaceId;
      brainMode = brainMode;
      fastModelId = fastModelId;
      smartModelIds = smartModelIds;
      computePower = computePower;
    };
    magickmindConfigs := principalOps.put(magickmindConfigs, msg.caller, config);
    #ok(());
  };

  /// Retrieve the caller's MagickMind configuration.
  /// Returns #err(#InvalidInput) if no config has been set yet (the caller
  /// has not called setMagickMindConfig). In that case, the default mindspace
  /// ("default") and no brain mode override are used automatically.
  public shared query (msg) func getMagickMindConfig() : async Result.Result<MagickMindConfig, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    switch (principalOps.get(magickmindConfigs, msg.caller)) {
      case (?config) { #ok(config) };
      case null { #err(#InvalidInput("No MagickMind config set. Defaults will be used.")) };
    };
  };

  // ── Persona Management ──────────────────────────────────────────

  /// Compile a Persona into a system prompt string that sets the AI's behavior.
  /// If traits are provided, appends a "Trait Profile" section for traits that
  /// significantly deviate from 50 (the neutral center).
  func compilePersonaPrompt(persona : Persona, traits : ?PersonaTraits) : Text {
    var prompt = "You are " # persona.name # ". " # persona.description # ".\n\n";
    prompt #= "Personality: " # persona.personality # "\n\n";
    prompt #= "Communication style: " # persona.tone # "\n\n";
    if (persona.expertise.size() > 0) {
      prompt #= "Areas of expertise: ";
      var first = true;
      for (e in persona.expertise.vals()) {
        if (not first) { prompt #= ", " };
        first := false;
        prompt #= e;
      };
      prompt #= "\n\n";
    };
    if (Text.size(persona.instructions) > 0) {
      prompt #= "Instructions: " # persona.instructions # "\n";
    };

    // Append trait profile if traits are available
    switch (traits) {
      case (?t) {
        let traitBuf = Buffer.Buffer<Text>(0);
        for (trait in t.traits.vals()) {
          // Only include numeric traits with significant deviation from 50
          if (trait.traitType == #Numeric) {
            let val = switch (trait.numericValue) {
              case (?v) { v };
              case null { trait.defaultValue };
            };
            if (val >= 65 or val <= 35) {
              let qualifier = if (val >= 65) {
                " (lean into this, emphasize " # trait.description # ")"
              } else {
                " (minimize this, keep light on " # trait.description # ")"
              };
              traitBuf.add("- " # trait.displayName # ": " # Nat.toText(val) # "/100" # qualifier);
            };
          };
        };
        if (traitBuf.size() > 0) {
          prompt #= "\nTrait Profile (adjust your behavior accordingly):\n";
          for (line in traitBuf.vals()) {
            prompt #= line # "\n";
          };
        };
      };
      case null {};
    };

    prompt;
  };

  /// Save (create or update) a user persona.
  public shared (msg) func savePersona(
    personaId : ?Text,
    name : Text,
    avatar : Text,
    description : Text,
    personality : Text,
    tone : Text,
    expertise : [Text],
    instructions : Text
  ) : async Result.Result<Persona, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };
    if (Text.size(name) == 0 or Text.size(name) > 50) {
      return #err(#InvalidInput("Name must be 1-50 characters"));
    };
    if (Text.size(description) > 200) {
      return #err(#InvalidInput("Description max 200 characters"));
    };
    if (Text.size(personality) > 500) {
      return #err(#InvalidInput("Personality max 500 characters"));
    };
    if (Text.size(tone) > 200) {
      return #err(#InvalidInput("Tone max 200 characters"));
    };
    if (expertise.size() > 10) {
      return #err(#InvalidInput("Max 10 expertise areas"));
    };
    if (Text.size(instructions) > 1000) {
      return #err(#InvalidInput("Instructions max 1000 characters"));
    };

    let now = Time.now();
    let id = switch (personaId) {
      case (?existingId) { existingId };
      case null { "persona_" # generateId() };
    };

    let userMap = switch (principalOps.get(userPersonas, msg.caller)) {
      case (?m) { m };
      case null { textOps.empty() };
    };

    // Check limit for new personas
    switch (personaId) {
      case null {
        if (textOps.size(userMap) >= MAX_PERSONAS_PER_USER) {
          return #err(#InvalidInput("Too many personas: max " # debug_show(MAX_PERSONAS_PER_USER)));
        };
      };
      case _ {};
    };

    let persona : Persona = {
      id = id;
      name = name;
      avatar = avatar;
      description = description;
      personality = personality;
      tone = tone;
      expertise = expertise;
      instructions = instructions;
      isBuiltIn = false;
      createdAt = switch (textOps.get(userMap, id)) {
        case (?existing) { existing.createdAt };
        case null { now };
      };
      updatedAt = now;
    };

    let updatedMap = textOps.put(userMap, id, persona);
    userPersonas := principalOps.put(userPersonas, msg.caller, updatedMap);
    #ok(persona);
  };

  /// List all available personas (built-in + user-created).
  public shared query (msg) func listPersonas() : async Result.Result<[Persona], OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    let buf = Buffer.fromArray<Persona>(BUILT_IN_PERSONAS);
    switch (principalOps.get(userPersonas, msg.caller)) {
      case (?userMap) {
        for ((_, p) in textOps.entries(userMap)) {
          buf.add(p);
        };
      };
      case null {};
    };
    #ok(Buffer.toArray(buf));
  };

  /// Get a specific persona by ID (checks built-in first, then user).
  public shared query (msg) func getPersona(personaId : Text) : async Result.Result<Persona, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Check built-in
    switch (Array.find<Persona>(BUILT_IN_PERSONAS, func(p) { p.id == personaId })) {
      case (?p) { return #ok(p) };
      case null {};
    };

    // Check user-created
    switch (principalOps.get(userPersonas, msg.caller)) {
      case (?userMap) {
        switch (textOps.get(userMap, personaId)) {
          case (?p) { return #ok(p) };
          case null {};
        };
      };
      case null {};
    };

    #err(#InvalidInput("Persona not found"));
  };

  /// Delete a user-created persona. Cannot delete built-in personas.
  public shared (msg) func deletePersona(personaId : Text) : async Result.Result<(), OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Can't delete built-in
    switch (Array.find<Persona>(BUILT_IN_PERSONAS, func(p) { p.id == personaId })) {
      case (?_) { return #err(#InvalidInput("Cannot delete built-in personas")) };
      case null {};
    };

    switch (principalOps.get(userPersonas, msg.caller)) {
      case (?userMap) {
        switch (textOps.get(userMap, personaId)) {
          case (?_) {
            let updatedMap = textOps.delete(userMap, personaId);
            userPersonas := principalOps.put(userPersonas, msg.caller, updatedMap);
            #ok(());
          };
          case null { #err(#InvalidInput("Persona not found")) };
        };
      };
      case null { #err(#InvalidInput("Persona not found")) };
    };
  };

  /// Compile a persona into its system prompt text. Used by the frontend
  /// to preview what prompt will be sent, or by the chat system to inject
  /// the persona into conversation context. Includes trait profile if the
  /// caller has traits configured for this persona.
  public shared query (msg) func compilePersona(personaId : Text) : async Result.Result<Text, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Look up the caller's traits for this persona
    let callerTraits : ?PersonaTraits = switch (principalOps.get(personaTraits, msg.caller)) {
      case (?traitsMap) { textOps.get(traitsMap, personaId) };
      case null { null };
    };

    // Check built-in
    switch (Array.find<Persona>(BUILT_IN_PERSONAS, func(p) { p.id == personaId })) {
      case (?p) { return #ok(compilePersonaPrompt(p, callerTraits)) };
      case null {};
    };

    // Check user-created
    switch (principalOps.get(userPersonas, msg.caller)) {
      case (?userMap) {
        switch (textOps.get(userMap, personaId)) {
          case (?p) { return #ok(compilePersonaPrompt(p, callerTraits)) };
          case null {};
        };
      };
      case null {};
    };

    #err(#InvalidInput("Persona not found"));
  };

  // ── Persona Traits Management ──────────────────────────────────

  /// Look up a persona by ID across built-in and user-created personas.
  /// Returns null if not found. Used internally by trait and group chat endpoints.
  func findPersona(caller : Principal, personaId : Text) : ?Persona {
    // Check built-in
    switch (Array.find<Persona>(BUILT_IN_PERSONAS, func(p) { p.id == personaId })) {
      case (?p) { return ?p };
      case null {};
    };
    // Check user-created
    switch (principalOps.get(userPersonas, caller)) {
      case (?userMap) { textOps.get(userMap, personaId) };
      case null { null };
    };
  };

  /// Return default trait values for a built-in persona, derived from its personality.
  func builtInTraitsFor(personaId : Text) : ?[PersonaTrait] {
    if (personaId == "persona_coder") {
      ?[
        makeNumericTrait("creativity", "Creativity", 40, "How creative and unconventional the responses are", "personality", 30),
        makeNumericTrait("formality", "Formality", 70, "Formal/professional vs casual/friendly tone", "communication", 20),
        makeNumericTrait("humor", "Humor", 15, "How much humor and wit to include", "personality", 25),
        makeNumericTrait("detail", "Detail Level", 85, "Level of detail and thoroughness in responses", "behavior", 15),
        makeNumericTrait("empathy", "Empathy", 30, "Emotional awareness and supportive language", "personality", 30),
        makeNumericTrait("directness", "Directness", 80, "Concise and to-the-point vs exploratory", "communication", 20),
        makeNumericTrait("technical", "Technical Depth", 95, "Technical depth and jargon usage", "behavior", 15),
        makeNumericTrait("curiosity", "Curiosity", 40, "How much the persona asks follow-up questions", "personality", 20),
      ];
    } else if (personaId == "persona_researcher") {
      ?[
        makeNumericTrait("creativity", "Creativity", 35, "How creative and unconventional the responses are", "personality", 30),
        makeNumericTrait("formality", "Formality", 75, "Formal/professional vs casual/friendly tone", "communication", 20),
        makeNumericTrait("humor", "Humor", 10, "How much humor and wit to include", "personality", 25),
        makeNumericTrait("detail", "Detail Level", 90, "Level of detail and thoroughness in responses", "behavior", 15),
        makeNumericTrait("empathy", "Empathy", 25, "Emotional awareness and supportive language", "personality", 30),
        makeNumericTrait("directness", "Directness", 60, "Concise and to-the-point vs exploratory", "communication", 20),
        makeNumericTrait("technical", "Technical Depth", 70, "Technical depth and jargon usage", "behavior", 15),
        makeNumericTrait("curiosity", "Curiosity", 85, "How much the persona asks follow-up questions", "personality", 20),
      ];
    } else if (personaId == "persona_creative") {
      ?[
        makeNumericTrait("creativity", "Creativity", 95, "How creative and unconventional the responses are", "personality", 30),
        makeNumericTrait("formality", "Formality", 20, "Formal/professional vs casual/friendly tone", "communication", 20),
        makeNumericTrait("humor", "Humor", 60, "How much humor and wit to include", "personality", 25),
        makeNumericTrait("detail", "Detail Level", 50, "Level of detail and thoroughness in responses", "behavior", 15),
        makeNumericTrait("empathy", "Empathy", 70, "Emotional awareness and supportive language", "personality", 30),
        makeNumericTrait("directness", "Directness", 30, "Concise and to-the-point vs exploratory", "communication", 20),
        makeNumericTrait("technical", "Technical Depth", 15, "Technical depth and jargon usage", "behavior", 15),
        makeNumericTrait("curiosity", "Curiosity", 80, "How much the persona asks follow-up questions", "personality", 20),
      ];
    } else if (personaId == "persona_strategist") {
      ?[
        makeNumericTrait("creativity", "Creativity", 50, "How creative and unconventional the responses are", "personality", 30),
        makeNumericTrait("formality", "Formality", 80, "Formal/professional vs casual/friendly tone", "communication", 20),
        makeNumericTrait("humor", "Humor", 15, "How much humor and wit to include", "personality", 25),
        makeNumericTrait("detail", "Detail Level", 75, "Level of detail and thoroughness in responses", "behavior", 15),
        makeNumericTrait("empathy", "Empathy", 30, "Emotional awareness and supportive language", "personality", 30),
        makeNumericTrait("directness", "Directness", 85, "Concise and to-the-point vs exploratory", "communication", 20),
        makeNumericTrait("technical", "Technical Depth", 50, "Technical depth and jargon usage", "behavior", 15),
        makeNumericTrait("curiosity", "Curiosity", 45, "How much the persona asks follow-up questions", "personality", 20),
      ];
    } else if (personaId == "persona_mentor") {
      ?[
        makeNumericTrait("creativity", "Creativity", 45, "How creative and unconventional the responses are", "personality", 30),
        makeNumericTrait("formality", "Formality", 30, "Formal/professional vs casual/friendly tone", "communication", 20),
        makeNumericTrait("humor", "Humor", 25, "How much humor and wit to include", "personality", 25),
        makeNumericTrait("detail", "Detail Level", 55, "Level of detail and thoroughness in responses", "behavior", 15),
        makeNumericTrait("empathy", "Empathy", 95, "Emotional awareness and supportive language", "personality", 30),
        makeNumericTrait("directness", "Directness", 35, "Concise and to-the-point vs exploratory", "communication", 20),
        makeNumericTrait("technical", "Technical Depth", 10, "Technical depth and jargon usage", "behavior", 15),
        makeNumericTrait("curiosity", "Curiosity", 90, "How much the persona asks follow-up questions", "personality", 20),
      ];
    } else {
      null;
    };
  };

  /// Get the trait configuration for a persona. Creates default traits if none exist.
  /// For built-in personas, auto-initializes with personality-derived values.
  /// For user personas, uses DEFAULT_TRAITS.
  public shared query (msg) func getPersonaTraits(personaId : Text) : async Result.Result<PersonaTraits, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Verify persona exists
    switch (findPersona(msg.caller, personaId)) {
      case null { return #err(#InvalidInput("Persona not found")) };
      case _ {};
    };

    // Check if traits already exist
    switch (principalOps.get(personaTraits, msg.caller)) {
      case (?traitsMap) {
        switch (textOps.get(traitsMap, personaId)) {
          case (?t) { return #ok(t) };
          case null {};
        };
      };
      case null {};
    };

    // Auto-initialize with defaults
    let defaultTraitValues = switch (builtInTraitsFor(personaId)) {
      case (?traits) { traits };
      case null { DEFAULT_TRAITS };
    };

    let newTraits : PersonaTraits = {
      personaId = personaId;
      traits = defaultTraitValues;
      growthConfig = DEFAULT_GROWTH_CONFIG;
      multiLlmConfig = null;
      evolutionHistory = [];
      lastEvolvedAt = 0;
    };

    // Note: query calls cannot mutate state, so we return defaults without persisting.
    // The first savePersonaTraits or evolvePersonaTraits call will persist them.
    #ok(newTraits);
  };

  /// Save (create or update) persona trait configuration.
  /// Validates trait values are within 0-100, names <= 50 chars, max 20 traits.
  /// Creates a TraitSnapshot with trigger = "manual" in evolution history.
  public shared (msg) func savePersonaTraits(
    personaId : Text,
    traits : [PersonaTrait],
    growthConfig : Types.GrowthConfig,
    multiLlmConfig : ?Types.MultiLlmConfig,
  ) : async Result.Result<PersonaTraits, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Verify persona exists
    switch (findPersona(msg.caller, personaId)) {
      case null { return #err(#InvalidInput("Persona not found")) };
      case _ {};
    };

    // Validate traits
    if (traits.size() > 20) {
      return #err(#InvalidInput("Max 20 traits allowed"));
    };
    for (trait in traits.vals()) {
      switch (trait.numericValue) {
        case (?v) {
          if (v > trait.maxValue) {
            return #err(#InvalidInput("Trait value exceeds maxValue: " # trait.name));
          };
        };
        case null {};
      };
      if (Text.size(trait.name) == 0 or Text.size(trait.name) > 50) {
        return #err(#InvalidInput("Trait name must be 1-50 characters"));
      };
    };

    let now = Time.now();

    // Build history: keep existing + new snapshot, max 50 entries
    let existingTraits : ?PersonaTraits = switch (principalOps.get(personaTraits, msg.caller)) {
      case (?traitsMap) { textOps.get(traitsMap, personaId) };
      case null { null };
    };

    let snapshot : TraitSnapshot = {
      traits = traits;
      timestamp = now;
      trigger = "manual";
    };

    let historyBuf = Buffer.Buffer<TraitSnapshot>(0);
    switch (existingTraits) {
      case (?existing) {
        for (h in existing.evolutionHistory.vals()) {
          historyBuf.add(h);
        };
      };
      case null {};
    };
    historyBuf.add(snapshot);

    // Keep max 50 history entries (drop oldest)
    let historyArr = if (historyBuf.size() > MAX_EVOLUTION_HISTORY) {
      let full = Buffer.toArray(historyBuf);
      let drop = full.size() - MAX_EVOLUTION_HISTORY;
      Array.tabulate<TraitSnapshot>(MAX_EVOLUTION_HISTORY, func(i) { full[i + drop] });
    } else {
      Buffer.toArray(historyBuf);
    };

    let lastEvolved = switch (existingTraits) {
      case (?existing) { existing.lastEvolvedAt };
      case null { 0 };
    };

    let updated : PersonaTraits = {
      personaId = personaId;
      traits = traits;
      growthConfig = growthConfig;
      multiLlmConfig = multiLlmConfig;
      evolutionHistory = historyArr;
      lastEvolvedAt = lastEvolved;
    };

    // Persist
    let traitsMap = switch (principalOps.get(personaTraits, msg.caller)) {
      case (?m) { m };
      case null { textOps.empty() };
    };
    let updatedMap = textOps.put(traitsMap, personaId, updated);
    personaTraits := principalOps.put(personaTraits, msg.caller, updatedMap);

    #ok(updated);
  };

  /// Apply an integer adjustment to a Nat trait value and clamp to 0-100.
  func adjustTrait(current : Nat, delta : Int) : Nat {
    let val : Int = current + delta;
    if (val < 0) { 0 }
    else if (val > 100) { 100 }
    else { Int.abs(val) };
  };

  /// Apply an integer adjustment to a Nat trait value and clamp to [minVal, maxVal].
  func adjustTraitClamped(current : Nat, delta : Int, minVal : Nat, maxVal : Nat) : Nat {
    let val : Int = current + delta;
    let minI : Int = minVal;
    let maxI : Int = maxVal;
    if (val < minI) { minVal }
    else if (val > maxI) { maxVal }
    else { Int.abs(val) };
  };

  /// Evolve persona traits based on conversation patterns.
  /// Applies small ±1 to ±5 adjustments based on keyword analysis of the
  /// conversation summary. Only works if evolution is enabled and the cooldown
  /// period (5 minutes) has elapsed since the last evolution.
  public shared (msg) func evolvePersonaTraits(
    personaId : Text,
    conversationSummary : Text,
  ) : async Result.Result<PersonaTraits, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Verify persona exists
    switch (findPersona(msg.caller, personaId)) {
      case null { return #err(#InvalidInput("Persona not found")) };
      case _ {};
    };

    // Get existing traits (must exist — call savePersonaTraits first)
    let existing : PersonaTraits = switch (principalOps.get(personaTraits, msg.caller)) {
      case (?traitsMap) {
        switch (textOps.get(traitsMap, personaId)) {
          case (?t) { t };
          case null { return #err(#InvalidInput("No traits configured for this persona. Call savePersonaTraits first.")) };
        };
      };
      case null { return #err(#InvalidInput("No traits configured for this persona. Call savePersonaTraits first.")) };
    };

    // Check evolution is enabled (growthType != #Fixed)
    if (existing.growthConfig.growthType == #Fixed) {
      return #err(#InvalidInput("Evolution is not enabled for this persona (growthType is Fixed)"));
    };

    // Rate limit: only evolve if lastEvolvedAt is more than 5 minutes ago
    let now = Time.now();
    if (now - existing.lastEvolvedAt < EVOLUTION_COOLDOWN_NS) {
      return #err(#InvalidInput("Evolution cooldown: wait at least 5 minutes between evolutions"));
    };

    // Keyword analysis on the summary (case-insensitive)
    let lowerSummary = toLower(conversationSummary);

    // Track which traits were triggered for decay logic
    let traitBuf = Buffer.Buffer<PersonaTrait>(existing.traits.size());
    for (trait in existing.traits.vals()) {
      // Only evolve numeric, soft-locked traits; pass others through unchanged
      if (trait.traitType != #Numeric or trait.lock == #Hard) {
        traitBuf.add(trait);
      } else {
        let currentVal = switch (trait.numericValue) {
          case (?v) { v };
          case null { trait.defaultValue };
        };
        let lowerName = toLower(trait.name);
        var adjustment : Int = 0;
        var triggered = false;

        if (lowerName == "creativity") {
          if (Text.contains(lowerSummary, #text "creative") or Text.contains(lowerSummary, #text "imaginative") or Text.contains(lowerSummary, #text "novel")) {
            adjustment := 3;
            triggered := true;
          };
        } else if (lowerName == "formality") {
          if (Text.contains(lowerSummary, #text "formal") or Text.contains(lowerSummary, #text "professional")) {
            adjustment := 2;
            triggered := true;
          };
        } else if (lowerName == "humor") {
          if (Text.contains(lowerSummary, #text "funny") or Text.contains(lowerSummary, #text "humorous") or Text.contains(lowerSummary, #text "joke")) {
            adjustment := 3;
            triggered := true;
          };
        } else if (lowerName == "detail") {
          if (Text.contains(lowerSummary, #text "detailed") or Text.contains(lowerSummary, #text "thorough") or Text.contains(lowerSummary, #text "comprehensive")) {
            adjustment := 2;
            triggered := true;
          };
        } else if (lowerName == "empathy") {
          if (Text.contains(lowerSummary, #text "empathetic") or Text.contains(lowerSummary, #text "supportive") or Text.contains(lowerSummary, #text "caring")) {
            adjustment := 3;
            triggered := true;
          };
        } else if (lowerName == "directness") {
          if (Text.contains(lowerSummary, #text "direct") or Text.contains(lowerSummary, #text "concise") or Text.contains(lowerSummary, #text "brief")) {
            adjustment := 3;
            triggered := true;
          };
        } else if (lowerName == "technical") {
          if (Text.contains(lowerSummary, #text "technical") or Text.contains(lowerSummary, #text "code") or Text.contains(lowerSummary, #text "engineering")) {
            adjustment := 2;
            triggered := true;
          };
        } else if (lowerName == "curiosity") {
          if (Text.contains(lowerSummary, #text "question") or Text.contains(lowerSummary, #text "curious") or Text.contains(lowerSummary, #text "why")) {
            adjustment := 2;
            triggered := true;
          };
        };

        // Decay: traits that aren't triggered drift -1 toward 50 (center)
        if (not triggered) {
          let cv : Int = currentVal;
          if (cv > 50) { adjustment := -1 }
          else if (cv < 50) { adjustment := 1 };
        };

        let newValue = adjustTraitClamped(currentVal, adjustment, trait.minValue, trait.maxValue);
        traitBuf.add({ name = trait.name; displayName = trait.displayName; traitType = trait.traitType; description = trait.description; numericValue = ?newValue; categoricalValue = trait.categoricalValue; multilabelValue = trait.multilabelValue; options = trait.options; minValue = trait.minValue; maxValue = trait.maxValue; defaultValue = trait.defaultValue; lock = trait.lock; learningRate = trait.learningRate; supportsDyadic = trait.supportsDyadic; category = trait.category });
      };
    };

    let evolvedTraits = Buffer.toArray(traitBuf);

    // Create evolution snapshot
    let snapshot : TraitSnapshot = {
      traits = evolvedTraits;
      timestamp = now;
      trigger = "auto-evolution";
    };

    let historyBuf = Buffer.Buffer<TraitSnapshot>(0);
    for (h in existing.evolutionHistory.vals()) {
      historyBuf.add(h);
    };
    historyBuf.add(snapshot);

    // Keep max 50 history entries (drop oldest)
    let historyArr = if (historyBuf.size() > MAX_EVOLUTION_HISTORY) {
      let full = Buffer.toArray(historyBuf);
      let drop = full.size() - MAX_EVOLUTION_HISTORY;
      Array.tabulate<TraitSnapshot>(MAX_EVOLUTION_HISTORY, func(i) { full[i + drop] });
    } else {
      Buffer.toArray(historyBuf);
    };

    let updated : PersonaTraits = {
      personaId = personaId;
      traits = evolvedTraits;
      growthConfig = existing.growthConfig;
      multiLlmConfig = existing.multiLlmConfig;
      evolutionHistory = historyArr;
      lastEvolvedAt = now;
    };

    // Persist
    let traitsMap = switch (principalOps.get(personaTraits, msg.caller)) {
      case (?m) { m };
      case null { textOps.empty() };
    };
    let updatedMap = textOps.put(traitsMap, personaId, updated);
    personaTraits := principalOps.put(personaTraits, msg.caller, updatedMap);

    #ok(updated);
  };

  // ── Group Chat Management ──────────────────────────────────────

  /// Create a group chat with multiple personas.
  /// Validates that all persona IDs exist, name is 1-100 chars, and 2-5 personas.
  public shared (msg) func createGroupChat(
    name : Text,
    personaIds : [Text],
    turnOrder : { #RoundRobin; #Facilitator : Text; #FreeForm },
  ) : async Result.Result<GroupChat, OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Validate name
    if (Text.size(name) == 0 or Text.size(name) > 100) {
      return #err(#InvalidInput("Group chat name must be 1-100 characters"));
    };

    // Validate persona count
    if (personaIds.size() < 2 or personaIds.size() > MAX_PERSONAS_PER_GROUP) {
      return #err(#InvalidInput("Group chat requires 2-" # debug_show(MAX_PERSONAS_PER_GROUP) # " personas"));
    };

    // Validate all persona IDs exist
    for (pid in personaIds.vals()) {
      switch (findPersona(msg.caller, pid)) {
        case null { return #err(#InvalidInput("Persona not found: " # pid)) };
        case _ {};
      };
    };

    // Validate facilitator exists in the persona list if turnOrder is Facilitator
    let facilitatorId : ?Text = switch (turnOrder) {
      case (#Facilitator(fid)) {
        switch (Array.find<Text>(personaIds, func(p) { p == fid })) {
          case null { return #err(#InvalidInput("Facilitator must be one of the group personas")) };
          case _ { ?fid };
        };
      };
      case _ { null };
    };

    // Enforce per-user group chat limit
    let groupMap = switch (principalOps.get(userGroupChats, msg.caller)) {
      case (?m) { m };
      case null { textOps.empty() };
    };
    if (textOps.size(groupMap) >= MAX_GROUP_CHATS_PER_USER) {
      return #err(#InvalidInput("Too many group chats: max " # debug_show(MAX_GROUP_CHATS_PER_USER)));
    };

    let now = Time.now();
    let groupId = "group_" # generateId();

    let group : GroupChat = {
      id = groupId;
      name = name;
      personaIds = personaIds;
      turnOrder = turnOrder;
      facilitatorId = facilitatorId;
      invitedUsers = [];
      createdAt = now;
      updatedAt = now;
    };

    let updatedMap = textOps.put(groupMap, groupId, group);
    userGroupChats := principalOps.put(userGroupChats, msg.caller, updatedMap);

    #ok(group);
  };

  /// List all group chats for the authenticated caller.
  public shared query (msg) func listGroupChats() : async Result.Result<[GroupChat], OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    let buf = Buffer.Buffer<GroupChat>(0);
    switch (principalOps.get(userGroupChats, msg.caller)) {
      case (?groupMap) {
        for ((_, g) in textOps.entries(groupMap)) {
          buf.add(g);
        };
      };
      case null {};
    };

    #ok(Buffer.toArray(buf));
  };

  /// Delete a group chat by ID.
  public shared (msg) func deleteGroupChat(groupId : Text) : async Result.Result<(), OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    switch (principalOps.get(userGroupChats, msg.caller)) {
      case (?groupMap) {
        switch (textOps.get(groupMap, groupId)) {
          case (?_) {
            let updatedMap = textOps.delete(groupMap, groupId);
            userGroupChats := principalOps.put(userGroupChats, msg.caller, updatedMap);
            #ok(());
          };
          case null { #err(#InvalidInput("Group chat not found")) };
        };
      };
      case null { #err(#InvalidInput("Group chat not found")) };
    };
  };

  /// Invite another user (by Principal) to a group chat.
  /// Only the group chat creator (owner) can invite users.
  public shared (msg) func inviteToGroupChat(groupId : Text, invitee : Principal) : async Result.Result<(), OpenClawError> {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    switch (principalOps.get(userGroupChats, msg.caller)) {
      case (?groupMap) {
        switch (textOps.get(groupMap, groupId)) {
          case (?group) {
            // Check if invitee is already in the list
            let alreadyInvited = Array.find<Principal>(group.invitedUsers, func(p) { p == invitee });
            switch (alreadyInvited) {
              case (?_) { return #ok(()) }; // Already invited, no-op
              case null {};
            };

            // Add invitee
            let invBuf = Buffer.fromArray<Principal>(group.invitedUsers);
            invBuf.add(invitee);
            let updatedGroup : GroupChat = {
              id = group.id;
              name = group.name;
              personaIds = group.personaIds;
              turnOrder = group.turnOrder;
              facilitatorId = group.facilitatorId;
              invitedUsers = Buffer.toArray(invBuf);
              createdAt = group.createdAt;
              updatedAt = Time.now();
            };
            let updatedMap = textOps.put(groupMap, groupId, updatedGroup);
            userGroupChats := principalOps.put(userGroupChats, msg.caller, updatedMap);
            #ok(());
          };
          case null { #err(#InvalidInput("Group chat not found")) };
        };
      };
      case null { #err(#InvalidInput("Group chat not found")) };
    };
  };

  /// Route a single persona's message through MagickMind for group chat.
  /// This is a helper that compiles the persona prompt, builds the message
  /// array with group context, and calls LlmRouter.routeExternal.
  func groupRouteToMagickMind(
    caller : Principal,
    persona : Persona,
    personaTraitsOpt : ?PersonaTraits,
    history : [Message],
    userMessage : Text,
    otherNames : [Text],
    apiKey : Text,
    convId : Text,
    mmConfig : ?MagickMindConfig,
  ) : async Result.Result<Text, OpenClawError> {
    // Compile persona system prompt with traits
    var systemPrompt = compilePersonaPrompt(persona, personaTraitsOpt);

    // Add group context
    systemPrompt #= "\n\nYou are in a group discussion. Other participants: ";
    var first = true;
    for (n in otherNames.vals()) {
      if (not first) { systemPrompt #= ", " };
      first := false;
      systemPrompt #= n;
    };
    systemPrompt #= ". Respond in character as " # persona.name # ".\n";

    // Build message array: system prompt + history + user message
    let msgBuf = Buffer.Buffer<Message>(history.size() + 2);
    msgBuf.add({ role = #system_; content = systemPrompt });
    for (m in history.vals()) {
      // Skip existing system prompts from history to avoid confusion
      if (m.role != #system_) {
        msgBuf.add(m);
      };
    };
    msgBuf.add({ role = #user; content = userMessage });

    let idempotencyKey = generateIdempotencyKey();
    await LlmRouter.routeExternal(
      #MagickMind_Brain,
      Buffer.toArray(msgBuf),
      apiKey,
      idempotencyKey,
      Principal.toText(caller),
      transform,
      convId,
      mmConfig,
    );
  };

  /// Send a prompt to a group chat. Each persona in the group responds in turn.
  /// Uses MagickMind_Brain as the model for all persona responses.
  /// Deducts N * requestFee from the wallet (one per persona).
  public shared (msg) func groupPrompt(req : Types.GroupPromptRequest) : async Result.Result<Types.GroupPromptResponse, OpenClawError> {
    // Step 1: Auth check
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Step 2: Reentrancy guard
    switch (guard.acquire(msg.caller)) {
      case (#err(_)) { return #err(#AlreadyProcessing) };
      case (#ok(())) {};
    };

    try {
      // Step 3: Look up the group chat
      let group : GroupChat = switch (principalOps.get(userGroupChats, msg.caller)) {
        case (?groupMap) {
          switch (textOps.get(groupMap, req.groupId)) {
            case (?g) { g };
            case null { return #err(#InvalidInput("Group chat not found")) };
          };
        };
        case null { return #err(#InvalidInput("Group chat not found")) };
      };

      // Step 4: Resolve all personas in the group (own + hired)
      let personaBuf = Buffer.Buffer<Persona>(group.personaIds.size());
      let hiredIds = Buffer.Buffer<Text>(0); // track which are hired (for per-msg payment)
      for (pid in group.personaIds.vals()) {
        // Try caller's own personas first
        switch (findPersona(msg.caller, pid)) {
          case (?p) { personaBuf.add(p) };
          case null {
            // Check if it's a hired persona from the marketplace
            let key = hireKey(msg.caller, pid);
            switch (textOps.get(activeHires, key)) {
              case null { return #err(#InvalidInput("Persona not found or hire expired: " # pid)) };
              case (?hire) {
                let isActive = switch (hire.paymentType) {
                  case (#Daily) { Time.now() < hire.expiresAt };
                  case (#PerMessage) { true };
                };
                if (not isActive) { return #err(#InvalidInput("Hire expired for persona: " # pid)) };
                switch (findPersonaByOwner(hire.owner, pid)) {
                  case (?p) { personaBuf.add(p); hiredIds.add(pid) };
                  case null { return #err(#InvalidInput("Hired persona no longer exists: " # pid)) };
                };
              };
            };
          };
        };
      };
      let personas = Buffer.toArray(personaBuf);
      let personaCount = personas.size();

      // Step 5: Resolve or create conversation
      let convId = switch (req.conversationId) {
        case (?id) { id };
        case null { generateId() };
      };

      let caller = msg.caller;
      let userMap = getOrCreateUserMap(caller);
      let now = Time.now();

      let existingConv = textOps.get(userMap, convId);
      let (existingMessages, isNew) = switch (existingConv) {
        case (?conv) {
          if (conv.owner != caller) {
            return #err(#ConversationNotFound);
          };
          if (conv.messages.size() >= MAX_MESSAGES_PER_CONVERSATION) {
            return #err(#InvalidInput("Conversation too long: max " # debug_show(MAX_MESSAGES_PER_CONVERSATION) # " messages"));
          };
          (conv.messages, false);
        };
        case null {
          // Check conversation limit for new conversations
          if (textOps.size(userMap) >= MAX_CONVERSATIONS_PER_USER) {
            return #err(#InvalidInput("Too many conversations: max " # debug_show(MAX_CONVERSATIONS_PER_USER)));
          };
          ([], true);
        };
      };

      // Step 6: Resolve MagickMind config
      let resolvedMindspaceId = switch (req.mindspaceId) {
        case (?id) { id };
        case null {
          switch (existingConv) {
            case (?conv) {
              switch (conv.mindspaceId) {
                case (?id) { id };
                case null {
                  switch (principalOps.get(magickmindConfigs, caller)) {
                    case (?cfg) { cfg.mindspaceId };
                    case null { "default" };
                  };
                };
              };
            };
            case null {
              switch (principalOps.get(magickmindConfigs, caller)) {
                case (?cfg) { cfg.mindspaceId };
                case null { "default" };
              };
            };
          };
        };
      };

      let userMmCfg = principalOps.get(magickmindConfigs, caller);
      let brainMode = switch (userMmCfg) { case (?cfg) { cfg.brainMode }; case null { #Fast } };
      let fastModel = switch (userMmCfg) { case (?cfg) { cfg.fastModelId }; case null { "gpt-4o-mini" } };
      let smartModels = switch (userMmCfg) { case (?cfg) { cfg.smartModelIds }; case null { ["claude-sonnet-4"] : [Text] } };
      let compute = switch (userMmCfg) { case (?cfg) { cfg.computePower }; case null { 50 } };
      let mmConfig : ?MagickMindConfig = ?{ mindspaceId = resolvedMindspaceId; brainMode = brainMode; fastModelId = fastModel; smartModelIds = smartModels; computePower = compute };

      // Step 7: Get API key (once for all persona calls)
      let keyId = LlmRouter.providerKeyId(#MagickMind_Brain);
      let apiKey = switch (await getApiKey(caller, keyId)) {
        case (#ok(k)) { k };
        case (#err(e)) { return #err(e) };
      };

      // Step 8: Deduct N * requestFee from wallet (one per persona)
      let requestFee = getModelFee(#External(#MagickMind_Brain));
      let totalFee = requestFee * personaCount;
      var paymentDeducted = false;
      if (totalFee > 0) {
        switch (walletPrincipal) {
          case null {}; // wallet not configured — skip (local dev)
          case (?wp) {
            let walletActor : actor {
              deductForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
            } = actor (Principal.toText(wp));
            let deductResult = await walletActor.deductForRequest(caller, #ICP, totalFee);
            switch (deductResult) {
              case (#err(_)) { return #err(#InsufficientBalance) };
              case (#ok(())) { paymentDeducted := true };
            };
          };
        };
      };

      // Step 9: Build persona name list for group context
      let nameBuf = Buffer.Buffer<Text>(personaCount);
      for (p in personas.vals()) { nameBuf.add(p.name) };
      let allNames = Buffer.toArray(nameBuf);

      // Build message buffer for conversation persistence
      let messagesBuf = Buffer.fromArray<Message>(existingMessages);
      messagesBuf.add({ role = #user; content = req.message });

      // Step 10: Determine call order based on turnOrder
      // If targetPersonaId is set (@mention), only that persona responds
      let orderedPersonas : [Persona] = switch (req.targetPersonaId) {
        case (?targetId) {
          switch (Array.find<Persona>(personas, func(p) { p.id == targetId })) {
            case (?target) { [target] };
            case null { return #err(#InvalidInput("Target persona not found in group: " # targetId)) };
          };
        };
        case null {
          switch (group.turnOrder) {
            case (#Facilitator(fid)) {
              // Facilitator goes first, then the rest in order
              let buf = Buffer.Buffer<Persona>(personaCount);
              switch (Array.find<Persona>(personas, func(p) { p.id == fid })) {
                case (?f) { buf.add(f) };
                case null {};
              };
              for (p in personas.vals()) {
                if (p.id != fid) { buf.add(p) };
              };
              Buffer.toArray(buf);
            };
            case (#RoundRobin or #FreeForm) { personas };
          };
        };
      };

      // Step 11: Call each persona through MagickMind
      let responseBuf = Buffer.Buffer<GroupMessage>(personaCount);
      let currentHistory = Buffer.toArray(messagesBuf);

      for (persona in orderedPersonas.vals()) {
        // Per-message payment for hired personas
        let isHired = Array.find<Text>(Buffer.toArray(hiredIds), func(id) { id == persona.id });
        var skipPersona = false;
        switch (isHired) {
          case (?hid) {
            switch (textOps.get(marketplace, hid)) {
              case (?pub) {
                if (pub.pricePerMessage > 0) {
                  switch (walletPrincipal) {
                    case null {}; // dev mode
                    case (?wp) {
                      let walletActor : actor {
                        deductForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
                      } = actor (Principal.toText(wp));
                      switch (await walletActor.deductForRequest(caller, #ICP, pub.pricePerMessage)) {
                        case (#err(_)) {
                          responseBuf.add({ role = #assistant; content = "[Payment failed — insufficient balance for " # persona.name # "]"; personaId = ?persona.id; personaName = ?persona.name; personaAvatar = ?persona.avatar; targetPersonaId = null; senderPrincipal = null });
                          skipPersona := true;
                        };
                        case (#ok(())) {
                          let prev = switch (textOps.get(personaEarnings, hid)) { case null { 0 }; case (?v) { v } };
                          personaEarnings := textOps.put(personaEarnings, hid, prev + pub.pricePerMessage);
                          let hKey = hireKey(caller, hid);
                          switch (textOps.get(activeHires, hKey)) {
                            case (?hire) {
                              activeHires := textOps.put(activeHires, hKey, {
                                hirer = hire.hirer; personaId = hire.personaId; owner = hire.owner;
                                paymentType = hire.paymentType; expiresAt = hire.expiresAt;
                                messagesUsed = hire.messagesUsed + 1;
                                totalPaid = hire.totalPaid + pub.pricePerMessage;
                                startedAt = hire.startedAt;
                              });
                            };
                            case null {};
                          };
                        };
                      };
                    };
                  };
                };
              };
              case null {};
            };
          };
          case null {};
        };

        if (not skipPersona) {
        // Get other persona names (exclude current)
        let otherBuf = Buffer.Buffer<Text>(0);
        for (n in allNames.vals()) {
          if (n != persona.name) { otherBuf.add(n) };
        };

        // Look up persona traits (check owner's traits for hired personas)
        let traitOwner = switch (isHired) {
          case (?_) {
            let hKey2 = hireKey(caller, persona.id);
            switch (textOps.get(activeHires, hKey2)) {
              case (?hire) { hire.owner };
              case null { caller };
            };
          };
          case null { caller };
        };
        let pTraits : ?PersonaTraits = switch (principalOps.get(personaTraits, traitOwner)) {
          case (?traitsMap) { textOps.get(traitsMap, persona.id) };
          case null { null };
        };

        let routeResult = await groupRouteToMagickMind(
          caller,
          persona,
          pTraits,
          currentHistory,
          req.message,
          Buffer.toArray(otherBuf),
          apiKey,
          convId,
          mmConfig,
        );

        switch (routeResult) {
          case (#ok(reply)) {
            let groupMsg : GroupMessage = {
              role = #assistant;
              content = reply;
              personaId = ?persona.id;
              personaName = ?persona.name;
              personaAvatar = ?persona.avatar;
              targetPersonaId = null;
              senderPrincipal = null;
            };
            responseBuf.add(groupMsg);

            // Add to conversation history so subsequent personas see previous responses
            messagesBuf.add({ role = #assistant; content = "[" # persona.name # "]: " # reply });
          };
          case (#err(e)) {
            // Refund on failure if payment was deducted
            if (paymentDeducted) {
              switch (walletPrincipal) {
                case (?wp) {
                  let walletActor : actor {
                    refundForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
                  } = actor (Principal.toText(wp));
                  try { ignore await walletActor.refundForRequest(caller, #ICP, totalFee) }
                  catch (_) {};
                };
                case null {};
              };
            };
            return #err(e);
          };
        };
        }; // end if (not skipPersona)
      };

      // Step 12: Persist conversation
      let updatedConv : Conversation = {
        id = convId;
        owner = caller;
        model = #External(#MagickMind_Brain);
        messages = Buffer.toArray(messagesBuf);
        createdAt = if (isNew) { now } else {
          switch (existingConv) {
            case (?c) { c.createdAt };
            case null { now };
          };
        };
        updatedAt = now;
        mindspaceId = ?resolvedMindspaceId;
      };

      let updatedUserMap = textOps.put(userMap, convId, updatedConv);
      userConversations := principalOps.put(userConversations, caller, updatedUserMap);

      // Step 13: Increment prompt count (fire-and-forget, once for group)
      switch (identityPrincipal) {
        case null {};
        case (?ip) {
          let identityActor : actor {
            incrementPromptCount : (Principal) -> async ();
          } = actor (Principal.toText(ip));
          try { await identityActor.incrementPromptCount(caller) } catch (_) {};
        };
      };

      #ok({
        conversationId = convId;
        responses = Buffer.toArray(responseBuf);
      });
    } catch (_) {
      #err(#ProviderError("Internal error"));
    } finally {
      guard.release(msg.caller);
    };
  };

  // ── Communications ──────────────────────────────────────────

  /// Send an email via Resend. User must have "resend_api_key" in KeyVault.
  public shared (msg) func sendEmail(
    to : Text, subject : Text, htmlBody : Text, from : ?Text,
  ) : async Types.CommResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let idempotencyKey = generateIdempotencyKey();
    let apiKeyResult = await getApiKey(caller, "resend_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No Resend API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let fromAddr = switch (from) { case (?f) { f }; case null { "OpenClaw <onboarding@resend.dev>" } };
    await Communications.sendEmailResend(apiKey, fromAddr, to, subject, htmlBody, idempotencyKey, transform);
  };

  /// Send an SMS via Twilio. User must have twilio_account_sid, twilio_auth_token, and twilio_phone_number in KeyVault.
  public shared (msg) func sendSms(to : Text, body : Text) : async Types.CommResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let idempotencyKey = generateIdempotencyKey();
    let sidResult = await getApiKey(caller, "twilio_account_sid");
    let tokenResult = await getApiKey(caller, "twilio_auth_token");
    let phoneResult = await getApiKey(caller, "twilio_phone_number");
    let sid = switch (sidResult) { case (#ok(k)) { k }; case (#err(_)) { return #NotConfigured("No Twilio SID. Add in Settings.") } };
    let token = switch (tokenResult) { case (#ok(k)) { k }; case (#err(_)) { return #NotConfigured("No Twilio Auth Token. Add in Settings.") } };
    let phone = switch (phoneResult) { case (#ok(k)) { k }; case (#err(_)) { return #NotConfigured("No Twilio Phone Number. Add in Settings.") } };
    await Communications.sendSmsTwilio(sid, token, phone, to, body, idempotencyKey, transform);
  };

  // ── Monitoring ────────────────────────────────────────────────
  // ── Dual Prompt (fast + smart in one call) ────────────────────

  /// Send a prompt to MagickMind twice — once with computePower=0 (fast) and
  /// once with computePower=100 (smart) — returning both replies. The fee is
  /// deducted only once. The smart reply is saved to the conversation as the
  /// canonical assistant response.
  public shared (msg) func dualPrompt(req : PromptRequest) : async Result.Result<DualPromptResponse, OpenClawError> {
    // Step 1: Auth check
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Step 2: Reentrancy guard
    switch (guard.acquire(msg.caller)) {
      case (#err(_)) { return #err(#AlreadyProcessing) };
      case (#ok(())) {};
    };

    try {
      // Step 3: Resolve or create conversation
      let convId = switch (req.conversationId) {
        case (?id) { id };
        case null { generateId() };
      };

      let userMap = getOrCreateUserMap(msg.caller);
      let now = Time.now();

      switch (textOps.get(userMap, convId)) {
        case null {
          if (textOps.size(userMap) >= MAX_CONVERSATIONS_PER_USER) {
            return #err(#InvalidInput("Too many conversations: max " # debug_show(MAX_CONVERSATIONS_PER_USER)));
          };
        };
        case _ {};
      };

      let existingConv : ?Conversation = textOps.get(userMap, convId);
      let (existingMessages, isNew) = switch (existingConv) {
        case (?conv) {
          if (conv.owner != msg.caller) {
            return #err(#ConversationNotFound);
          };
          if (conv.messages.size() >= MAX_MESSAGES_PER_CONVERSATION) {
            return #err(#InvalidInput("Conversation too long: max " # debug_show(MAX_MESSAGES_PER_CONVERSATION) # " messages"));
          };
          (conv.messages, false);
        };
        case null { ([], true) };
      };

      // Resolve mindspaceId (same logic as prompt)
      let resolvedMindspaceId : ?Text = do {
        let msId = switch (req.mindspaceId) {
          case (?id) { id };
          case null {
            switch (existingConv) {
              case (?conv) {
                switch (conv.mindspaceId) {
                  case (?id) { id };
                  case null {
                    switch (principalOps.get(magickmindConfigs, msg.caller)) {
                      case (?cfg) { cfg.mindspaceId };
                      case null { "default" };
                    };
                  };
                };
              };
              case null {
                switch (principalOps.get(magickmindConfigs, msg.caller)) {
                  case (?cfg) { cfg.mindspaceId };
                  case null { "default" };
                };
              };
            };
          };
        };
        ?msId;
      };

      // Step 4: Build message list
      let messagesBuf = Buffer.fromArray<Message>(existingMessages);
      switch (req.systemPrompt) {
        case (?sp) { if (isNew) { messagesBuf.add({ role = #system_; content = sp }) } };
        case null {};
      };
      messagesBuf.add({ role = #user; content = req.message });

      let caller = msg.caller;
      let idempotencyKeyFast = generateIdempotencyKey();
      let idempotencyKeySmart = generateIdempotencyKey();

      // Step 5a: Resolve API key
      let apiKey = switch (req.apiKey) {
        case (?key) { key };
        case null {
          let keyId = LlmRouter.providerKeyId(#MagickMind_Brain);
          let apiKeyResult = await getApiKey(caller, keyId);
          switch (apiKeyResult) {
            case (#err(e)) { return #err(e) };
            case (#ok(k)) { k };
          };
        };
      };

      // Step 5b: Deduct fee ONCE
      let requestFee = getModelFee(req.model);
      var paymentDeducted = false;
      if (requestFee > 0) {
        switch (walletPrincipal) {
          case null {};
          case (?wp) {
            let walletActor : actor {
              deductForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
            } = actor (Principal.toText(wp));
            let deductResult = await walletActor.deductForRequest(caller, #ICP, requestFee);
            switch (deductResult) {
              case (#err(_)) { return #err(#InsufficientBalance) };
              case (#ok(())) { paymentDeducted := true };
            };
          };
        };
      };

      // Read user config for model IDs
      let userCfg = principalOps.get(magickmindConfigs, caller);
      let fastModel = switch (userCfg) { case (?c) { c.fastModelId }; case null { "gpt-4o-mini" } };
      let smartModels = switch (userCfg) { case (?c) { c.smartModelIds }; case null { ["claude-sonnet-4"] : [Text] } };
      let mindspaceId = switch (resolvedMindspaceId) { case (?id) { id }; case null { "default" } };
      let fastModelOpt : ?Text = if (fastModel == "") { null } else { ?fastModel };

      // Step 6: Make TWO calls — fast (computePower=0) then smart (computePower=100)
      let fastResult = await HttpOutcalls.callMagickMind(
        req.message, apiKey, convId, Principal.toText(caller),
        mindspaceId, idempotencyKeyFast, transform,
        fastModelOpt, smartModels, 0, null,
      );

      let fastReply = switch (fastResult) {
        case (#ok(text)) { text };
        case (#err(e)) {
          // Refund on failure
          if (paymentDeducted) {
            switch (walletPrincipal) {
              case (?wp) {
                let walletActor : actor {
                  refundForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
                } = actor (Principal.toText(wp));
                try { ignore await walletActor.refundForRequest(caller, #ICP, requestFee) }
                catch (_) {};
              };
              case null {};
            };
          };
          return #err(e);
        };
      };

      let smartResult = await HttpOutcalls.callMagickMind(
        req.message, apiKey, convId, Principal.toText(caller),
        mindspaceId, idempotencyKeySmart, transform,
        fastModelOpt, smartModels, 100, null,
      );

      let smartReply = switch (smartResult) {
        case (#ok(text)) { text };
        case (#err(e)) {
          // Refund on failure (smart failed but fast succeeded — still refund)
          if (paymentDeducted) {
            switch (walletPrincipal) {
              case (?wp) {
                let walletActor : actor {
                  refundForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
                } = actor (Principal.toText(wp));
                try { ignore await walletActor.refundForRequest(caller, #ICP, requestFee) }
                catch (_) {};
              };
              case null {};
            };
          };
          return #err(e);
        };
      };

      // Step 7: Save the SMART reply as the canonical conversation response
      messagesBuf.add({ role = #assistant; content = smartReply });

      // Step 8: Increment prompt count (fire-and-forget)
      switch (identityPrincipal) {
        case null {};
        case (?ip) {
          let identityActor : actor {
            incrementPromptCount : (Principal) -> async ();
          } = actor (Principal.toText(ip));
          try { await identityActor.incrementPromptCount(caller) } catch (_) {};
        };
      };

      // Step 9: Persist conversation
      let updatedConv : Conversation = {
        id = convId;
        owner = msg.caller;
        model = req.model;
        messages = Buffer.toArray(messagesBuf);
        createdAt = if (isNew) { now } else {
          switch (existingConv) {
            case (?c) { c.createdAt };
            case null { now };
          };
        };
        updatedAt = now;
        mindspaceId = resolvedMindspaceId;
      };

      let updatedUserMap = textOps.put(userMap, convId, updatedConv);
      userConversations := principalOps.put(userConversations, msg.caller, updatedUserMap);

      #ok({
        conversationId = convId;
        fastReply = fastReply;
        smartReply = smartReply;
        model = req.model;
        mindspaceId = resolvedMindspaceId;
      });
    } catch (_) {
      #err(#ProviderError("Internal error"));
    } finally {
      guard.release(msg.caller);
    };
  };

  // ── Compare Models ──────────────────────────────────────────────

  /// Send the same message to multiple models via MagickMind's OpenAI-compatible
  /// endpoint and return all responses. Max 4 models per request. The first
  /// model's response is saved to the conversation as the canonical reply.
  /// Each model is called sequentially (ICP does not allow parallel awaits).
  public shared (msg) func compareModels(req : Types.CompareRequest) : async Result.Result<CompareResponse, OpenClawError> {
    // Step 1: Auth check
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // Step 2: Reentrancy guard
    switch (guard.acquire(msg.caller)) {
      case (#err(_)) { return #err(#AlreadyProcessing) };
      case (#ok(())) {};
    };

    try {
      // Validate: max 4 models
      if (req.modelIds.size() > 4) {
        return #err(#InvalidInput("Too many models: max 4 for comparison"));
      };
      if (req.modelIds.size() == 0) {
        return #err(#InvalidInput("At least one model is required"));
      };

      // Step 3: Resolve or create conversation
      let convId = switch (req.conversationId) {
        case (?id) { id };
        case null { generateId() };
      };

      let userMap = getOrCreateUserMap(msg.caller);
      let now = Time.now();

      switch (textOps.get(userMap, convId)) {
        case null {
          if (textOps.size(userMap) >= MAX_CONVERSATIONS_PER_USER) {
            return #err(#InvalidInput("Too many conversations: max " # debug_show(MAX_CONVERSATIONS_PER_USER)));
          };
        };
        case _ {};
      };

      let existingConv : ?Conversation = textOps.get(userMap, convId);
      let (existingMessages, isNew) = switch (existingConv) {
        case (?conv) {
          if (conv.owner != msg.caller) {
            return #err(#ConversationNotFound);
          };
          if (conv.messages.size() >= MAX_MESSAGES_PER_CONVERSATION) {
            return #err(#InvalidInput("Conversation too long: max " # debug_show(MAX_MESSAGES_PER_CONVERSATION) # " messages"));
          };
          (conv.messages, false);
        };
        case null { ([], true) };
      };

      // Step 4: Build message list
      let messagesBuf = Buffer.fromArray<Message>(existingMessages);
      switch (req.systemPrompt) {
        case (?sp) { if (isNew) { messagesBuf.add({ role = #system_; content = sp }) } };
        case null {};
      };
      messagesBuf.add({ role = #user; content = req.message });

      let caller = msg.caller;
      let allMessages = Buffer.toArray(messagesBuf);

      // Step 5: Get MagickMind API key
      let keyId = LlmRouter.providerKeyId(#MagickMind_Brain);
      let apiKeyResult = await getApiKey(caller, keyId);
      let apiKey = switch (apiKeyResult) {
        case (#err(e)) { return #err(e) };
        case (#ok(k)) { k };
      };

      // Step 6: Call each model sequentially
      let responsesBuf = Buffer.Buffer<ModelResponse>(req.modelIds.size());

      for (modelId in req.modelIds.vals()) {
        let idempKey = generateIdempotencyKey();
        let result = await HttpOutcalls.callMagickMindDirect(
          allMessages, apiKey, modelId, 50, idempKey, transform,
        );
        let reply = switch (result) {
          case (#ok(text)) { text };
          case (#err(e)) {
            // On error, record the error message as the reply rather than
            // aborting the whole comparison
            switch (e) {
              case (#ProviderError(errText)) { "[Error] " # errText };
              case _ { "[Error] Model call failed" };
            };
          };
        };
        responsesBuf.add({ modelId = modelId; reply = reply });
      };

      let responses = Buffer.toArray(responsesBuf);

      // Step 7: Save the FIRST response to conversation
      let firstReply = if (responses.size() > 0) { responses[0].reply } else { "" };
      messagesBuf.add({ role = #assistant; content = firstReply });

      // Step 8: Increment prompt count (fire-and-forget)
      switch (identityPrincipal) {
        case null {};
        case (?ip) {
          let identityActor : actor {
            incrementPromptCount : (Principal) -> async ();
          } = actor (Principal.toText(ip));
          try { await identityActor.incrementPromptCount(caller) } catch (_) {};
        };
      };

      // Step 9: Persist conversation
      let resolvedMindspaceId = req.mindspaceId;
      let updatedConv : Conversation = {
        id = convId;
        owner = msg.caller;
        model = #External(#MagickMind_Brain);
        messages = Buffer.toArray(messagesBuf);
        createdAt = if (isNew) { now } else {
          switch (existingConv) {
            case (?c) { c.createdAt };
            case null { now };
          };
        };
        updatedAt = now;
        mindspaceId = resolvedMindspaceId;
      };

      let updatedUserMap = textOps.put(userMap, convId, updatedConv);
      userConversations := principalOps.put(userConversations, msg.caller, updatedUserMap);

      #ok({
        conversationId = convId;
        responses = responses;
      });
    } catch (_) {
      #err(#ProviderError("Internal error"));
    } finally {
      guard.release(msg.caller);
    };
  };

  // ── Memory Management ──────────────────────────────────────────
  // These endpoints expose MagickMind's memory system: corpus (RAG knowledge
  // bases), episodic memory (Pelican), context composition (prepare_context),
  // artifact uploads, and mindspace CRUD. All require a MagickMind API key
  // stored in KeyVault under "magickmind_api_key".

  /// Semantic search on a MagickMind corpus (knowledge base).
  /// Returns raw JSON response from the MagickMind API.
  public shared (msg) func queryCorpus(corpusId : Text, searchQuery : Text, mode : Text, onlyContext : Bool) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let result = await HttpOutcalls.queryCorpus(apiKey, corpusId, searchQuery, mode, onlyContext, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Compose multi-source memory context (chat history + corpus + pelican).
  /// The caller's principal is used as the participantId.
  public shared (msg) func prepareContext(mindspaceId : Text, historyLimit : Nat, corpusQuery : ?Text, pelicanQuery : ?Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let participantId = Principal.toText(caller);
    let result = await HttpOutcalls.prepareContext(apiKey, mindspaceId, participantId, historyLimit, corpusQuery, pelicanQuery, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Create a new corpus (knowledge base) in MagickMind.
  public shared (msg) func createCorpus(name : Text, description : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let result = await HttpOutcalls.createCorpus(apiKey, name, description, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// List all corpora (knowledge bases) for the authenticated user.
  public shared (msg) func listCorpora() : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let result = await HttpOutcalls.listCorpora(apiKey, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Get a presigned upload URL for an artifact (file upload to S3).
  public shared (msg) func presignUpload(fileName : Text, contentType : Text, sizeBytes : Nat, corpusId : ?Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let result = await HttpOutcalls.presignUpload(apiKey, fileName, contentType, sizeBytes, corpusId, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Attach an uploaded artifact to a corpus for ingestion processing.
  public shared (msg) func addArtifactToCorpus(corpusId : Text, artifactId : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let result = await HttpOutcalls.addArtifactToCorpus(apiKey, corpusId, artifactId, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Check the ingestion/processing status of an artifact in a corpus.
  public shared (msg) func getIngestionStatus(corpusId : Text, artifactId : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let result = await HttpOutcalls.getIngestionStatus(apiKey, corpusId, artifactId, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// List all mindspaces for the authenticated user.
  public shared (msg) func listMindspaces() : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let result = await HttpOutcalls.listMindspaces(apiKey, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Create a new mindspace in MagickMind.
  public shared (msg) func createMindspace(name : Text, description : Text, corpusIds : [Text], msType : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let result = await HttpOutcalls.createMindspace(apiKey, name, description, corpusIds, msType, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  // ── MagickMind Persona API ──────────────────────────────────────

  /// Generate a system prompt for a MagickMind persona.
  public shared (msg) func mmPreparePersona(personaId : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.preparePersona(apiKey, personaId, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// List all versions (evolution snapshots) for a MagickMind persona.
  public shared (msg) func mmListPersonaVersions(personaId : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.listPersonaVersions(apiKey, personaId, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Get the active (current) version of a MagickMind persona.
  public shared (msg) func mmGetActivePersonaVersion(personaId : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.getActivePersonaVersion(apiKey, personaId, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Get the effective (runtime-blended) personality for a persona.
  public shared (msg) func mmGetEffectivePersonality(personaId : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.getEffectivePersonality(apiKey, personaId, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  // ── MagickMind Blueprint & Traits API ───────────────────────────

  /// List all persona blueprints.
  public shared (msg) func mmListBlueprints() : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.listBlueprints(apiKey, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Get a blueprint by its key name.
  public shared (msg) func mmGetBlueprintByKey(blueprintKey : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.getBlueprintByKey(apiKey, blueprintKey, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Hydrate a blueprint (expand into full trait definitions).
  public shared (msg) func mmHydrateBlueprint(blueprintId : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.hydrateBlueprint(apiKey, blueprintId, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// List all server-side traits from MagickMind.
  public shared (msg) func mmListTraits() : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.listTraits(apiKey, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  // ── MagickMind Message History & Participants ───────────────────

  /// Get paginated message history from a mindspace.
  public shared (msg) func mmGetMessages(mindspaceId : Text, limit : Nat, order : Text, cursor : ?Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.getMindspaceMessages(apiKey, mindspaceId, limit, order, cursor, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Add a participant to a mindspace.
  public shared (msg) func mmAddParticipant(mindspaceId : Text, userId : Text, role : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.addMindspaceParticipant(apiKey, mindspaceId, userId, role, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Create a persona from a blueprint on MagickMind.
  public shared (msg) func mmCreatePersonaFromBlueprint(blueprintId : Text, name : Text, description : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.createPersonaFromBlueprint(apiKey, blueprintId, name, description, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  /// Invalidate MagickMind runtime cache (force re-blend).
  public shared (msg) func mmInvalidateCache() : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #NotConfigured("Not authenticated") }; case (#ok(())) {} };
    let apiKey = switch (await getApiKey(msg.caller, "magickmind_api_key")) { case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") }; case (#ok(k)) { k } };
    switch (await HttpOutcalls.invalidateRuntimeCache(apiKey, transform)) {
      case (#ok(text)) { #Success(text) }; case (#err(#ProviderError(e))) { #Failed(e) }; case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  // ── Persona Marketplace ──────────────────────────────────────────

  // Find a persona owned by any specific principal (cross-user lookup).
  func findPersonaByOwner(owner : Principal, personaId : Text) : ?Persona {
    // Check built-in first
    switch (Array.find<Persona>(BUILT_IN_PERSONAS, func(p) { p.id == personaId })) {
      case (?p) { return ?p };
      case null {};
    };
    switch (principalOps.get(userPersonas, owner)) {
      case (?userMap) { textOps.get(userMap, personaId) };
      case null { null };
    };
  };

  func hireKey(hirer : Principal, personaId : Text) : Text {
    Principal.toText(hirer) # ":" # personaId;
  };

  func computePowerForPrice(pricePerMessage : Nat) : Nat {
    if (pricePerMessage == 0) { 30 }
    else if (pricePerMessage < 50_000) { 50 }
    else if (pricePerMessage < 200_000) { 75 }
    else { 100 };
  };

  /// Publish a persona to the marketplace for hire.
  public shared (msg) func publishPersona(
    personaId : Text,
    pricePerMessage : Nat,
    pricePerDay : Nat,
    corpusIds : [Text],
    category : Types.MarketplaceCategory,
  ) : async Types.MarketplaceOpResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #Err("Not authenticated") }; case (#ok(())) {} };
    switch (findPersonaByOwner(msg.caller, personaId)) {
      case null { return #Err("You don't own this persona") };
      case (?persona) {
        switch (textOps.get(marketplace, personaId)) {
          case (?_) { return #Err("Persona already published") };
          case null {
            let published : Types.PublishedPersona = {
              owner = msg.caller;
              personaId = personaId;
              personaName = persona.name;
              personaDescription = persona.description;
              pricePerMessage = pricePerMessage;
              pricePerDay = pricePerDay;
              totalEarnings = 0;
              hireCount = 0;
              ratingSum = 0;
              ratingCount = 0;
              corpusIds = corpusIds;
              category = category;
              isActive = true;
              publishedAt = Time.now();
            };
            marketplace := textOps.put(marketplace, personaId, published);
            #Ok("Published successfully");
          };
        };
      };
    };
  };

  /// Remove a persona from the marketplace.
  public shared (msg) func unpublishPersona(personaId : Text) : async Types.MarketplaceOpResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #Err("Not authenticated") }; case (#ok(())) {} };
    switch (textOps.get(marketplace, personaId)) {
      case null { return #Err("Persona not published") };
      case (?pub) {
        if (pub.owner != msg.caller) { return #Err("Not the owner") };
        marketplace := textOps.delete(marketplace, personaId);
        #Ok("Unpublished successfully");
      };
    };
  };

  /// Browse the marketplace for published personas.
  public shared (msg) func browseMarketplace(category : Text, sortBy : Text, offset : Nat, limit : Nat) : async [Types.MarketplaceListing] {
    let buf = Buffer.Buffer<Types.MarketplaceListing>(16);
    for ((_, pub) in textOps.entries(marketplace)) {
      if (pub.isActive) {
        let matchesCategory = category == "All" or (
          switch (pub.category) {
            case (#All) { true };
            case (#Code) { category == "Code" };
            case (#Research) { category == "Research" };
            case (#Creative) { category == "Creative" };
            case (#Business) { category == "Business" };
            case (#Coaching) { category == "Coaching" };
            case (#Custom(_)) { category == "Custom" };
          }
        );
        if (matchesCategory) {
          let avgRating = if (pub.ratingCount > 0) { (pub.ratingSum * 100) / pub.ratingCount } else { 0 };
          let traitCount = switch (principalOps.get(personaTraits, pub.owner)) {
            case null { 0 };
            case (?ownerTraits) {
              switch (textOps.get(ownerTraits, pub.personaId)) {
                case null { 0 };
                case (?pt) { pt.traits.size() };
              };
            };
          };
          buf.add({ published = pub; traitCount = traitCount; averageRating = avgRating });
        };
      };
    };
    let arr = Buffer.toArray(buf);
    let start = if (offset >= arr.size()) { arr.size() } else { offset };
    let end = if (start + limit > arr.size()) { arr.size() } else { start + limit };
    let slice = Buffer.Buffer<Types.MarketplaceListing>(limit);
    var i = start;
    while (i < end) {
      slice.add(arr[i]);
      i += 1;
    };
    Buffer.toArray(slice);
  };

  /// Hire a persona from the marketplace.
  public shared (msg) func hirePersona(personaId : Text, paymentType : Types.PaymentType) : async Types.MarketplaceOpResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #Err("Not authenticated") }; case (#ok(())) {} };
    let key = hireKey(msg.caller, personaId);
    switch (textOps.get(activeHires, key)) {
      case (?_) { return #Err("Already hired this persona") };
      case null {};
    };
    switch (textOps.get(marketplace, personaId)) {
      case null { return #Err("Persona not published") };
      case (?pub) {
        // For daily hires, require upfront payment
        switch (paymentType) {
          case (#Daily) {
            if (pub.pricePerDay == 0) { return #Err("Daily hire not available") };
            switch (walletPrincipal) {
              case null {}; // dev mode — skip payment
              case (?wp) {
                let walletActor : actor {
                  deductForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
                } = actor (Principal.toText(wp));
                switch (await walletActor.deductForRequest(msg.caller, #ICP, pub.pricePerDay)) {
                  case (#err(e)) { return #Err("Payment failed: " # e) };
                  case (#ok(())) {
                    let prev = switch (textOps.get(personaEarnings, personaId)) { case null { 0 }; case (?v) { v } };
                    personaEarnings := textOps.put(personaEarnings, personaId, prev + pub.pricePerDay);
                  };
                };
              };
            };
          };
          case (#PerMessage) {}; // pay per message — no upfront cost
        };
        let hire : Types.PersonaHire = {
          hirer = msg.caller;
          personaId = personaId;
          owner = pub.owner;
          paymentType = paymentType;
          expiresAt = switch (paymentType) {
            case (#Daily) { Time.now() + 86_400_000_000_000 }; // 24h in nanoseconds
            case (#PerMessage) { 0 };
          };
          messagesUsed = 0;
          totalPaid = switch (paymentType) { case (#Daily) { pub.pricePerDay }; case (#PerMessage) { 0 } };
          startedAt = Time.now();
        };
        activeHires := textOps.put(activeHires, key, hire);
        // Increment hire count
        marketplace := textOps.put(marketplace, personaId, {
          owner = pub.owner; personaId = pub.personaId; personaName = pub.personaName;
          personaDescription = pub.personaDescription; pricePerMessage = pub.pricePerMessage;
          pricePerDay = pub.pricePerDay; totalEarnings = pub.totalEarnings;
          hireCount = pub.hireCount + 1; ratingSum = pub.ratingSum; ratingCount = pub.ratingCount;
          corpusIds = pub.corpusIds; category = pub.category; isActive = pub.isActive;
          publishedAt = pub.publishedAt;
        });
        #Ok("Hired successfully");
      };
    };
  };

  /// End a hire of a marketplace persona.
  public shared (msg) func endHire(personaId : Text) : async Types.MarketplaceOpResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #Err("Not authenticated") }; case (#ok(())) {} };
    activeHires := textOps.delete(activeHires, hireKey(msg.caller, personaId));
    #Ok("Hire ended");
  };

  /// List all active hires for the caller.
  public shared (msg) func listMyHires() : async [Types.PersonaHire] {
    let buf = Buffer.Buffer<Types.PersonaHire>(8);
    let prefix = Principal.toText(msg.caller) # ":";
    for ((k, hire) in textOps.entries(activeHires)) {
      if (Text.startsWith(k, #text prefix)) {
        let isValid = switch (hire.paymentType) {
          case (#Daily) { Time.now() < hire.expiresAt };
          case (#PerMessage) { true };
        };
        if (isValid) { buf.add(hire) };
      };
    };
    Buffer.toArray(buf);
  };

  /// Rate a hired persona (1-5).
  public shared (msg) func ratePersona(personaId : Text, rating : Nat) : async Types.MarketplaceOpResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #Err("Not authenticated") }; case (#ok(())) {} };
    if (rating < 1 or rating > 5) { return #Err("Rating must be 1-5") };
    let rKey = hireKey(msg.caller, personaId);
    switch (textOps.get(ratingTracker, rKey)) {
      case (?true) { return #Err("Already rated") };
      case _ {};
    };
    switch (textOps.get(marketplace, personaId)) {
      case null { return #Err("Persona not published") };
      case (?pub) {
        marketplace := textOps.put(marketplace, personaId, {
          owner = pub.owner; personaId = pub.personaId; personaName = pub.personaName;
          personaDescription = pub.personaDescription; pricePerMessage = pub.pricePerMessage;
          pricePerDay = pub.pricePerDay; totalEarnings = pub.totalEarnings;
          hireCount = pub.hireCount; ratingSum = pub.ratingSum + rating;
          ratingCount = pub.ratingCount + 1; corpusIds = pub.corpusIds;
          category = pub.category; isActive = pub.isActive; publishedAt = pub.publishedAt;
        });
        ratingTracker := textOps.put(ratingTracker, rKey, true);
        #Ok("Rated successfully");
      };
    };
  };

  /// Get earnings for a persona (owner only).
  public shared (msg) func getPersonaEarnings(personaId : Text) : async Types.MarketplaceOpResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #Err("Not authenticated") }; case (#ok(())) {} };
    switch (textOps.get(marketplace, personaId)) {
      case null { return #Err("Persona not published") };
      case (?pub) {
        if (pub.owner != msg.caller) { return #Err("Not the owner") };
        let earnings = switch (textOps.get(personaEarnings, personaId)) { case null { 0 }; case (?v) { v } };
        #Ok(debug_show(earnings));
      };
    };
  };

  /// Withdraw persona earnings to owner's wallet.
  public shared (msg) func withdrawPersonaEarnings(personaId : Text, amount : Nat) : async Types.MarketplaceOpResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #Err("Not authenticated") }; case (#ok(())) {} };
    switch (textOps.get(marketplace, personaId)) {
      case null { return #Err("Persona not published") };
      case (?pub) {
        if (pub.owner != msg.caller) { return #Err("Not the owner") };
        let earnings = switch (textOps.get(personaEarnings, personaId)) { case null { 0 }; case (?v) { v } };
        if (amount > earnings) { return #Err("Insufficient earnings") };
        // Saga: debit first, then credit wallet
        personaEarnings := textOps.put(personaEarnings, personaId, earnings - amount);
        switch (walletPrincipal) {
          case null { #Ok("Withdrawn " # debug_show(amount) # " e8s (dev mode)") };
          case (?wp) {
            let walletActor : actor {
              creditForEarnings : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
            } = actor (Principal.toText(wp));
            switch (await walletActor.creditForEarnings(msg.caller, #ICP, amount)) {
              case (#ok(())) { #Ok("Withdrawn " # debug_show(amount) # " e8s") };
              case (#err(e)) {
                // Compensate: re-credit earnings
                personaEarnings := textOps.put(personaEarnings, personaId, earnings);
                #Err("Withdrawal failed: " # e);
              };
            };
          };
        };
      };
    };
  };

  /// Mint a persona as an NFT (stores metadata on-chain).
  public shared (msg) func mintPersonaNft(personaId : Text) : async Types.MarketplaceOpResult {
    switch (Auth.requireAuth(msg.caller)) { case (#err(_)) { return #Err("Not authenticated") }; case (#ok(())) {} };
    switch (findPersonaByOwner(msg.caller, personaId)) {
      case null { return #Err("You don't own this persona") };
      case (?_persona) {
        switch (textOps.get(personaNfts, personaId)) {
          case (?_) { return #Err("Already minted as NFT") };
          case null {
            nftTokenCounter += 1;
            let traitSnapshot = switch (principalOps.get(personaTraits, msg.caller)) {
              case null { [] : [PersonaTrait] };
              case (?ownerTraits) {
                switch (textOps.get(ownerTraits, personaId)) {
                  case null { [] : [PersonaTrait] };
                  case (?pt) { pt.traits };
                };
              };
            };
            let corpusRefs = switch (textOps.get(marketplace, personaId)) {
              case null { [] : [Text] };
              case (?pub) { pub.corpusIds };
            };
            let nft : Types.PersonaNftMetadata = {
              personaId = personaId;
              owner = msg.caller;
              traitSnapshot = traitSnapshot;
              corpusRefs = corpusRefs;
              mintedAt = Time.now();
              tokenId = nftTokenCounter;
            };
            personaNfts := textOps.put(personaNfts, personaId, nft);
            #Ok("Minted NFT #" # debug_show(nftTokenCounter));
          };
        };
      };
    };
  };

  /// Get NFT metadata for a persona.
  public shared (msg) func getPersonaNft(personaId : Text) : async ?Types.PersonaNftMetadata {
    textOps.get(personaNfts, personaId);
  };

  /// Delete a corpus (knowledge base) from MagickMind.
  public shared (msg) func deleteCorpus(corpusId : Text) : async Types.MemoryResult {
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #NotConfigured("Not authenticated") };
      case (#ok(())) {};
    };
    let caller = msg.caller;
    let apiKeyResult = await getApiKey(caller, "magickmind_api_key");
    let apiKey = switch (apiKeyResult) {
      case (#err(_)) { return #NotConfigured("No MagickMind API key. Add one in Settings.") };
      case (#ok(k)) { k };
    };
    let result = await HttpOutcalls.deleteCorpus(apiKey, corpusId, transform);
    switch (result) {
      case (#ok(text)) { #Success(text) };
      case (#err(#ProviderError(e))) { #Failed(e) };
      case (#err(_)) { #Failed("Unexpected error") };
    };
  };

  // These endpoints are unauthenticated query calls so monitoring tools and
  // dashboards can poll them without needing a valid identity.

  /// Return the canister's current cycle balance (raw Nat).
  /// Useful for automated top-up bots.
  public query func getCycleBalance() : async Nat {
    Cycles.balance();
  };

  /// Structured health/status endpoint. `lowCycles` is true when the balance
  /// drops below 0.5T cycles, indicating the canister needs a top-up soon.
  public query func getStatus() : async { health : Text; cycles : Nat; lowCycles : Bool } {
    let bal = Cycles.balance();
    { health = "operational"; cycles = bal; lowCycles = bal < LOW_CYCLES_THRESHOLD };
  };

  /// Simple health-check string for uptime monitors and load balancers.
  public query func health() : async Text {
    "OpenClaw Gateway v0.3.0 — operational";
  };
}
