/// OpenClaw ICP — Gateway Canister
/// Core orchestrator: auth, prompt routing, conversation history, HTTPS outcalls
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Nat "mo:base/Nat";
import Text "mo:base/Text";
import Time "mo:base/Time";
import Result "mo:base/Result";
import Buffer "mo:base/Buffer";

import IC "mo:ic";

import Types "Types";
import Auth "Auth";
import LlmRouter "LlmRouter";

persistent actor class Gateway(deployer : Principal) {

  // ── Type aliases ────────────────────────────────────────────────
  type ConversationId = Types.ConversationId;
  type Conversation = Types.Conversation;
  type Message = Types.Message;
  type PromptRequest = Types.PromptRequest;
  type PromptResponse = Types.PromptResponse;
  type OpenClawError = Types.OpenClawError;
  type ConversationSummary = Types.ConversationSummary;

  // ── Constants ─────────────────────────────────────────────────
  let MAX_CONVERSATIONS_PER_USER : Nat = 100;
  let MAX_MESSAGES_PER_CONVERSATION : Nat = 200;

  // ── Persistent state ────────────────────────────────────────────

  transient let principalOps = Map.Make<Principal>(Principal.compare);
  transient let textOps = Map.Make<Text>(Text.compare);

  var userConversations : Map.Map<Principal, Map.Map<Text, Conversation>> = principalOps.empty();
  var nonceCounter : Nat = 0;
  var keyVaultPrincipal : ?Principal = null;
  var walletPrincipal : ?Principal = null;
  var identityPrincipal : ?Principal = null;

  // Pay-per-request fee for external LLM calls (in e8s for ICP)
  var externalRequestFee : Nat = 10_000; // 0.0001 ICP default

  // Admin is the deployer — immutable after construction
  let admin : Principal = deployer;

  // ── Transient state ───────────────────────────────────────────
  transient let guard = Auth.CallerGuard();

  // ── Helper functions ──────────────────────────────────────────

  func generateId() : Text {
    nonceCounter += 1;
    Nat.toText(nonceCounter);
  };

  func generateIdempotencyKey() : Text {
    nonceCounter += 1;
    "openclaw-gw-" # Nat.toText(nonceCounter);
  };

  func getOrCreateUserMap(caller : Principal) : Map.Map<Text, Conversation> {
    switch (principalOps.get(userConversations, caller)) {
      case (?convMap) { convMap };
      case null { textOps.empty() };
    };
  };

  func requireAdmin(caller : Principal) : Result.Result<(), OpenClawError> {
    if (caller != admin) {
      #err(#NotAuthenticated);
    } else {
      #ok(());
    };
  };

  // ── Transform function for HTTPS outcall consensus ────────────
  public shared query func transform({
    context : Blob;
    response : IC.HttpRequestResult;
  }) : async IC.HttpRequestResult {
    ignore context;
    {
      status = response.status;
      headers = [];
      body = response.body;
    };
  };

  // ── Admin API ─────────────────────────────────────────────────

  /// Set the KeyVault canister principal (admin only)
  public shared (msg) func setKeyVault(kvPrincipal : Principal) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    keyVaultPrincipal := ?kvPrincipal;
    #ok(());
  };

  /// Set the Wallet canister principal (admin only)
  public shared (msg) func setWallet(wp : Principal) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    walletPrincipal := ?wp;
    #ok(());
  };

  /// Set the Identity canister principal (admin only)
  public shared (msg) func setIdentity(ip : Principal) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    identityPrincipal := ?ip;
    #ok(());
  };

  /// Set the fee for external LLM requests (admin only, in e8s)
  public shared (msg) func setRequestFee(fee : Nat) : async Result.Result<(), OpenClawError> {
    switch (requireAdmin(msg.caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };
    externalRequestFee := fee;
    #ok(());
  };

  // ── KeyVault Integration ──────────────────────────────────────

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

  /// Send a prompt to an LLM and get a response
  public shared (msg) func prompt(req : PromptRequest) : async Result.Result<PromptResponse, OpenClawError> {
    // 1. Auth check
    switch (Auth.requireAuth(msg.caller)) {
      case (#err(_)) { return #err(#NotAuthenticated) };
      case (#ok(())) {};
    };

    // 2. Reentrancy guard
    switch (guard.acquire(msg.caller)) {
      case (#err(_)) { return #err(#AlreadyProcessing) };
      case (#ok(())) {};
    };

    // Guard MUST be released in all paths — use try/finally
    try {
      // 3. Resolve or create conversation
      let convId = switch (req.conversationId) {
        case (?id) { id };
        case null { generateId() };
      };

      let userMap = getOrCreateUserMap(msg.caller);
      let now = Time.now();

      // Check conversation limit for new conversations
      switch (textOps.get(userMap, convId)) {
        case null {
          if (textOps.size(userMap) >= MAX_CONVERSATIONS_PER_USER) {
            return #err(#InvalidInput("Too many conversations: max " # debug_show(MAX_CONVERSATIONS_PER_USER)));
          };
        };
        case _ {};
      };

      let (existingMessages, isNew) = switch (textOps.get(userMap, convId)) {
        case (?conv) {
          if (conv.owner != msg.caller) {
            return #err(#ConversationNotFound);
          };
          // Check message limit
          if (conv.messages.size() >= MAX_MESSAGES_PER_CONVERSATION) {
            return #err(#InvalidInput("Conversation too long: max " # debug_show(MAX_MESSAGES_PER_CONVERSATION) # " messages"));
          };
          (conv.messages, false);
        };
        case null { ([], true) };
      };

      // 4. Build message list
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

      // 5. Capture caller before any await (S7)
      let caller = msg.caller;
      let allMessages = Buffer.toArray(messagesBuf);
      let idempotencyKey = generateIdempotencyKey();

      // Determine if this is an external model (requires payment)
      let isExternal = switch (req.model) { case (#External(_)) true; case _ false };

      // 5a. For external models: resolve API key FIRST (before deducting payment)
      var resolvedApiKey : ?Text = null;
      switch (req.model) {
        case (#External(externalModel)) {
          let apiKey = switch (req.apiKey) {
            case (?key) { key };
            case null {
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

      // 5b. Deduct payment for external models (after API key confirmed)
      var paymentDeducted = false;
      if (isExternal and externalRequestFee > 0) {
        switch (walletPrincipal) {
          case null {}; // wallet not configured — skip payment (local dev)
          case (?wp) {
            let walletActor : actor {
              deductForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
            } = actor (Principal.toText(wp));
            let deductResult = await walletActor.deductForRequest(caller, #ICP, externalRequestFee);
            switch (deductResult) {
              case (#err(_)) { return #err(#InsufficientBalance) };
              case (#ok(())) { paymentDeducted := true };
            };
          };
        };
      };

      // 6. Route to LLM
      let routeResult = switch (req.model) {
        case (#OnChain(onChainModel)) {
          await LlmRouter.routeOnChain(onChainModel, allMessages);
        };
        case (#External(externalModel)) {
          let apiKey = switch (resolvedApiKey) {
            case (?k) { k };
            case null { return #err(#ApiKeyNotFound("No API key resolved")) };
          };
          await LlmRouter.routeExternal(
            externalModel,
            allMessages,
            apiKey,
            idempotencyKey,
            Principal.toText(caller),
            transform,
          );
        };
      };

      let reply = switch (routeResult) {
        case (#ok(text)) { text };
        case (#err(e)) {
          // REFUND on LLM failure if we already deducted
          if (paymentDeducted) {
            switch (walletPrincipal) {
              case (?wp) {
                let walletActor : actor {
                  refundForRequest : (Principal, Types.TokenType, Nat) -> async Result.Result<(), Text>;
                } = actor (Principal.toText(wp));
                try { ignore await walletActor.refundForRequest(caller, #ICP, externalRequestFee) }
                catch (_) {}; // best-effort refund
              };
              case null {};
            };
          };
          return #err(e);
        };
      };

      // 7. Add assistant response
      messagesBuf.add({ role = #assistant; content = reply });

      // 8. Increment prompt count on Identity (best-effort, fire-and-forget)
      switch (identityPrincipal) {
        case null {};
        case (?ip) {
          let identityActor : actor {
            incrementPromptCount : (Principal) -> async ();
          } = actor (Principal.toText(ip));
          try { await identityActor.incrementPromptCount(caller) } catch (_) {};
        };
      };

      // 9. Save conversation
      let updatedConv : Conversation = {
        id = convId;
        owner = msg.caller;
        model = req.model;
        messages = Buffer.toArray(messagesBuf);
        createdAt = if (isNew) { now } else {
          switch (textOps.get(userMap, convId)) {
            case (?c) { c.createdAt };
            case null { now };
          };
        };
        updatedAt = now;
      };

      let updatedUserMap = textOps.put(userMap, convId, updatedConv);
      userConversations := principalOps.put(userConversations, msg.caller, updatedUserMap);

      #ok({
        conversationId = convId;
        reply = reply;
        model = req.model;
        tokensUsed = null;
      });
    } catch (_) {
      #err(#ProviderError("Internal error"));
    } finally {
      guard.release(msg.caller);
    };
  };

  /// Get a specific conversation
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

  /// List all conversations for the caller
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
      });
    };

    #ok(Buffer.toArray(buf));
  };

  /// Delete a conversation
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

  /// Health check
  public query func health() : async Text {
    "OpenClaw Gateway v0.3.0 — operational";
  };
}
