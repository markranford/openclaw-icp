/// OpenClaw ICP — LLM Router
///
/// This module decides HOW a prompt gets answered. There are two routing paths:
///
///   1. **On-chain** — uses the DFINITY `mo:llm` library to call the subnet-local
///      LLM inference endpoint. This is free (no API key or payment needed) but
///      only works on mainnet (ic0.app). The on-chain path converts our internal
///      Message type to the `mo:llm` ChatMessage format and calls `LLM.chat()`.
///
///   2. **External** — makes HTTPS outcalls to third-party APIs (Anthropic,
///      OpenAI, MagickMind). This path requires an API key (from the request or
///      KeyVault) and incurs a per-request fee. The actual HTTP plumbing is
///      delegated to HttpOutcalls.mo; this module handles provider selection,
///      model-string mapping, and the MagickMind format difference.
///
/// Validation is applied to both paths: max 50 messages per request and max
/// 32 KB total prompt size, protecting the canister from oversized payloads.
///
/// Provider mapping for API key resolution (used by Gateway.getApiKey):
///   - Claude_Sonnet, Claude_Haiku   -> "anthropic_api_key"
///   - GPT4o, GPT4oMini              -> "openai_api_key"
///   - MagickMind_Brain              -> "magickmind_api_key"
import Types "Types";
import Result "mo:base/Result";
import Array "mo:base/Array";
import Text "mo:base/Text";
import Principal "mo:base/Principal";
import LLM "mo:llm";
import IC "mo:ic";

import HttpOutcalls "HttpOutcalls";

module {

  type Message = Types.Message;
  type OnChainModel = Types.OnChainModel;
  type ExternalModel = Types.ExternalModel;
  type OpenClawError = Types.OpenClawError;
  type MagickMindConfig = Types.MagickMindConfig;

  // ── Constants ───────────────────────────────────────────────────
  // These limits protect the canister from oversized payloads that could
  // exhaust cycles or hit HTTPS outcall body size limits.
  let MAX_MESSAGES : Nat = 50;          // Max messages per single LLM request
  let MAX_PROMPT_BYTES : Nat = 32_768;  // 32 KB total across all messages

  // ── Helpers ─────────────────────────────────────────────────────

  // Convert our internal Message type to the mo:llm ChatMessage variant type.
  // The mo:llm library uses a tagged union: #system_, #user, #assistant, each
  // with different fields. Our Message type is simpler (role + content), so we
  // map between them here. Note: #assistant requires an optional content and
  // an empty tool_calls array (tool calling not yet supported by OpenClaw).
  func convertMessage(msg : Message) : LLM.ChatMessage {
    switch (msg.role) {
      case (#system_) { #system_ { content = msg.content } };
      case (#user) { #user { content = msg.content } };
      case (#assistant) { #assistant { content = ?msg.content; tool_calls = [] } };
    };
  };

  // Batch-convert an array of Messages to mo:llm ChatMessages.
  func convertMessages(messages : [Message]) : [LLM.ChatMessage] {
    Array.map<Message, LLM.ChatMessage>(messages, convertMessage);
  };

  // Sum the byte length of all message contents. Used to enforce the 32 KB
  // prompt size limit. Note: Text.size returns UTF-8 byte count in Motoko.
  func totalPromptSize(messages : [Message]) : Nat {
    var total : Nat = 0;
    for (msg in messages.vals()) {
      total += Text.size(msg.content);
    };
    total;
  };

  // Validate that the message array is within acceptable bounds before sending
  // to any LLM provider. Returns #err with a descriptive message on violation.
  func validateMessages(messages : [Message]) : Result.Result<(), OpenClawError> {
    if (messages.size() > MAX_MESSAGES) {
      return #err(#InvalidInput("Too many messages: max " # debug_show(MAX_MESSAGES)));
    };
    if (totalPromptSize(messages) > MAX_PROMPT_BYTES) {
      return #err(#InvalidInput("Prompt too large: max 32 KB"));
    };
    #ok(());
  };

  /// Map an ExternalModel variant to the exact model string expected by the
  /// provider's API (e.g. #Claude_Sonnet -> "claude-sonnet-4-20250514").
  func externalModelToApiString(model : ExternalModel) : Text {
    switch (model) {
      case (#Claude_Sonnet) { "claude-sonnet-4-20250514" };
      case (#Claude_Haiku) { "claude-haiku-4-5-20251001" };
      case (#GPT4o) { "gpt-4o" };
      case (#GPT4oMini) { "gpt-4o-mini" };
      case (#MagickMind_Brain) { "magickmind" };
    };
  };

  /// Determine the provider backend for a given external model variant.
  /// Used for both API key resolution (providerKeyId) and request routing.
  func getProvider(model : ExternalModel) : { #Anthropic; #OpenAI; #MagickMind } {
    switch (model) {
      case (#Claude_Sonnet or #Claude_Haiku) { #Anthropic };
      case (#GPT4o or #GPT4oMini) { #OpenAI };
      case (#MagickMind_Brain) { #MagickMind };
    };
  };

  /// Map a model to its KeyVault key ID string. The Gateway uses this to look
  /// up the correct encrypted API key from the user's KeyVault storage.
  /// For example, any Claude model maps to "anthropic_api_key".
  public func providerKeyId(model : ExternalModel) : Text {
    switch (getProvider(model)) {
      case (#Anthropic) { "anthropic_api_key" };
      case (#OpenAI) { "openai_api_key" };
      case (#MagickMind) { "magickmind_api_key" };
    };
  };

  // ── Public API ──────────────────────────────────────────────────

  /// Route a prompt to the on-chain DFINITY LLM (free, no API key needed).
  ///
  /// Uses the `mo:llm` library which communicates with the subnet's local
  /// inference endpoint. Only works on mainnet (ic0.app) — local dfx replicas
  /// do not have an LLM endpoint, so this will throw and return ProviderError.
  /// The `model` parameter is passed directly to `LLM.chat()` which accepts
  /// the OnChainModel variant (#Llama3_1_8B, etc.).
  public func routeOnChain(
    model : OnChainModel,
    messages : [Message],
  ) : async Result.Result<Text, OpenClawError> {

    switch (validateMessages(messages)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };

    let chatMessages = convertMessages(messages);

    try {
      let response = await LLM.chat(model)
        .withMessages(chatMessages)
        .send();

      switch (response.message.content) {
        case (?text) { #ok(text) };
        case null { #ok("") };
      };
    } catch (_e) {
      #err(#ProviderError("On-chain LLM call failed. This feature only works on mainnet (ic0.app). If running locally, deploy to mainnet to use on-chain LLM."));
    };
  };

  /// Route a prompt to an external provider via HTTPS outcalls.
  ///
  /// Dispatches to HttpOutcalls.callAnthropic / callOpenAI / callMagickMind
  /// based on the provider. The `transformFn` is the Gateway's transform()
  /// query function, passed as a first-class reference for HTTPS outcall
  /// consensus (see Gateway.transform for details).
  ///
  /// **MagickMind difference**: Unlike Anthropic/OpenAI which accept a full
  /// conversation (array of messages), MagickMind's API takes a single message
  /// string plus metadata (chat_id, sender_id, mindspace_id). So we extract
  /// only the last user message from the conversation and send that. MagickMind
  /// maintains its own server-side memory keyed by `chat_id` — we pass the
  /// OpenClaw `conversationId` as `chat_id` so multi-turn context is preserved
  /// across messages in the same conversation. The `magickmindConfig` parameter
  /// allows per-user mindspace and brain mode selection.
  public func routeExternal(
    model : ExternalModel,
    messages : [Message],
    apiKey : Text,
    idempotencyKey : Text,
    callerPrincipal : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
    conversationId : Text,
    magickmindConfig : ?MagickMindConfig,
  ) : async Result.Result<Text, OpenClawError> {

    switch (validateMessages(messages)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };

    let modelStr = externalModelToApiString(model);

    switch (getProvider(model)) {
      case (#Anthropic) {
        await HttpOutcalls.callAnthropic(messages, apiKey, modelStr, idempotencyKey, transformFn);
      };
      case (#OpenAI) {
        await HttpOutcalls.callOpenAI(messages, apiKey, modelStr, idempotencyKey, transformFn);
      };
      case (#MagickMind) {
        // MagickMind uses a different request format: single message + metadata,
        // not a conversation array. Extract the last user message from the history.
        let lastUserMsg = switch (Array.find<Message>(Array.reverse(messages), func(m) { m.role == #user })) {
          case (?m) { m.content };
          case null { "" };
        };

        // Use conversationId as chat_id so MagickMind maintains server-side
        // memory across the conversation (not a fresh session each message).
        let chatId = if (conversationId == "") { idempotencyKey } else { conversationId };

        // Apply user's MagickMind config if available, otherwise use defaults.
        let mindspaceId = switch (magickmindConfig) {
          case (?cfg) { cfg.mindspaceId };
          case null { "default" };
        };

        let fastModelId : ?Text = switch (magickmindConfig) {
          case (?cfg) {
            if (cfg.fastModelId == "") { null } else { ?cfg.fastModelId };
          };
          case null { null };
        };

        let smartModelIds : [Text] = switch (magickmindConfig) {
          case (?cfg) { cfg.smartModelIds };
          case null { [] };
        };

        let computePower : Nat = switch (magickmindConfig) {
          case (?cfg) { cfg.computePower };
          case null { 0 };
        };

        await HttpOutcalls.callMagickMind(
          lastUserMsg,
          apiKey,
          chatId,
          callerPrincipal,
          mindspaceId,
          idempotencyKey,
          transformFn,
          fastModelId,
          smartModelIds,
          computePower,
          null,
        );
      };
    };
  };
}
