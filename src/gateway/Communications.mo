/// OpenClaw ICP — Communications Module
/// Sends email (Resend) and SMS (Twilio) via HTTPS outcalls with idempotency.
import Text "mo:base/Text";
import Char "mo:base/Char";
import Blob "mo:base/Blob";
import IC "mo:ic";
import Call "mo:ic/Call";
import Types "Types";

module {
  let MAX_RESPONSE_BYTES : Nat64 = 10_240;

  func escapeJson(text : Text) : Text {
    var result = "";
    for (c in text.chars()) {
      let n = Char.toNat32(c);
      if (n == 0x5c) { result #= "\\\\" }
      else if (n == 0x22) { result #= "\\\"" }
      else if (n == 0x0a) { result #= "\\n" }
      else if (n == 0x0d) { result #= "\\r" }
      else if (n == 0x09) { result #= "\\t" }
      else { result #= Text.fromChar(c) };
    };
    result;
  };

  /// Send email via Resend API. Resend has native Idempotency-Key support.
  public func sendEmailResend(
    apiKey : Text, from : Text, to : Text, subject : Text,
    htmlBody : Text, idempotencyKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Types.CommResult {
    let bodyJson = "{\"from\":\"" # escapeJson(from) # "\",\"to\":[\"" # escapeJson(to) # "\"],\"subject\":\"" # escapeJson(subject) # "\",\"html\":\"" # escapeJson(htmlBody) # "\"}";
    let request : IC.HttpRequestArgs = {
      url = "https://api.resend.com/emails";
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
      if (response.status == 200 or response.status == 202) {
        switch (Text.decodeUtf8(response.body)) {
          case (?text) { #Sent("Email sent: " # text) };
          case null { #Sent("Email sent") };
        };
      } else {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Unknown" } };
        #Failed("Resend status " # debug_show(response.status) # ": " # errorBody);
      };
    } catch (_) { #Failed("Resend HTTPS outcall failed") };
  };

  /// Send SMS via Twilio. No native idempotency — use idempotent-proxy in production.
  public func sendSmsTwilio(
    accountSid : Text, authToken : Text, fromNumber : Text,
    toNumber : Text, body : Text, idempotencyKey : Text,
    transformFn : shared query (IC.TransformArg) -> async IC.HttpRequestResult,
  ) : async Types.CommResult {
    let formBody = "From=" # fromNumber # "&To=" # toNumber # "&Body=" # body;
    let url = "https://" # accountSid # ":" # authToken # "@api.twilio.com/2010-04-01/Accounts/" # accountSid # "/Messages.json";
    let request : IC.HttpRequestArgs = {
      url = url;
      max_response_bytes = ?MAX_RESPONSE_BYTES;
      headers = [{ name = "Content-Type"; value = "application/x-www-form-urlencoded" }];
      body = ?Text.encodeUtf8(formBody);
      method = #post;
      transform = ?{ function = transformFn; context = Blob.fromArray([]) };
      is_replicated = null;
    };
    try {
      let response = await Call.httpRequest(request);
      if (response.status == 201 or response.status == 200) {
        #Sent("SMS sent to " # toNumber);
      } else {
        let errorBody = switch (Text.decodeUtf8(response.body)) { case (?t) { t }; case null { "Unknown" } };
        #Failed("Twilio status " # debug_show(response.status) # ": " # errorBody);
      };
    } catch (_) { #Failed("Twilio HTTPS outcall failed") };
  };
}
