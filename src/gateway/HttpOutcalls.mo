/// OpenClaw ICP — HTTPS Outcall Helpers
///
/// This module handles the low-level mechanics of making HTTPS requests from
/// an ICP canister to external LLM provider APIs. Key concepts:
///
/// **How HTTPS outcalls work on ICP:**
/// When a canister makes an HTTPS outcall, every node in the subnet (typically
/// 13 nodes) independently makes the same HTTP request. The responses are then
/// passed through a `transform` function to strip non-deterministic parts (like
/// Date headers or request IDs), and the nodes reach consensus on the result.
/// This means each API call is actually made 13 times — hence the idempotency
/// key pattern to prevent 13x billing from the provider.
///
/// **Cycle costs:**
/// HTTPS outcalls consume cycles proportional to the request and response sizes.
/// The base cost is ~49M cycles plus per-byte costs. The `max_response_bytes`
/// cap (100 KB here) bounds the cycle cost per call.
///
/// **JSON construction (hand-built, not mo:json):**
/// For OUTPUT (request bodies), we hand-build JSON strings using string
/// concatenation rather than using the mo:json library. This is deliberate:
/// the mo:json serialiser adds overhead and the request shapes are fixed
/// templates. For INPUT (response parsing), we use mo:json because responses
/// are dynamic and need proper path-based extraction.
///
/// **Response parsing differences:**
///   - Anthropic: response body has `content[0].text`
///   - OpenAI:    response body has `choices[0].message.content`
///   - MagickMind: tries OpenAI format first, falls back to `response` field
///
/// **Idempotency keys:**
/// Sent as an HTTP header to each provider. Anthropic and OpenAI both support
/// idempotency keys, which deduplicate the 13 identical requests from subnet
/// nodes. MagickMind also receives one for consistency, even if not yet honoured.
import Text "mo:base/Text";
import Blob "mo:base/Blob";
import Char "mo:base/Char";
import Nat "mo:base/Nat";
import Result "mo:base/Result";

import IC "mo:ic";
import Call "mo:ic/Call";

import Json "mo:json/lib";

import Types "Types";

module {

  type Message = Types.Message;
  type HttpHeader = IC.HttpHeader;

  // ── Constants ───────────────────────────────────────────────────
  // Cap the max response body size to bound cycle costs. 100 KB is generous
  // for a single LLM text completion (typically 1-10 KB).
  let MAX_RESPONSE_BYTES : Nat64 = 102_400; // 100 KB

  // ── JSON Helpers ──────────────────────────────────────────────
  // Hand-built JSON for request bodies. We avoid the mo:json serialiser for
  // OUTPUT because request shapes are fixed templates and string concatenation
  // is simpler and has less overhead. The mo:json library IS used for parsing
  // responses (see below), where dynamic path extraction is valuable.

  // Escape special characters in a string for safe embedding in a JSON value.
  // Handles the five characters that MUST be escaped in JSON strings:
  //   \ (backslash), " (double quote), \n (newline), \r (carriage return), \t (tab)
  // Other control characters (U+0000-U+001F) are not handled — user content
  // rarely contains them and LLM APIs are tolerant.
  func escapeJson(text : Text) : Text {
    var result = "";
    for (c in text.chars()) {
      let n = Char.toNat32(c);
      if (n == 0x5c) { result #= "\\\\" }       // backslash
      else if (n == 0x22) { result #= "\\\"" }   // double quote
      else if (n == 0x0a) { result #= "\\n" }    // newline
      else if (n == 0x0d) { result #= "\\r" }    // carriage return
      else if (n == 0x09) { result #= "\\t" }    // tab
      else { result #= Text.fromChar(c) };
    };
    result;
  };

  // Convert our internal Role variant to the JSON string expected by LLM APIs.
  // Note: #system_ has a trailing underscore because "system" is a Motoko keyword.
  func roleToString(role : Types.Role) : Text {
    switch (role) {
      case (#system_) { "system" };
      case (#user) { "user" };
      case (#assistant) { "assistant" };
    };
  };

  // ── Response Parsing ──────────────────────────────────────────
  // Each provider returns a different JSON structure. We use mo:json for parsing
  // because response shapes are dynamic and mo:json's path-based extraction
  // (e.g. "content[0].text") is much cleaner than manual string parsing.

  /// Parse Anthropic Messages API response.
  /// Anthropic returns: { "content": [{ "type": "text", "text": "..." }], ... }
  /// We extract content[0].text — the first content block's text.
  func parseAnthropicResponse(body : Text) : Result.Result<Text, Text> {
    switch (Json.parse(body)) {
      case (#err(e)) { #err("JSON parse error: " # Json.errToText(e)) };
      case (#ok(json)) {
        switch (Json.getAsText(json, "content[0].text")) {
          case (#ok(text)) { #ok(text) };
          case (#err(#pathNotFound)) { #err("Path content[0].text not found in Anthropic response") };
          case (#err(#typeMismatch)) { #err("content[0].text is not a string in Anthropic response") };
        };
      };
    };
  };

  /// Parse OpenAI Chat Completions API response.
  /// OpenAI returns: { "choices": [{ "message": { "content": "..." } }], ... }
  /// We extract choices[0].message.content. A null content (possible with
  /// function calling) is treated as an empty string.
  func parseOpenAIResponse(body : Text) : Result.Result<Text, Text> {
    switch (Json.parse(body)) {
      case (#err(e)) { #err("JSON parse error: " # Json.errToText(e)) };
      case (#ok(json)) {
        switch (Json.get(json, "choices[0].message.content")) {
          case (?#string(text)) { #ok(text) };
          case (?#null_) { #ok("") };
          case (null) { #err("Path choices[0].message.content not found in OpenAI response") };
          case (_) { #err("choices[0].message.content is not a string in OpenAI response") };
        };
      };
    };
  };

  /// Parse MagickMind response. MagickMind claims OpenAI-compatibility, so we
  /// try choices[0].message.content first. If that path doesn't exist, we fall
  /// back to a top-level "response" field that some MagickMind endpoints use.
  /// This dual-path parsing handles both API versions gracefully.
  func parseMagickMindResponse(body : Text) : Result.Result<Text, Text> {
    switch (Json.parse(body)) {
      case (#err(e)) { #err("JSON parse error: " # Json.errToText(e)) };
      case (#ok(json)) {
        // Try OpenAI-compatible format: choices[0].message.content
        switch (Json.get(json, "choices[0].message.content")) {
          case (?#string(text)) { return #ok(text) };
          case (?#null_) { return #ok("") };
          case _ {};
        };
        // Fallback: try "response" field
        switch (Json.getAsText(json, "response")) {
          case (#ok(text)) { #ok(text) };
          case (#err(_)) { #err("Could not find content in MagickMind response (tried choices[0].message.content and response)") };
        };
      };
    };
  };

  // ── Provider Call Functions ────────────────────────────────────
  // Each function constructs an HTTP POST request, executes it via
  // Call.httpRequest (the ICP HTTPS outcall primitive), and parses the
  // provider-specific response format.
  //
  // The `transformFn` parameter is a reference to the Gateway's transform()
  // query function. ICP requires this for consensus: after each subnet node
  // gets its own HTTP response, the transform function normalises the
  // responses so all nodes agree. See Gateway.transform() for details.
  //
  // `is_replicated = null` means the system uses the default behaviour
  // (replicated call from an update context). The `context` blob in
  // the transform record is unused but required by the interface.

  /// Call the Anthropic Messages API (https://api.anthropic.com/v1/messages).
  ///
  /// Anthropic-specific quirks:
  ///   - System messages must be sent as a top-level "system" field, NOT in the
  ///     messages array. So we filter #system_ messages out of the array and
  ///     set them as a separate JSON field.
  ///   - Auth is via `x-api-key` header (not Bearer token like OpenAI).
  ///   - Requires `anthropic-version` header for API versioning.
  ///   - Supports `Idempotency-Key` header natively.
  public func callAnthropic(
    messages : [Message],
    apiKey : Text,
    model : Text,
    idempotencyKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    // Build messages JSON array, separating system messages out for Anthropic
    var msgsJson = "[";
    var first = true;

    // Anthropic requires system message as a top-level field; filter it out
    // of the messages array and capture it separately
    var systemPrompt = "";
    for (msg in messages.vals()) {
      switch (msg.role) {
        case (#system_) { systemPrompt := escapeJson(msg.content) };
        case _ {
          if (not first) { msgsJson #= "," };
          msgsJson #= "{\"role\":\"" # roleToString(msg.role) # "\",\"content\":\"" # escapeJson(msg.content) # "\"}";
          first := false;
        };
      };
    };
    msgsJson #= "]";

    // Build the full request body JSON. max_tokens=4096 is a reasonable default.
    var bodyJson = "{\"model\":\"" # escapeJson(model) # "\",\"max_tokens\":4096,\"messages\":" # msgsJson;
    if (systemPrompt != "") {
      bodyJson #= ",\"system\":\"" # systemPrompt # "\"";
    };
    bodyJson #= "}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.anthropic.com/v1/messages";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "x-api-key"; value = apiKey },
        { name = "anthropic-version"; value = "2023-06-01" },
        { name = "Idempotency-Key"; value = idempotencyKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("Anthropic returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("Anthropic response is not valid UTF-8")) };
        case (?text) {
          switch (parseAnthropicResponse(text)) {
            case (#ok(content)) { #ok(content) };
            case (#err(e)) { #err(#ProviderError("Parse error: " # e # " | Raw: " # text)) };
          };
        };
      };
    } catch (e) {
      #err(#ProviderError("Anthropic HTTPS outcall failed"));
    };
  };

  /// Call OpenAI Chat Completions API (https://api.openai.com/v1/chat/completions).
  ///
  /// OpenAI-specific details:
  ///   - System messages go directly in the messages array (unlike Anthropic).
  ///   - Auth is via `Authorization: Bearer <key>` header.
  ///   - Supports `Idempotency-Key` header for deduplication.
  public func callOpenAI(
    messages : [Message],
    apiKey : Text,
    model : Text,
    idempotencyKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    // Build messages JSON array. OpenAI accepts "system" as a role directly
    // in the messages array, so no special handling is needed.
    var msgsJson = "[";
    var first = true;
    for (msg in messages.vals()) {
      if (not first) { msgsJson #= "," };
      let role = switch (msg.role) {
        case (#system_) { "system" };
        case (#user) { "user" };
        case (#assistant) { "assistant" };
      };
      msgsJson #= "{\"role\":\"" # role # "\",\"content\":\"" # escapeJson(msg.content) # "\"}";
      first := false;
    };
    msgsJson #= "]";

    let bodyJson = "{\"model\":\"" # escapeJson(model) # "\",\"messages\":" # msgsJson # ",\"max_tokens\":4096}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.openai.com/v1/chat/completions";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Authorization"; value = "Bearer " # apiKey },
        { name = "Idempotency-Key"; value = idempotencyKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("OpenAI returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("OpenAI response is not valid UTF-8")) };
        case (?text) {
          switch (parseOpenAIResponse(text)) {
            case (#ok(content)) { #ok(content) };
            case (#err(e)) { #err(#ProviderError("Parse error: " # e # " | Raw: " # text)) };
          };
        };
      };
    } catch (e) {
      #err(#ProviderError("OpenAI HTTPS outcall failed"));
    };
  };

  /// Call MagickMind Chat API (https://api.magickmind.ai/v1/chat/magickmind).
  ///
  /// MagickMind uses a fundamentally different request format compared to
  /// Anthropic/OpenAI. Instead of a conversation array, it takes:
  ///   - `message`        — a single text string (the latest user message)
  ///   - `api_key`        — in the body, not as a header
  ///   - `enduser_id`     — the user's principal (used for analytics/tracking)
  ///   - `mindspace_id`   — selects which MagickMind persona/context to use
  ///   - `config`         — multi-LLM configuration (fast_model_id, smart_model_ids, compute_power)
  ///
  /// The `config` object controls MagickMind's multi-model synthesis:
  ///   - `fast_model_id`  — single model for fast responses
  ///   - `smart_model_ids` — array of models for synthesis
  ///   - `compute_power`  — 0-100 slider (0 = fast only, 100 = max smart brain synthesis)
  ///
  /// Because of this single-message format, MagickMind does not receive
  /// conversation history from OpenClaw. Any multi-turn context depends on
  /// MagickMind's own server-side session management (keyed by mindspace_id).
  public func callMagickMind(
    message : Text,
    apiKey : Text,
    chatId : Text,
    senderId : Text,
    mindspaceId : Text,
    idempotencyKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
    fastModelId : ?Text,
    smartModelIds : [Text],
    computePower : Nat,
    additionalContext : ?Text,
  ) : async Result.Result<Text, Types.OpenClawError> {

    // Build the config.smart_model_ids JSON array
    var smartIdsJson = "[";
    var firstSmartId = true;
    for (sid in smartModelIds.vals()) {
      if (not firstSmartId) { smartIdsJson #= "," };
      smartIdsJson #= "\"" # escapeJson(sid) # "\"";
      firstSmartId := false;
    };
    smartIdsJson #= "]";

    // Build the config object
    var configJson = "{";
    switch (fastModelId) {
      case (?fmId) { configJson #= "\"fast_model_id\":\"" # escapeJson(fmId) # "\"," };
      case null {};
    };
    configJson #= "\"smart_model_ids\":" # smartIdsJson #
      ",\"compute_power\":" # Nat.toText(computePower) # "}";

    // Note: api_key is in the request body (not a header) for MagickMind
    var bodyJson = "{\"api_key\":\"" # escapeJson(apiKey) #
      "\",\"message\":\"" # escapeJson(message) #
      "\",\"mindspace_id\":\"" # escapeJson(mindspaceId) #
      "\",\"enduser_id\":\"" # escapeJson(senderId) #
      "\",\"config\":" # configJson;

    // Append additional_context if provided
    switch (additionalContext) {
      case (?ctx) { bodyJson #= ",\"additional_context\":\"" # escapeJson(ctx) # "\"" };
      case null {};
    };
    bodyJson #= "}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/chat/magickmind";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Idempotency-Key"; value = idempotencyKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind returned status " # debug_show(response.status) # ": " # errorBody));
      };

      // MagickMind claims OpenAI-compatibility, so try that format first
      // with a fallback to a top-level "response" field
      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind response is not valid UTF-8")) };
        case (?text) {
          switch (parseMagickMindResponse(text)) {
            case (#ok(content)) { #ok(content) };
            case (#err(e)) { #err(#ProviderError("Parse error: " # e # " | Raw: " # text)) };
          };
        };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind HTTPS outcall failed"));
    };
  };

  /// Call MagickMind's OpenAI-compatible endpoint for direct model access.
  ///
  /// This uses the standard OpenAI chat completions format at
  /// `https://api.magickmind.ai/v1/chat/completions`, with an additional
  /// `X-Compute-Power` header to control synthesis depth.
  ///
  /// Useful for compareModels and dualPrompt where we want to hit a specific
  /// model via MagickMind's routing rather than the multi-brain synthesis.
  public func callMagickMindDirect(
    messages : [Types.Message],
    apiKey : Text,
    modelId : Text,
    computePower : Nat,
    idempotencyKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    // Build messages JSON array in OpenAI format
    var msgsJson = "[";
    var first = true;
    for (msg in messages.vals()) {
      if (not first) { msgsJson #= "," };
      let role = switch (msg.role) {
        case (#system_) { "system" };
        case (#user) { "user" };
        case (#assistant) { "assistant" };
      };
      msgsJson #= "{\"role\":\"" # role # "\",\"content\":\"" # escapeJson(msg.content) # "\"}";
      first := false;
    };
    msgsJson #= "]";

    let bodyJson = "{\"model\":\"" # escapeJson(modelId) # "\",\"messages\":" # msgsJson # ",\"max_tokens\":4096}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/chat/completions";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Authorization"; value = "Bearer " # apiKey },
        { name = "X-Compute-Power"; value = Nat.toText(computePower) },
        { name = "Idempotency-Key"; value = idempotencyKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind Direct returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind Direct response is not valid UTF-8")) };
        case (?text) {
          switch (parseOpenAIResponse(text)) {
            case (#ok(content)) { #ok(content) };
            case (#err(e)) { #err(#ProviderError("Parse error: " # e # " | Raw: " # text)) };
          };
        };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind Direct HTTPS outcall failed"));
    };
  };

  // ── MagickMind Memory API Functions ─────────────────────────────
  // These functions call the MagickMind Memory APIs (corpus, pelican,
  // context, artifacts, mindspaces). They return raw JSON response
  // text on success — the frontend or gateway caller parses as needed.

  /// Semantic search on a MagickMind corpus (knowledge base).
  /// Calls POST https://api.magickmind.ai/v1/corpus/{corpusId}/query
  public func queryCorpus(
    apiKey : Text,
    corpusId : Text,
    searchQuery : Text,
    mode : Text,
    onlyContext : Bool,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    let onlyContextStr = if (onlyContext) { "true" } else { "false" };
    let bodyJson = "{\"query\":\"" # escapeJson(searchQuery) #
      "\",\"mode\":\"" # escapeJson(mode) #
      "\",\"only_need_context\":" # onlyContextStr # "}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/corpus/" # corpusId # "/query";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind Corpus Query returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind Corpus Query response is not valid UTF-8")) };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind Corpus Query HTTPS outcall failed"));
    };
  };

  /// Compose multi-source memory context (chat history + corpus + pelican).
  /// Calls POST https://api.magickmind.ai/v1/mindspaces/{mindspaceId}/context
  public func prepareContext(
    apiKey : Text,
    mindspaceId : Text,
    participantId : Text,
    historyLimit : Nat,
    corpusQuery : ?Text,
    pelicanQuery : ?Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    var bodyJson = "{\"participant_id\":\"" # escapeJson(participantId) #
      "\",\"chat_history\":{\"limit\":" # Nat.toText(historyLimit) # "}";

    switch (corpusQuery) {
      case (?cq) { bodyJson #= ",\"corpus\":{\"query\":\"" # escapeJson(cq) # "\"}" };
      case null { bodyJson #= ",\"corpus\":null" };
    };

    switch (pelicanQuery) {
      case (?pq) { bodyJson #= ",\"pelican\":{\"query\":\"" # escapeJson(pq) # "\"}" };
      case null { bodyJson #= ",\"pelican\":null" };
    };

    bodyJson #= ",\"api_key\":\"" # escapeJson(apiKey) # "\"}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/mindspaces/" # mindspaceId # "/context";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind Prepare Context returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind Prepare Context response is not valid UTF-8")) };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind Prepare Context HTTPS outcall failed"));
    };
  };

  /// Create a new corpus (knowledge base).
  /// Calls POST https://api.magickmind.ai/v1/corpus
  public func createCorpus(
    apiKey : Text,
    name : Text,
    description : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    let bodyJson = "{\"name\":\"" # escapeJson(name) #
      "\",\"description\":\"" # escapeJson(description) # "\"}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/corpus";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind Create Corpus returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind Create Corpus response is not valid UTF-8")) };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind Create Corpus HTTPS outcall failed"));
    };
  };

  /// List all corpora (knowledge bases) for the user.
  /// Calls GET https://api.magickmind.ai/v1/corpus
  public func listCorpora(
    apiKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/corpus";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind List Corpora returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind List Corpora response is not valid UTF-8")) };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind List Corpora HTTPS outcall failed"));
    };
  };

  /// Get a presigned upload URL for an artifact.
  /// Calls POST https://api.magickmind.ai/v1/artifacts/presign
  public func presignUpload(
    apiKey : Text,
    fileName : Text,
    contentType : Text,
    sizeBytes : Nat,
    corpusId : ?Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    var bodyJson = "{\"file_name\":\"" # escapeJson(fileName) #
      "\",\"content_type\":\"" # escapeJson(contentType) #
      "\",\"size_bytes\":" # Nat.toText(sizeBytes);

    switch (corpusId) {
      case (?cid) { bodyJson #= ",\"corpus_id\":\"" # escapeJson(cid) # "\"" };
      case null {};
    };
    bodyJson #= "}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/artifacts/presign";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind Presign Upload returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind Presign Upload response is not valid UTF-8")) };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind Presign Upload HTTPS outcall failed"));
    };
  };

  /// Attach an uploaded artifact to a corpus for ingestion.
  /// Calls POST https://api.magickmind.ai/v1/corpus/{corpusId}/artifacts
  public func addArtifactToCorpus(
    apiKey : Text,
    corpusId : Text,
    artifactId : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    let bodyJson = "{\"artifact_ids\":[\"" # escapeJson(artifactId) # "\"]}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/corpus/" # corpusId # "/artifacts";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Authorization"; value = "Bearer " # apiKey },
        { name = "x-api-key"; value = apiKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind Add Artifact returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind Add Artifact response is not valid UTF-8")) };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind Add Artifact HTTPS outcall failed"));
    };
  };

  /// Check the ingestion status of an artifact in a corpus.
  /// Calls GET https://api.magickmind.ai/v1/corpus/{corpusId}/artifacts/status?artifact_ids={artifactId}
  public func getIngestionStatus(
    apiKey : Text,
    corpusId : Text,
    artifactId : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/corpus/" # corpusId # "/artifacts/status?artifact_ids=" # artifactId;
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind Ingestion Status returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind Ingestion Status response is not valid UTF-8")) };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind Ingestion Status HTTPS outcall failed"));
    };
  };

  /// List all mindspaces for the user.
  /// Calls GET https://api.magickmind.ai/v1/mindspaces
  public func listMindspaces(
    apiKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/mindspaces";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind List Mindspaces returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind List Mindspaces response is not valid UTF-8")) };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind List Mindspaces HTTPS outcall failed"));
    };
  };

  /// Create a new mindspace.
  /// Calls POST https://api.magickmind.ai/v1/mindspaces
  public func createMindspace(
    apiKey : Text,
    name : Text,
    description : Text,
    corpusIds : [Text],
    msType : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    // Build corpus_ids JSON array
    var corpusIdsJson = "[";
    var first = true;
    for (cid in corpusIds.vals()) {
      if (not first) { corpusIdsJson #= "," };
      corpusIdsJson #= "\"" # escapeJson(cid) # "\"";
      first := false;
    };
    corpusIdsJson #= "]";

    let bodyJson = "{\"name\":\"" # escapeJson(name) #
      "\",\"description\":\"" # escapeJson(description) #
      "\",\"corpus_ids\":" # corpusIdsJson #
      ",\"type\":\"" # escapeJson(msType) # "\"}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/mindspaces";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Content-Type"; value = "application/json" },
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind Create Mindspace returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind Create Mindspace response is not valid UTF-8")) };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind Create Mindspace HTTPS outcall failed"));
    };
  };

  /// Delete a corpus.
  /// Calls POST https://api.magickmind.ai/v1/corpus/{corpusId}/delete
  /// (Uses POST with /delete path since ICP HTTPS outcalls may not support DELETE method directly)
  public func deleteCorpus(
    apiKey : Text,
    corpusId : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    // ICP HTTPS outcalls only support GET/HEAD/POST — use POST with X-HTTP-Method-Override
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/corpus/" # corpusId;
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
        { name = "X-HTTP-Method-Override"; value = "DELETE" },
        { name = "Content-Type"; value = "application/json" },
      ];
      body = ?Text.encodeUtf8("{\"_method\":\"DELETE\"}");
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };

    try {
      let response = await Call.httpRequest(request);

      if (response.status != 200 and response.status != 204) {
        let errorBody = switch (Text.decodeUtf8(response.body)) {
          case (?t) { t };
          case null { "Non-UTF8 error response" };
        };
        return #err(#ProviderError("MagickMind Delete Corpus returned status " # debug_show(response.status) # ": " # errorBody));
      };

      switch (Text.decodeUtf8(response.body)) {
        case null { #ok("{}") };
        case (?text) { #ok(text) };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind Delete Corpus HTTPS outcall failed"));
    };
  };

  // ── MagickMind Persona API ──────────────────────────────────────

  /// Prepare (generate) a system prompt for a persona.
  /// POST https://api.magickmind.ai/v1/persona/{personaId}/prepare
  public func preparePersona(
    apiKey : Text,
    personaId : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/persona/" # personaId # "/prepare";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
        { name = "Content-Type"; value = "application/json" },
      ];
      body = ?Text.encodeUtf8("{}");
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Prepare Persona status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("{}") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Prepare Persona HTTPS outcall failed")) };
  };

  /// List persona versions (evolution history).
  /// GET https://api.magickmind.ai/v1/persona/{personaId}/version
  public func listPersonaVersions(
    apiKey : Text,
    personaId : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/persona/" # personaId # "/version";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Persona Versions status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("[]") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Persona Versions HTTPS outcall failed")) };
  };

  /// Get the active (current) persona version.
  /// GET https://api.magickmind.ai/v1/persona/{personaId}/version/active
  public func getActivePersonaVersion(
    apiKey : Text,
    personaId : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/persona/" # personaId # "/version/active";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Active Persona Version status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("{}") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Active Persona Version HTTPS outcall failed")) };
  };

  /// Get the effective (runtime-blended) personality for a persona.
  /// GET https://api.magickmind.ai/v1/runtime/effective-personality/{personaId}
  public func getEffectivePersonality(
    apiKey : Text,
    personaId : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/runtime/effective-personality/" # personaId;
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Effective Personality status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("{}") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Effective Personality HTTPS outcall failed")) };
  };

  // ── MagickMind Blueprint & Traits API ───────────────────────────

  /// List all blueprints.
  /// GET https://api.magickmind.ai/v1/blueprints
  public func listBlueprints(
    apiKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/blueprints";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind List Blueprints status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("[]") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind List Blueprints HTTPS outcall failed")) };
  };

  /// Get a blueprint by its key.
  /// GET https://api.magickmind.ai/v1/blueprints/by-key?key={key}
  public func getBlueprintByKey(
    apiKey : Text,
    blueprintKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/blueprints/by-key?key=" # blueprintKey;
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Get Blueprint status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("{}") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Get Blueprint HTTPS outcall failed")) };
  };

  /// Hydrate a blueprint (expand it into full trait definitions).
  /// POST https://api.magickmind.ai/v1/blueprints/{blueprintId}/hydrate
  public func hydrateBlueprint(
    apiKey : Text,
    blueprintId : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/blueprints/" # blueprintId # "/hydrate";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
        { name = "Content-Type"; value = "application/json" },
      ];
      body = ?Text.encodeUtf8("{}");
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Hydrate Blueprint status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("{}") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Hydrate Blueprint HTTPS outcall failed")) };
  };

  /// List all traits.
  /// GET https://api.magickmind.ai/v1/traits
  public func listTraits(
    apiKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/traits";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind List Traits status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("[]") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind List Traits HTTPS outcall failed")) };
  };

  // ── MagickMind Message History ──────────────────────────────────

  /// Get paginated message history from a mindspace.
  /// GET https://api.magickmind.ai/v1/mindspaces/{mindspaceId}/messages?limit={limit}&order={order}&cursor={cursor}
  public func getMindspaceMessages(
    apiKey : Text,
    mindspaceId : Text,
    limit : Nat,
    order : Text, // "asc" or "desc"
    cursor : ?Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    var url = "https://api.magickmind.ai/v1/mindspaces/" # mindspaceId # "/messages?limit=" # debug_show(limit) # "&order=" # order;
    switch (cursor) {
      case (?c) { url := url # "&cursor=" # c };
      case null {};
    };
    let request : IC.HttpRequestArgs = {
      url = url;
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
      ];
      body = null;
      method = #get;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Messages status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("{}") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Messages HTTPS outcall failed")) };
  };

  /// Add a participant to a mindspace.
  /// POST https://api.magickmind.ai/v1/mindspaces/{mindspaceId}/users
  public func addMindspaceParticipant(
    apiKey : Text,
    mindspaceId : Text,
    userId : Text,
    role : Text, // "member" or "admin"
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let bodyJson = "{\"user_id\":\"" # escapeJson(userId) # "\",\"role\":\"" # escapeJson(role) # "\"}";
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/mindspaces/" # mindspaceId # "/users";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
        { name = "Content-Type"; value = "application/json" },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200 and response.status != 201) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Add Participant status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("{}") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Add Participant HTTPS outcall failed")) };
  };

  /// Create a persona from a blueprint on MagickMind.
  /// POST https://api.magickmind.ai/v1/persona/from-blueprint
  public func createPersonaFromBlueprint(
    apiKey : Text,
    blueprintId : Text,
    name : Text,
    description : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let bodyJson = "{\"blueprint_id\":\"" # escapeJson(blueprintId) # "\",\"name\":\"" # escapeJson(name) # "\",\"description\":\"" # escapeJson(description) # "\"}";
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/persona/from-blueprint";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
        { name = "Content-Type"; value = "application/json" },
      ];
      body = ?Text.encodeUtf8(bodyJson);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200 and response.status != 201) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Create Persona from Blueprint status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("{}") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Create Persona from Blueprint HTTPS outcall failed")) };
  };

  /// Invalidate the runtime cache (force re-computation of effective personality).
  /// POST https://api.magickmind.ai/v1/runtime/invalidate-cache
  public func invalidateRuntimeCache(
    apiKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {
    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/runtime/invalidate-cache";
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [
        { name = "Authorization"; value = "Bearer " # apiKey },
        { name = "Content-Type"; value = "application/json" },
      ];
      body = ?Text.encodeUtf8("{}");
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status != 200) {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Non-UTF8" }; };
        return #err(#ProviderError("MagickMind Invalidate Cache status " # debug_show(response.status) # ": " # errorBody));
      };
      switch (Text.decodeUtf8(response.body)) { case null { #ok("{}") }; case (?text) { #ok(text) }; };
    } catch (_e) { #err(#ProviderError("MagickMind Invalidate Cache HTTPS outcall failed")) };
  };
}
