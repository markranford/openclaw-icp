/// OpenClaw ICP — Key Vault Canister
/// vetKD-encrypted credential storage
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Text "mo:base/Text";
import Blob "mo:base/Blob";
import Result "mo:base/Result";

import IC "mo:ic";

persistent actor class KeyVault(deployer : Principal) {

  // ── State ───────────────────────────────────────────────────────

  transient let principalOps = Map.Make<Principal>(Principal.compare);
  transient let textOps = Map.Make<Text>(Text.compare);

  // Encrypted keys: user principal → (key_id → encrypted_blob)
  var encryptedKeys : Map.Map<Principal, Map.Map<Text, Blob>> = principalOps.empty();

  // Authorized gateway canister that can retrieve keys
  var gatewayPrincipal : ?Principal = null;

  // Admin is the deployer — immutable after construction
  let admin : Principal = deployer;

  // ── Constants ─────────────────────────────────────────────────
  let MAX_KEYS_PER_USER : Nat = 20;
  let MAX_KEY_BLOB_SIZE : Nat = 4096; // 4 KB max per encrypted key

  // ── vetKD Constants ───────────────────────────────────────────
  let VETKD_KEY_NAME = "test_key_1"; // Use "key_1" in production
  let VETKD_CONTEXT = "openclaw_keyvault_v1";

  // ── Admin functions ───────────────────────────────────────────

  public shared (msg) func setGateway(gateway : Principal) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    gatewayPrincipal := ?gateway;
    #ok(());
  };

  // ── vetKD Integration ─────────────────────────────────────────

  /// Get the vetKD verification (public) key for this canister's context.
  /// Anyone can call this — it's a public key.
  public func getVetkeyVerificationKey() : async Blob {
    let result = await IC.ic.vetkd_public_key({
      context = Text.encodeUtf8(VETKD_CONTEXT);
      key_id = { name = VETKD_KEY_NAME; curve = #bls12_381_g2 };
      canister_id = null; // derive for this canister
    });
    result.public_key;
  };

  /// Get an encrypted vetKey for the caller, protected by their transport key.
  /// The derived key is specific to: (canister, context, caller principal).
  /// Only the caller's transport secret key can decrypt the result.
  /// NOTE: vetkd_derive_key requires cycles (~10B for test_key_1, ~26B for key_1)
  public shared (msg) func getEncryptedVetkey(
    transportPublicKey : Blob,
  ) : async Result.Result<Blob, Text> {
    if (Principal.isAnonymous(msg.caller)) {
      return #err("Not authenticated");
    };

    // Capture caller BEFORE await (vetKD skill rule #6)
    let callerBlob = Principal.toBlob(msg.caller);

    // vetkd_derive_key requires cycles: 10B for test_key_1, 26B for key_1
    let result = await (with cycles = 10_000_000_000)
      IC.ic.vetkd_derive_key({
        context = Text.encodeUtf8(VETKD_CONTEXT);
        key_id = { name = VETKD_KEY_NAME; curve = #bls12_381_g2 };
        input = callerBlob;
        transport_public_key = transportPublicKey;
      });

    #ok(result.encrypted_key);
  };

  /// Get an encrypted vetKey for a specific user — callable ONLY by Gateway.
  /// This allows Gateway to decrypt stored keys on behalf of users.
  public shared (msg) func getEncryptedVetkeyForUser(
    userPrincipal : Principal,
    transportPublicKey : Blob,
  ) : async Result.Result<Blob, Text> {
    // Capture caller BEFORE await (vetKD skill rule #6)
    let caller = msg.caller;

    switch (gatewayPrincipal) {
      case null { return #err("Gateway not configured") };
      case (?gw) {
        if (caller != gw) {
          return #err("Unauthorized: only Gateway can derive keys for other users");
        };
      };
    };

    let result = await (with cycles = 10_000_000_000)
      IC.ic.vetkd_derive_key({
        context = Text.encodeUtf8(VETKD_CONTEXT);
        key_id = { name = VETKD_KEY_NAME; curve = #bls12_381_g2 };
        input = Principal.toBlob(userPrincipal);
        transport_public_key = transportPublicKey;
      });

    #ok(result.encrypted_key);
  };

  // ── Key management ────────────────────────────────────────────

  /// Store an encrypted API key (called by the key owner).
  /// The blob should be AES-GCM ciphertext encrypted with the vetKD-derived key.
  public shared (msg) func storeEncryptedKey(keyId : Text, encryptedBlob : Blob) : async Result.Result<(), Text> {
    if (Principal.isAnonymous(msg.caller)) {
      return #err("Not authenticated");
    };

    // Enforce blob size limit
    if (encryptedBlob.size() > MAX_KEY_BLOB_SIZE) {
      return #err("Key blob too large: max " # debug_show(MAX_KEY_BLOB_SIZE) # " bytes");
    };

    let userKeys = switch (principalOps.get(encryptedKeys, msg.caller)) {
      case (?keys) { keys };
      case null { textOps.empty() };
    };

    // Enforce key count limit (only for new keys, not updates)
    switch (textOps.get(userKeys, keyId)) {
      case null {
        if (textOps.size(userKeys) >= MAX_KEYS_PER_USER) {
          return #err("Too many keys: max " # debug_show(MAX_KEYS_PER_USER));
        };
      };
      case _ {}; // updating existing key is fine
    };

    let updatedKeys = textOps.put(userKeys, keyId, encryptedBlob);
    encryptedKeys := principalOps.put(encryptedKeys, msg.caller, updatedKeys);
    #ok(());
  };

  /// Retrieve an encrypted key (only callable by the Gateway canister).
  /// Returns AES-GCM ciphertext — Gateway must derive vetKey to decrypt.
  public shared (msg) func getEncryptedKey(userPrincipal : Principal, keyId : Text) : async Result.Result<Blob, Text> {
    switch (gatewayPrincipal) {
      case null { return #err("Gateway not configured") };
      case (?gw) {
        if (msg.caller != gw) { return #err("Unauthorized: only Gateway canister can retrieve keys") };
      };
    };

    switch (principalOps.get(encryptedKeys, userPrincipal)) {
      case null { #err("No keys for user") };
      case (?userKeys) {
        switch (textOps.get(userKeys, keyId)) {
          case null { #err("Key not found: " # keyId) };
          case (?blob) { #ok(blob) };
        };
      };
    };
  };

  /// Check if caller has a specific key stored
  public shared query (msg) func hasKey(keyId : Text) : async Bool {
    if (Principal.isAnonymous(msg.caller)) { return false };
    switch (principalOps.get(encryptedKeys, msg.caller)) {
      case null { false };
      case (?userKeys) {
        switch (textOps.get(userKeys, keyId)) {
          case null { false };
          case (?_) { true };
        };
      };
    };
  };

  /// Delete a key (only the key owner)
  public shared (msg) func deleteKey(keyId : Text) : async Result.Result<(), Text> {
    if (Principal.isAnonymous(msg.caller)) {
      return #err("Not authenticated");
    };

    switch (principalOps.get(encryptedKeys, msg.caller)) {
      case null { #err("No keys found") };
      case (?userKeys) {
        let updatedKeys = textOps.delete(userKeys, keyId);
        encryptedKeys := principalOps.put(encryptedKeys, msg.caller, updatedKeys);
        #ok(());
      };
    };
  };

  /// Health check
  public query func health() : async Text {
    "OpenClaw KeyVault v0.2.0 — vetKD enabled";
  };
}
