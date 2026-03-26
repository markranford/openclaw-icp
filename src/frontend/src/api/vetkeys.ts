/// vetKD client-side encryption/decryption for API keys
/// Uses @dfinity/vetkeys to derive AES-256-GCM keys from ICP's threshold key system
import {
  TransportSecretKey,
  DerivedPublicKey,
  EncryptedVetKey,
} from "@dfinity/vetkeys";
import { HttpAgent, Identity } from "@icp-sdk/core/agent";
import { createKeyVaultActor } from "./keyvault.did";

const IV_LENGTH = 12; // AES-GCM standard

/**
 * Derive an AES-256-GCM key for the current user via vetKD.
 *
 * Flow:
 * 1. Generate ephemeral transport keypair
 * 2. Send transport public key to KeyVault canister
 * 3. Receive encrypted vetKey (only our transport secret can decrypt)
 * 4. Decrypt vetKey, derive AES key material
 * 5. Import as Web Crypto AES-GCM key
 */
/**
 * Derive an AES-256-GCM key for the current user via vetKD.
 *
 * IMPORTANT: The `input` passed to `decryptAndVerify` MUST match the `input`
 * used in the canister's `vetkd_derive_key` call. Our canister uses
 * `Principal.toBlob(msg.caller)`, so we must pass the same principal bytes here.
 * See: ICP vetKD skill — "Mistakes That Break Your Build" #7 and #9
 */
export async function deriveAesKey(agent: HttpAgent): Promise<CryptoKey> {
  const kv = createKeyVaultActor(agent);

  // Get the caller's principal bytes — MUST match what the canister uses as `input`
  const identity = agent.config?.identity;
  let principalBytes: Uint8Array;
  if (identity && "getPrincipal" in identity) {
    principalBytes = (identity as Identity).getPrincipal().toUint8Array();
  } else {
    throw new Error("Cannot derive vetKey: agent has no identity");
  }

  // 1. Generate ephemeral transport keypair (MUST be fresh per session — skill rule #2)
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const transportSecretKey = TransportSecretKey.fromSeed(seed);
  const transportPublicKey = transportSecretKey.publicKey();

  // 2-3. Request encrypted vetKey and verification key in parallel
  const [encryptedKeyResult, verificationKeyBytes] = await Promise.all([
    kv.getEncryptedVetkey(transportPublicKey) as Promise<
      { ok: Uint8Array | number[] } | { err: string }
    >,
    kv.getVetkeyVerificationKey() as Promise<Uint8Array | number[]>,
  ]);

  if ("err" in encryptedKeyResult) {
    throw new Error(`vetKD key derivation failed: ${encryptedKeyResult.err}`);
  }

  const encryptedKeyBytes = encryptedKeyResult.ok instanceof Uint8Array
    ? encryptedKeyResult.ok
    : new Uint8Array(encryptedKeyResult.ok);
  const verKeyBytes = verificationKeyBytes instanceof Uint8Array
    ? verificationKeyBytes
    : new Uint8Array(verificationKeyBytes);

  // 4. Decrypt and verify the vetKey
  // The `input` here MUST match the canister's `input` (Principal.toBlob(caller))
  const verificationKey = DerivedPublicKey.deserialize(verKeyBytes);
  const encryptedVetKey = EncryptedVetKey.deserialize(encryptedKeyBytes);
  const vetKey = encryptedVetKey.decryptAndVerify(
    transportSecretKey,
    verificationKey,
    principalBytes, // CRITICAL: must match canister's Principal.toBlob(msg.caller)
  );

  // 5. Derive AES-256-GCM key from vetKey material
  // (skill rule #3: do NOT use raw vetKey bytes directly as AES key)
  const aesKeyMaterial = vetKey.toDerivedKeyMaterial();
  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesKeyMaterial.data.slice(0, 32), // 256-bit AES key
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  return aesKey;
}

/**
 * Encrypt a plaintext string with AES-256-GCM using a vetKD-derived key.
 * Returns a Uint8Array: [12-byte IV | ciphertext]
 */
export async function encryptWithVetKey(
  plaintext: string,
  aesKey: CryptoKey,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoded,
  );

  // Prepend IV to ciphertext
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return result;
}

/**
 * Decrypt ciphertext with AES-256-GCM using a vetKD-derived key.
 * Expects input format: [12-byte IV | ciphertext]
 */
export async function decryptWithVetKey(
  encryptedData: Uint8Array,
  aesKey: CryptoKey,
): Promise<string> {
  if (encryptedData.length < IV_LENGTH + 1) {
    throw new Error("Encrypted data too short");
  }

  const iv = encryptedData.slice(0, IV_LENGTH);
  const ciphertext = encryptedData.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}
