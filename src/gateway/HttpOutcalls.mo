/// OpenClaw ICP — HTTPS Outcall Helpers
/// Builds and executes HTTPS requests to Anthropic, OpenAI, and MagickMind APIs
import Text "mo:base/Text";
import Blob "mo:base/Blob";
import Char "mo:base/Char";
import Array "mo:base/Array";
import Result "mo:base/Result";

import IC "mo:ic";
import Call "mo:ic/Call";

import Types "Types";

module {

  type Message = Types.Message;
  type HttpHeader = IC.HttpHeader;

  // ── Constants ───────────────────────────────────────────────────
  let MAX_RESPONSE_BYTES : Nat64 = 102_400; // 100 KB

  // ── JSON Helpers ──────────────────────────────────────────────
  // Simple JSON string building (no library needed for these templates)

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

  func roleToString(role : Types.Role) : Text {
    switch (role) {
      case (#system_) { "system" };
      case (#user) { "user" };
      case (#assistant) { "assistant" };
    };
  };

  // ── Response Parsing ──────────────────────────────────────────

  /// Extract a JSON string value after a key like "text":" or "content":"
  /// Simple approach: split on the key, then extract up to the next unescaped quote
  func extractJsonStringAfter(body : Text, key : Text) : Result.Result<Text, Text> {
    // Split on the key pattern (e.g. "text":"  or  "content":")
    let parts = Text.split(body, #text key);
    var found = false;
    for (part in parts) {
      if (found) {
        // This part starts right after the key — extract until closing "
        // The value starts with the content (key already included the opening quote)
        let chars = Text.toArray(part);
        var result = "";
        var i : Nat = 0;
        var escaped = false;
        while (i < chars.size()) {
          let n = Char.toNat32(chars[i]);
          if (escaped) {
            // Include escaped character as-is
            result #= Text.fromChar(chars[i]);
            escaped := false;
          } else if (n == 0x5c) { // backslash
            result #= Text.fromChar(chars[i]);
            escaped := true;
          } else if (n == 0x22) { // closing double quote
            return #ok(result);
          } else {
            result #= Text.fromChar(chars[i]);
          };
          i += 1;
        };
        return #err("Unterminated string value");
      };
      found := true; // skip first part (before the key)
    };
    #err("Key not found: " # key);
  };

  /// Parse Anthropic response — extract "text" field from content array
  func parseAnthropicResponse(body : Text) : Result.Result<Text, Text> {
    extractJsonStringAfter(body, "\"text\":\"");
  };

  /// Parse OpenAI/MagickMind response — extract "content" field from message
  func parseOpenAIResponse(body : Text) : Result.Result<Text, Text> {
    switch (extractJsonStringAfter(body, "\"content\":\"")) {
      case (#ok(v)) { #ok(v) };
      case (#err(_)) {
        // Check for null content
        if (Text.contains(body, #text "\"content\":null")) {
          #ok("");
        } else {
          #err("Could not find content field in response");
        };
      };
    };
  };

  // ── Provider Call Functions ────────────────────────────────────

  /// Call Anthropic Messages API
  public func callAnthropic(
    messages : [Message],
    apiKey : Text,
    model : Text,
    idempotencyKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    // Build messages JSON array
    var msgsJson = "[";
    var first = true;

    // Anthropic requires system message separately; filter it out
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

  /// Call OpenAI Chat Completions API
  public func callOpenAI(
    messages : [Message],
    apiKey : Text,
    model : Text,
    idempotencyKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    // Build messages JSON array (OpenAI uses "system" role directly)
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

  /// Call MagickMind Chat API
  /// MagickMind uses a unique request format with mindspace_id and sender_id
  public func callMagickMind(
    message : Text,
    apiKey : Text,
    chatId : Text,
    senderId : Text,
    mindspaceId : Text,
    idempotencyKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Result.Result<Text, Types.OpenClawError> {

    let bodyJson = "{\"api_key\":\"" # escapeJson(apiKey) #
      "\",\"message\":\"" # escapeJson(message) #
      "\",\"chat_id\":\"" # escapeJson(chatId) #
      "\",\"sender_id\":\"" # escapeJson(senderId) #
      "\",\"mindspace_id\":\"" # escapeJson(mindspaceId) # "\"}";

    let request : IC.HttpRequestArgs = {
      url = "https://api.magickmind.ai/v1/magickmind/chat";
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

      // MagickMind is OpenAI-compatible, try same parsing
      switch (Text.decodeUtf8(response.body)) {
        case null { #err(#ProviderError("MagickMind response is not valid UTF-8")) };
        case (?text) {
          // Try OpenAI format first, fall back to raw text
          switch (parseOpenAIResponse(text)) {
            case (#ok(content)) { #ok(content) };
            case (#err(_)) {
              // MagickMind may return a different format — return raw body
              #ok(text);
            };
          };
        };
      };
    } catch (e) {
      #err(#ProviderError("MagickMind HTTPS outcall failed"));
    };
  };
}
