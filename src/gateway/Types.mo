/// ============================================================================
/// OpenClaw ICP — Shared Type Definitions
/// ============================================================================
///
/// Central type module imported by all OpenClaw canisters (Gateway, KeyVault,
/// Wallet, Identity). Defines the canonical shapes for LLM models, chat
/// messages, conversations, wallet operations, identity profiles, and errors.
///
/// IMPORTANT: Changes here affect every canister. After modifying a type,
/// rebuild and redeploy ALL canisters that import it.
/// ============================================================================
module {

  // ── LLM Provider & Model Types ──────────────────────────────────

  /// Which backend provider services an LLM request.
  /// Used internally by LlmRouter to select the correct HTTPS outcall target.
  public type Provider = {
    #OnChain;    // DFINITY mo:llm (runs on-chain, no API key needed)
    #Anthropic;  // Anthropic Messages API (api.anthropic.com)
    #OpenAI;     // OpenAI Chat Completions API (api.openai.com)
  };

  /// On-chain models available via DFINITY's mo:llm package.
  /// These run directly on the IC subnet — free, no API key, mainnet only.
  public type OnChainModel = {
    #Llama3_1_8B;   // Meta Llama 3.1 8B — fast, lightweight
    #Qwen3_32B;     // Alibaba Qwen 3 32B — strong multilingual reasoning
    #Llama4Scout;   // Meta Llama 4 Scout — latest generation
  };

  /// External models accessed via HTTPS outcalls to third-party APIs.
  /// Each requires a corresponding API key stored in KeyVault.
  public type ExternalModel = {
    #Claude_Sonnet;      // Anthropic Claude Sonnet 4 — balanced quality/speed
    #Claude_Haiku;       // Anthropic Claude Haiku 4.5 — fastest, cheapest
    #GPT4o;              // OpenAI GPT-4o — multimodal flagship
    #GPT4oMini;          // OpenAI GPT-4o Mini — budget option
    #MagickMind_Brain;   // MagickMind Brain — ICP-native AI (magickmind.ai)
  };

  /// Top-level model selector: on-chain (free) vs external (paid, needs API key).
  public type Model = {
    #OnChain : OnChainModel;
    #External : ExternalModel;
  };

  // ── Chat Message Types ──────────────────────────────────────────

  /// Standard chat roles. `#system_` has a trailing underscore because
  /// "system" is a reserved keyword in some Candid contexts.
  public type Role = {
    #system_;     // System prompt — sets AI behavior/persona
    #user;        // Human user input
    #assistant;   // AI-generated response
  };

  /// A single message in a conversation thread.
  public type Message = {
    role : Role;
    content : Text;   // UTF-8 message body (max ~32 KB enforced by LlmRouter)
  };

  // ── Conversation Types ──────────────────────────────────────────

  /// Opaque conversation identifier (monotonically increasing counter as text).
  public type ConversationId = Text;

  /// Full conversation record stored per-user in the Gateway canister.
  /// Contains the complete message history for context continuity.
  public type Conversation = {
    id : ConversationId;
    owner : Principal;        // The user who created this conversation
    model : Model;            // Which LLM model is being used
    messages : [Message];     // Full ordered message history
    createdAt : Int;          // Nanosecond timestamp (Time.now())
    updatedAt : Int;          // Updated on each new message
    mindspaceId : ?Text;      // MagickMind mindspace for this conversation (null for non-MM models)
  };

  /// Lightweight view of a conversation for list endpoints.
  /// Omits the full message array to reduce payload size.
  public type ConversationSummary = {
    id : ConversationId;
    model : Model;
    updatedAt : Int;
    messageCount : Nat;
    title : Text;       // First user message, truncated to 60 chars
    preview : Text;     // Last assistant message, truncated to 100 chars
    mindspaceId : ?Text; // MagickMind mindspace (null for non-MM models)
  };

  /// Export format for conversation export.
  public type ExportFormat = { #JSON; #Markdown };

  // ── Request / Response Types ────────────────────────────────────

  /// Client-to-Gateway prompt request. The frontend sends this to initiate
  /// or continue a conversation with a selected LLM model.
  public type PromptRequest = {
    conversationId : ?ConversationId;  // null = start new conversation
    model : Model;                      // Which model to route to
    message : Text;                     // The user's message
    systemPrompt : ?Text;               // Optional system prompt (only applied to new conversations)
    apiKey : ?Text;                     // Optional: client-decrypted API key for external models
    mindspaceId : ?Text;                // Optional: override the default mindspace for this conversation
  };

  /// Gateway-to-Client response after a successful LLM call.
  public type PromptResponse = {
    conversationId : ConversationId;   // The conversation this reply belongs to
    reply : Text;                       // The AI's response text
    model : Model;                      // Which model generated the reply
    tokensUsed : ?Nat;                  // Token usage (not yet implemented — always null)
    mindspaceId : ?Text;                // The mindspace used for this response (null for non-MM models)
  };

  // ── Error Types ─────────────────────────────────────────────────

  /// Unified error type returned by Gateway public methods.
  /// Each variant maps to a specific failure mode with an appropriate
  /// error message for the frontend to display.
  public type OpenClawError = {
    #NotAuthenticated;          // Caller is anonymous (not logged in)
    #ConversationNotFound;      // Conversation ID doesn't exist or belongs to another user
    #ProviderError : Text;      // LLM provider returned an error (includes raw error details)
    #ApiKeyNotFound : Text;     // No API key found in KeyVault for the required provider
    #InsufficientBalance;       // User's wallet balance too low for the request fee
    #WalletError : Text;        // Wallet canister returned an error during payment
    #CycleBudgetExceeded;       // Canister running low on cycles
    #ResponseTooLarge;          // LLM response exceeded MAX_RESPONSE_BYTES (100 KB)
    #Timeout;                   // HTTPS outcall timed out
    #AlreadyProcessing;         // Reentrancy guard: user already has an in-flight request
    #InvalidInput : Text;       // Validation failure (message too long, too many messages, etc.)
  };

  // ── System Prompt Template Types ────────────────────────────────

  /// Reusable system prompt template. Built-in templates are hardcoded in the
  /// Gateway canister; user-created templates are stored per-principal.
  public type SystemPromptTemplate = {
    id : Text;            // Unique identifier (e.g. "builtin_code" or generated)
    name : Text;          // Display name (max 60 chars)
    content : Text;       // The actual system prompt text (max 2000 chars)
    isBuiltIn : Bool;     // true = hardcoded, false = user-created
    createdAt : Int;      // Nanosecond timestamp (0 for built-in)
  };

  // ── MagickMind Configuration Types ─────────────────────────────

  /// MagickMind brain mode selection. Controls the response quality/speed tradeoff.
  /// Fast Brain returns quicker, lighter responses; Smart Brain uses deeper
  /// context processing for more thoughtful replies.
  public type MagickMindBrainMode = {
    #Fast;   // Quick responses, lower latency
    #Smart;  // Deeper context processing, higher quality
  };

  /// Per-user MagickMind configuration. Stored in the Gateway canister and
  /// applied automatically when routing requests to MagickMind's API.
  /// Users configure this via setMagickMindConfig / getMagickMindConfig.
  public type MagickMindConfig = {
    mindspaceId : Text;              // Default mindspace for new conversations
    brainMode : MagickMindBrainMode; // Fast or Smart brain mode
    fastModelId : Text;              // e.g. "gpt-4o-mini"
    smartModelIds : [Text];          // e.g. ["claude-sonnet-4", "gpt-4o"]
    computePower : Nat;              // 0-100
  };

  // ── Persona Types ──────────────────────────────────────────────

  /// An AI persona that defines personality, tone, and behavior for MagickMind conversations.
  /// When a persona is active, its compiled prompt is prepended as a system message.
  public type Persona = {
    id : Text;                // Unique identifier (generated)
    name : Text;              // Display name (max 50 chars), e.g. "Code Guru"
    avatar : Text;            // Single emoji for visual identity, e.g. "🧙"
    description : Text;       // Short tagline (max 200 chars), e.g. "Expert software architect"
    personality : Text;       // Core personality traits (max 500 chars)
    tone : Text;              // Communication style (max 200 chars), e.g. "Professional but friendly"
    expertise : [Text];       // Areas of expertise (max 10, each max 50 chars)
    instructions : Text;      // Custom behavioral instructions (max 1000 chars)
    isBuiltIn : Bool;         // true = system-provided, false = user-created
    createdAt : Int;          // Nanosecond timestamp
    updatedAt : Int;          // Nanosecond timestamp
  };

  // ── MagickMind Trait Types (aligned with MagickMind SDK) ────────

  /// Trait value type — matches MagickMind's polymorphic trait system.
  public type TraitType = {
    #Numeric;      // 0-100 scale (MagickMind uses float, we use Nat for ICP)
    #Categorical;  // Pick one from options
    #Multilabel;   // Pick multiple from options
  };

  /// Lock level — controls whether a trait can evolve.
  public type TraitLock = {
    #Hard;  // Immutable — trait value cannot change
    #Soft;  // Can evolve through interactions
  };

  /// A single personality trait definition.
  public type PersonaTrait = {
    name : Text;           // e.g. "empathy", "formality", "humor"
    displayName : Text;    // Human-readable: "Empathy Level"
    traitType : TraitType;
    description : Text;    // What this trait controls
    // Values (use the one matching traitType)
    numericValue : ?Nat;           // 0-100 for Numeric traits
    categoricalValue : ?Text;      // Selected option for Categorical
    multilabelValue : [Text];      // Selected options for Multilabel
    // Configuration
    options : [Text];              // Available options (for Categorical/Multilabel)
    minValue : Nat;                // Min bound for Numeric (usually 0)
    maxValue : Nat;                // Max bound for Numeric (usually 100)
    defaultValue : Nat;            // Default for Numeric
    lock : TraitLock;              // Hard or Soft
    learningRate : Nat;            // 0-100 (0 = no learning, 100 = fast)
    supportsDyadic : Bool;         // Can adapt per-relationship
    category : Text;               // Grouping: "personality", "communication", "behavior"
  };

  /// Growth type — how the persona evolves over time.
  public type GrowthType = {
    #Fixed;         // No change
    #Expanding;     // Grows
    #Corrupting;    // Degrades
    #Redeeming;     // Improves
    #Transcending;  // Evolves beyond bounds
  };

  /// Per-domain growth rates.
  public type DomainRates = {
    identity : Nat;   // 0-100
    narrative : Nat;  // 0-100
    behavior : Nat;   // 0-100
  };

  /// Growth trigger — condition that modifies evolution rate.
  public type GrowthTrigger = {
    id : Text;
    condition : Text;         // Keyword or pattern to match
    affectedTraits : [Text];  // Which trait names are affected
    rateMultiplier : Nat;     // Multiplier (100 = 1x, 200 = 2x)
    direction : { #TowardTarget; #AwayFromTarget; #Normal };
  };

  /// Goal state — target personality configuration traits are attracted toward.
  public type GoalState = {
    id : Text;
    description : Text;
    traitTargets : [(Text, Nat)]; // (traitName, targetValue) pairs
    attractionStrength : Nat;     // 0-100
  };

  /// Boundary — hard limits on trait evolution.
  public type TraitBoundary = {
    traitName : Text;
    minValue : Nat;
    maxValue : Nat;
    reason : Text;
  };

  /// Full growth configuration for a persona.
  public type GrowthConfig = {
    growthType : GrowthType;
    domainRates : DomainRates;
    triggers : [GrowthTrigger];
    goalStates : [GoalState];
    boundaries : [TraitBoundary];
  };

  /// Multi-LLM configuration for MagickMind's Smart Brain.
  public type MultiLlmConfig = {
    fastModelId : Text;           // Model for Fast Brain (e.g. "gpt-4o-mini")
    smartModelIds : [Text];       // Models for Smart Brain synthesis
    computePower : Nat;           // 0-100 balance (0 = all speed, 100 = all depth)
  };

  /// Extended persona configuration with traits, growth, and multi-LLM settings.
  public type PersonaTraits = {
    personaId : Text;
    traits : [PersonaTrait];
    growthConfig : GrowthConfig;
    multiLlmConfig : ?MultiLlmConfig;
    evolutionHistory : [TraitSnapshot];
    lastEvolvedAt : Int;
  };

  /// Point-in-time snapshot of trait values.
  public type TraitSnapshot = {
    traits : [PersonaTrait];
    timestamp : Int;
    trigger : Text;
  };

  // ── Group Chat Types ──────────────────────────────────────────

  /// Turn order for group conversations.
  public type TurnOrder = {
    #RoundRobin;
    #Facilitator : Text;  // personaId of the facilitator
    #FreeForm;
  };

  /// Group chat configuration.
  public type GroupChat = {
    id : Text;
    name : Text;
    personaIds : [Text];
    turnOrder : TurnOrder;
    facilitatorId : ?Text;
    invitedUsers : [Principal];   // Other humans invited to the chat
    createdAt : Int;
    updatedAt : Int;
  };

  /// A message in a group chat identifying which persona or user sent it.
  public type GroupMessage = {
    role : Role;
    content : Text;
    personaId : ?Text;
    personaName : ?Text;
    personaAvatar : ?Text;
    targetPersonaId : ?Text;   // If @mentioning a specific persona
    senderPrincipal : ?Principal; // If sent by a human (not the owner)
  };

  /// Group chat prompt request.
  public type GroupPromptRequest = {
    groupId : Text;
    conversationId : ?ConversationId;
    message : Text;
    mindspaceId : ?Text;
    targetPersonaId : ?Text;   // @mention — only this persona responds
  };

  /// Group chat prompt response.
  public type GroupPromptResponse = {
    conversationId : ConversationId;
    responses : [GroupMessage];
  };

  // ── Dual Prompt & Compare Types ─────────────────────────────────

  /// Response from dualPrompt — returns both fast and smart replies.
  public type DualPromptResponse = {
    conversationId : ConversationId;
    fastReply : Text;
    smartReply : Text;
    model : Model;
    mindspaceId : ?Text;
  };

  /// Request for compareModels — sends the same message to multiple models.
  public type CompareRequest = {
    message : Text;
    modelIds : [Text];          // e.g. ["gpt-4o", "claude-sonnet-4", "openrouter/meta-llama/llama-4-maverick"]
    conversationId : ?ConversationId;
    systemPrompt : ?Text;
    mindspaceId : ?Text;
  };

  /// A single model's response in a comparison.
  public type ModelResponse = {
    modelId : Text;
    reply : Text;
  };

  /// Response from compareModels — one reply per model.
  public type CompareResponse = {
    conversationId : ConversationId;
    responses : [ModelResponse];
  };

  // ── Email Types (Phase 5 — not yet implemented) ─────────────────

  /// Supported email service providers for agent communication.
  public type EmailProvider = {
    #Resend;      // resend.com — primary (native idempotency)
    #SendGrid;    // legacy fallback
  };

  /// Outbound email message structure.
  public type EmailMessage = {
    to : Text;          // Recipient email address
    subject : Text;
    body : Text;        // Plain text or HTML body (see isHtml flag)
    isHtml : Bool;      // true = body contains HTML markup
    provider : EmailProvider;
  };

  /// SMS message for Twilio delivery.
  public type SmsMessage = {
    to : Text;         // E.164 phone number (+1234567890)
    body : Text;       // SMS body (max 1600 chars)
  };

  /// Result of a communication operation (email/SMS send).
  public type CommResult = {
    #Sent : Text;           // Success with detail
    #Failed : Text;         // Error description
    #NotConfigured : Text;  // Missing API key or config
  };

  /// Reusable email template stored on-chain.
  public type EmailTemplate = {
    id : Text;
    name : Text;
    subject : Text;
    htmlBody : Text;    // HTML template with placeholder tokens
    createdAt : Int;
    updatedAt : Int;
  };

  // ── ICRC-1 Types ───────────────────────────────────────────────

  /// Standard ICP account: a principal + optional 32-byte subaccount.
  /// Subaccounts are used by the Wallet canister to give each user a
  /// unique deposit address (see Wallet.userSubaccount).
  public type Account = {
    owner : Principal;
    subaccount : ?Blob;   // 32 bytes; null = default subaccount
  };

  /// ICRC-1 transfer error variants — mirrors the ledger canister interface.
  public type ICRC1TransferError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  // ── Wallet Types ────────────────────────────────────────────────

  /// Supported token types for wallet operations.
  /// Each maps to a specific ICRC-1 ledger canister on mainnet.
  public type TokenType = {
    #ICP;      // ICP native token (ryjl3-tyaaa-aaaaa-aaaba-cai)
    #ckUSDC;   // Chain-key USDC (xevnm-gaaaa-aaaar-qafnq-cai)
    #ckBTC;    // Chain-key Bitcoin (mxzaz-hqaaa-aaaar-qaada-cai)
  };

  /// Categories of wallet transactions for history tracking.
  public type TransactionType = {
    #Deposit;      // User deposited tokens into their OpenClaw wallet
    #Withdrawal;   // User withdrew tokens to an external address
    #LlmFee;       // Automatic deduction for an external LLM request
    #Refund;       // Fee refunded after a failed LLM request (saga compensation)
  };

  /// A single transaction record in the user's wallet history.
  /// Capped at MAX_TRANSACTIONS_PER_USER (1000) per user, oldest pruned first.
  public type TransactionRecord = {
    id : Nat;                     // Monotonically increasing transaction ID
    tokenType : TokenType;
    amount : Nat;                 // Amount in smallest units (e8s for ICP, satoshis for ckBTC)
    txType : TransactionType;
    counterparty : ?Principal;    // null for LLM fees/refunds
    memo : ?Text;                 // Human-readable description
    timestamp : Int;              // Nanosecond timestamp
  };

  // ── Identity Types ──────────────────────────────────────────────

  /// On-chain agent profile representing a user's AI agent identity.
  /// Created via the Identity canister; prompt count incremented by Gateway.
  public type AgentProfile = {
    owner : Principal;          // The principal who owns this profile
    displayName : Text;         // Human-readable name (max 100 chars)
    description : Text;         // Bio / purpose description (max 500 chars)
    capabilities : [Text];      // Tags like "code-review", "research" (max 20, each max 50 chars)
    reputation : Nat;           // Reputation score (not yet incremented — always 0)
    totalPrompts : Nat;         // Lifetime prompt count (incremented by Gateway after each call)
    createdAt : Int;            // Profile creation timestamp
    updatedAt : Int;            // Last modification timestamp
  };

  // ── MagickMind Memory Types ─────────────────────────────────────

  /// RAG query mode for corpus search.
  public type CorpusQueryMode = { #Naive; #Local; #Global; #Hybrid };

  /// A corpus (knowledge base) in MagickMind.
  public type MmCorpus = {
    id : Text;
    name : Text;
    description : Text;
    artifactIds : [Text];
    createdAt : Text;
  };

  /// An artifact (uploaded file) in MagickMind.
  public type MmArtifact = {
    id : Text;
    fileName : Text;
    contentType : Text;
    sizeBytes : Nat;
    status : Text;  // "pending", "processing", "processed", "failed"
    corpusId : ?Text;
  };

  /// Presigned upload URL response.
  public type PresignResponse = {
    artifactId : Text;
    uploadUrl : Text;
    expiresAt : Nat;
  };

  /// Ingestion status for an artifact in a corpus.
  public type IngestionStatus = {
    artifactId : Text;
    status : Text;
    contentSummary : ?Text;
    error : ?Text;
  };

  /// Corpus query result.
  public type CorpusQueryResult = {
    result : Text;  // The RAG response or raw chunks
  };

  /// Composed context from prepare_context().
  public type ComposedContext = {
    mindspaceId : Text;
    chatHistory : [ContextMessage];
    corpusChunks : [Text];       // RAG-retrieved chunks
    episodicMemory : Text;        // Pelican result
  };

  /// A message from context history.
  public type ContextMessage = {
    id : Text;
    content : Text;
    senderId : Text;
    messageType : Text;
    createdAt : Text;
  };

  /// Mindspace info.
  public type MmMindspace = {
    id : Text;
    name : Text;
    description : Text;
    corpusIds : [Text];
    participantIds : [Text];
    mindspaceType : Text;  // "PRIVATE" or "GROUP"
    createdAt : Text;
  };

  // ── MagickMind Persona API Types ────────────────────────────────

  /// Server-side persona (from MagickMind API).
  public type MmPersona = {
    id : Text;
    name : Text;
    description : Text;
    blueprintId : ?Text;
    projectId : Text;
    createdAt : Text;
  };

  /// Persona version (evolution snapshot).
  public type MmPersonaVersion = {
    id : Text;
    personaId : Text;
    version : Nat;
    systemPrompt : Text;
    traits : Text; // JSON blob of trait values
    createdAt : Text;
  };

  /// Effective personality (runtime-blended result).
  public type MmEffectivePersonality = {
    personaId : Text;
    systemPrompt : Text;
    traits : Text; // JSON blob
    blendedAt : Text;
  };

  // ── MagickMind Blueprint Types ──────────────────────────────────

  /// A persona blueprint template.
  public type MmBlueprint = {
    id : Text;
    key : Text;
    name : Text;
    description : Text;
    traits : Text; // JSON blob of trait definitions
    createdAt : Text;
  };

  /// A trait definition from the server.
  public type MmTrait = {
    id : Text;
    name : Text;
    traitType : Text;
    description : Text;
    category : Text;
    options : Text; // JSON array
    defaultValue : Text;
  };

  // ── MagickMind Message History Types ────────────────────────────

  /// Paginated messages from a mindspace.
  public type MmMessagePage = {
    messages : Text; // JSON array of messages
    hasMore : Bool;
    cursor : ?Text;
  };

  // ── Temporal Memory Query ───────────────────────────────────────

  /// Temporal preset for smart episodic memory queries.
  public type TemporalPreset = {
    #Today;
    #ThisWeek;
    #ThisMonth;
    #ThisYear;
    #AllTime;
    #Custom; // uses the freeform query
  };

  /// Memory result wrapper.
  public type MemoryResult = {
    #Success : Text;     // JSON string result
    #Failed : Text;      // Error message
    #NotConfigured : Text;
  };

  // ── Persona Marketplace Types ─────────────────────────────────

  /// Payment model for hired personas.
  public type PaymentType = { #PerMessage; #Daily };

  /// Category for marketplace filtering.
  public type MarketplaceCategory = { #All; #Code; #Research; #Creative; #Business; #Coaching; #Custom : Text };

  /// A persona listed on the marketplace.
  public type PublishedPersona = {
    owner : Principal;
    personaId : Text;
    personaName : Text;
    personaDescription : Text;
    pricePerMessage : Nat;   // in e8s (1 ICP = 100_000_000 e8s)
    pricePerDay : Nat;       // in e8s (0 = daily hire not available)
    totalEarnings : Nat;
    hireCount : Nat;
    ratingSum : Nat;
    ratingCount : Nat;
    corpusIds : [Text];      // knowledge bases accessible when hired
    category : MarketplaceCategory;
    isActive : Bool;
    publishedAt : Int;
  };

  /// An active hire of a marketplace persona.
  public type PersonaHire = {
    hirer : Principal;
    personaId : Text;
    owner : Principal;
    paymentType : PaymentType;
    expiresAt : Int;    // 0 for per-message, nanosecond timestamp for daily
    messagesUsed : Nat;
    totalPaid : Nat;
    startedAt : Int;
  };

  /// NFT metadata for a minted persona.
  public type PersonaNftMetadata = {
    personaId : Text;
    owner : Principal;
    traitSnapshot : [PersonaTrait];
    corpusRefs : [Text];
    mintedAt : Int;
    tokenId : Nat;
  };

  /// Marketplace listing (published persona + computed display info).
  public type MarketplaceListing = {
    published : PublishedPersona;
    traitCount : Nat;
    averageRating : Nat;  // rating * 100 (e.g. 450 = 4.5 stars)
  };

  /// Marketplace operation result.
  public type MarketplaceOpResult = {
    #Ok : Text;
    #Err : Text;
  };
}
