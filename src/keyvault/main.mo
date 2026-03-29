/// OpenClaw ICP — Key Vault Canister
///
/// Securely stores user API keys (Anthropic, OpenAI, MagickMind) using ICP's
/// vetKD (Verifiable Encrypted Threshold Key Derivation) system.
///
/// ## How vetKD key storage works (end-to-end flow):
///
///   1. **Client generates a transport key pair** — an ephemeral X25519 key pair
///      used only for this session. The public half is sent to the canister.
///
///   2. **Client calls getEncryptedVetkey(transportPublicKey)** — the canister
///      calls the ICP management canister's `vetkd_derive_key`, which returns a
///      key that is:
///        - Deterministically derived from (canister ID, context, caller principal)
///        - Encrypted under the client's transport public key
///      Only the client's transport secret key can decrypt it.
///
///   3. **Client decrypts the vetKey** and uses it as an AES-GCM symmetric key
///      to encrypt their API key locally (in the browser).
///
///   4. **Client calls storeEncryptedKey(keyId, encryptedBlob)** — the canister
///      stores the AES-GCM ciphertext. It never sees the plaintext API key.
///
///   5. **Gateway retrieval** — when the Gateway needs an API key to call an
///      external LLM, it calls getEncryptedKey (gateway-only access control),
///      which returns the raw encrypted blob. The Gateway then calls
///      getEncryptedVetkeyForUser to derive the user's vetKey (encrypted under
///      the Gateway's own transport key), decrypts it, and uses it to decrypt
///      the API key blob.
///
/// ## Access control:
///   - storeEncryptedKey / deleteKey / hasKey: any authenticated user (for their own keys)
///   - getEncryptedKey: Gateway canister ONLY (returns encrypted blob for any user)
///   - getEncryptedVetkeyForUser: Gateway canister ONLY (derives vetKey for any user)
///   - getEncryptedVetkey: any authenticated user (derives their own vetKey)
///   - getVetkeyVerificationKey: public (it's a public key)
///
/// ## Cycle costs:
///   vetkd_derive_key requires significant cycles: ~10B for test_key_1 (testing)
///   and ~26B for key_1 (production). The `with cycles = 10_000_000_000` syntax
///   attaches cycles to the management canister call.
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Text "mo:base/Text";
import Blob "mo:base/Blob";
import Result "mo:base/Result";
import Cycles "mo:base/ExperimentalCycles";

import IC "mo:ic";

/// The KeyVault actor class. `deployer` becomes the immutable admin.
persistent actor class KeyVault(deployer : Principal) {

  // ── State ───────────────────────────────────────────────────────

  // Transient: OrderedMap comparators are closures and cannot be serialised.
  // They are re-created on each upgrade. The actual map data persists.
  transient let principalOps = Map.Make<Principal>(Principal.compare);
  transient let textOps = Map.Make<Text>(Text.compare);

  // Primary storage: nested map of user principal -> (key_id -> encrypted_blob).
  // The blobs are AES-GCM ciphertext; the canister never sees plaintext API keys.
  var encryptedKeys : Map.Map<Principal, Map.Map<Text, Blob>> = principalOps.empty();

  // The Gateway canister principal, authorised to call getEncryptedKey and
  // getEncryptedVetkeyForUser. Set by admin via setGateway after deployment.
  var gatewayPrincipal : ?Principal = null;

  // Admin is the deployer — immutable after construction
  let admin : Principal = deployer;

  // ── Constants ─────────────────────────────────────────────────
  let MAX_KEYS_PER_USER : Nat = 20;       // Limit number of stored keys per user
  let MAX_KEY_BLOB_SIZE : Nat = 4096;      // 4 KB max per encrypted key blob
  let LOW_CYCLES_THRESHOLD : Nat = 500_000_000_000; // 0.5T cycles

  // ── vetKD Constants ───────────────────────────────────────────
  // "test_key_1" is cheaper (~10B cycles) but less secure; use "key_1" (~26B
  // cycles) in production. The context string scopes derived keys to this
  // application, so the same principal gets different keys in different apps.
  let VETKD_KEY_NAME = "test_key_1"; // Use "key_1" in production
  let VETKD_CONTEXT = "openclaw_keyvault_v1";

  // ── Admin functions ───────────────────────────────────────────

  /// Register the Gateway canister principal. Only the Gateway is allowed to
  /// call getEncryptedKey and getEncryptedVetkeyForUser. Must be called by the
  /// admin (deployer) after deploying both canisters.
  public shared (msg) func setGateway(gateway : Principal) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    gatewayPrincipal := ?gateway;
    #ok(());
  };

  // ── vetKD Integration ─────────────────────────────────────────

  /// Get the vetKD verification (public) key for this canister's context.
  /// Anyone can call this — it is a public key used by clients to verify that
  /// encrypted vetKeys were genuinely derived by the ICP threshold key system.
  /// The key is specific to (this canister, VETKD_CONTEXT) — not per-user.
  public func getVetkeyVerificationKey() : async Blob {
    let result = await IC.ic.vetkd_public_key({
      context = Text.encodeUtf8(VETKD_CONTEXT);
      key_id = { name = VETKD_KEY_NAME; curve = #bls12_381_g2 };
      canister_id = null; // derive for this canister
    });
    result.public_key;
  };

  /// Get an encrypted vetKey for the CALLER, protected by their transport key.
  ///
  /// The derived key is deterministic for (canister, VETKD_CONTEXT, caller principal).
  /// It is encrypted under the caller's `transportPublicKey`, so only the caller
  /// can decrypt it. The caller then uses the decrypted vetKey as an AES-GCM key
  /// to encrypt/decrypt their API keys client-side.
  ///
  /// Cycle cost: ~10B cycles for test_key_1, ~26B for key_1 (production).
  /// These cycles are attached to the vetkd_derive_key call via `with cycles`.
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

  /// Get an encrypted vetKey for a SPECIFIC USER — callable ONLY by the Gateway.
  ///
  /// This exists because the Gateway needs to decrypt a user's stored API keys
  /// without the user being online. The Gateway:
  ///   1. Generates its own ephemeral transport key pair.
  ///   2. Calls this function with the user's principal and the Gateway's
  ///      transport public key.
  ///   3. Receives the user's vetKey, encrypted under the Gateway's transport key.
  ///   4. Decrypts it and uses it to decrypt the stored API key blob.
  ///
  /// Access control: only the registered Gateway canister can call this.
  /// This is critical — without it, any canister could impersonate a user.
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

  /// Store an encrypted API key blob. Called by the key owner after encrypting
  /// their API key client-side with their vetKD-derived AES-GCM key.
  ///
  /// The canister NEVER sees the plaintext API key — it stores opaque ciphertext.
  ///
  /// Limits enforced:
  ///   - Max 20 keys per user (MAX_KEYS_PER_USER) — prevents storage abuse
  ///   - Max 4 KB per blob (MAX_KEY_BLOB_SIZE) — API keys are small
  ///   - Updating an existing key (same keyId) does not count toward the limit
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

  /// Retrieve an encrypted key blob for a given user and key ID.
  /// ONLY callable by the Gateway canister (enforced by gatewayPrincipal check).
  ///
  /// Returns raw AES-GCM ciphertext. The Gateway must separately call
  /// getEncryptedVetkeyForUser to obtain the decryption key. This two-step
  /// design ensures that even if this function's access control were bypassed,
  /// the attacker would still need the vetKD-derived key to decrypt the blob.
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

  /// Check if the caller has a specific key stored (e.g. "anthropic_api_key").
  /// Used by the frontend to show whether a key has been configured, without
  /// revealing the key itself. This is a query call (fast, no consensus).
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

  /// Delete a stored key. Only the key owner can delete their own keys.
  /// This permanently removes the encrypted blob — the plaintext is unrecoverable.
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

  // ── Monitoring ────────────────────────────────────────────────
  // Unauthenticated query calls for operational monitoring.

  /// Return the canister's current cycle balance.
  public query func getCycleBalance() : async Nat {
    Cycles.balance();
  };

  /// Structured health/status endpoint with low-cycle warning flag.
  public query func getStatus() : async { health : Text; cycles : Nat; lowCycles : Bool } {
    let bal = Cycles.balance();
    { health = "operational"; cycles = bal; lowCycles = bal < LOW_CYCLES_THRESHOLD };
  };

  /// Simple health-check string for uptime monitors.
  public query func health() : async Text {
    "OpenClaw KeyVault v0.2.0 — vetKD enabled";
  };
}
