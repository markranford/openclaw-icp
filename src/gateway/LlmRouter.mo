/// OpenClaw ICP — LLM Router
/// Routes prompts to on-chain DFINITY LLM or external providers via HTTPS outcalls
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

  // ── Constants ───────────────────────────────────────────────────
  let MAX_MESSAGES : Nat = 50;
  let MAX_PROMPT_BYTES : Nat = 32_768; // 32 KB

  // ── Helpers ─────────────────────────────────────────────────────

  func convertMessage(msg : Message) : LLM.ChatMessage {
    switch (msg.role) {
      case (#system_) { #system_ { content = msg.content } };
      case (#user) { #user { content = msg.content } };
      case (#assistant) { #assistant { content = ?msg.content; tool_calls = [] } };
    };
  };

  func convertMessages(messages : [Message]) : [LLM.ChatMessage] {
    Array.map<Message, LLM.ChatMessage>(messages, convertMessage);
  };

  func totalPromptSize(messages : [Message]) : Nat {
    var total : Nat = 0;
    for (msg in messages.vals()) {
      total += Text.size(msg.content);
    };
    total;
  };

  func validateMessages(messages : [Message]) : Result.Result<(), OpenClawError> {
    if (messages.size() > MAX_MESSAGES) {
      return #err(#InvalidInput("Too many messages: max " # debug_show(MAX_MESSAGES)));
    };
    if (totalPromptSize(messages) > MAX_PROMPT_BYTES) {
      return #err(#InvalidInput("Prompt too large: max 32 KB"));
    };
    #ok(());
  };

  /// Map ExternalModel variant to the API model string
  func externalModelToApiString(model : ExternalModel) : Text {
    switch (model) {
      case (#Claude_Sonnet) { "claude-sonnet-4-20250514" };
      case (#Claude_Haiku) { "claude-haiku-4-5-20251001" };
      case (#GPT4o) { "gpt-4o" };
      case (#GPT4oMini) { "gpt-4o-mini" };
      case (#MagickMind_Brain) { "magickmind" };
    };
  };

  /// Determine which provider to use for a given external model
  func getProvider(model : ExternalModel) : { #Anthropic; #OpenAI; #MagickMind } {
    switch (model) {
      case (#Claude_Sonnet or #Claude_Haiku) { #Anthropic };
      case (#GPT4o or #GPT4oMini) { #OpenAI };
      case (#MagickMind_Brain) { #MagickMind };
    };
  };

  /// Get the KeyVault key ID for a provider
  public func providerKeyId(model : ExternalModel) : Text {
    switch (getProvider(model)) {
      case (#Anthropic) { "anthropic_api_key" };
      case (#OpenAI) { "openai_api_key" };
      case (#MagickMind) { "magickmind_api_key" };
    };
  };

  // ── Public API ──────────────────────────────────────────────────

  /// Route a prompt to the on-chain DFINITY LLM
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

  /// Route a prompt to an external provider via HTTPS outcalls
  public func routeExternal(
    model : ExternalModel,
    messages : [Message],
    apiKey : Text,
    idempotencyKey : Text,
    callerPrincipal : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
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
        // MagickMind uses a different request format
        // Use the last user message as the prompt, caller principal as sender_id
        let lastUserMsg = switch (Array.find<Message>(Array.reverse(messages), func(m) { m.role == #user })) {
          case (?m) { m.content };
          case null { "" };
        };
        await HttpOutcalls.callMagickMind(
          lastUserMsg,
          apiKey,
          idempotencyKey, // use idempotency key as chat_id for now
          callerPrincipal, // sender_id = caller principal
          "default", // mindspace_id — TODO: make configurable
          idempotencyKey,
          transformFn,
        );
      };
    };
  };
}
