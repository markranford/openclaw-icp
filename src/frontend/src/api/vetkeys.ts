/**
 * @file Client-side vetKD encryption and decryption utilities for API keys.
 *
 * This module implements the frontend half of the ICP **vetKD** (Verifiable
 * Encrypted Threshold Key Derivation) protocol. vetKD allows the browser to
 * derive a per-user AES-256-GCM key without any party (including ICP node
 * operators) ever seeing the raw key material.
 *
 * ## High-level flow
 *
 * ```
 * Browser                              KeyVault canister              ICP Subnet
 * ───────                              ─────────────────              ──────────
 * 1. Generate ephemeral transport
 *    keypair (TransportSecretKey)
 * 2. Send transport public key ──────► getEncryptedVetkey() ────────► vetkd_derive_key()
 *                                                                     (threshold signing)
 * 3. Receive encrypted vetKey ◄────── return encrypted bytes ◄──────
 * 4. Decrypt with transport secret
 *    + verify with verification key
 * 5. Derive AES-256-GCM CryptoKey
 *    from vetKey material
 * 6. Use CryptoKey to encrypt/decrypt
 *    API keys client-side
 * ```
 *
 * ## Security properties
 *
 * - The **transport keypair** is ephemeral (random per session). Even if an old
 *   encrypted vetKey blob is intercepted, it cannot be decrypted without the
 *   transport secret that existed only in memory.
 * - The **vetKey** is derived by the ICP subnet via threshold BLS signing.
 *   No single node ever holds the full key. The canister controls which
 *   principals can derive keys.
 * - The **AES key** is derived from the vetKey material using HKDF, NOT by
 *   using raw vetKey bytes directly (which would be insecure).
 * - Ciphertext format is `[12-byte IV | AES-GCM ciphertext]`, a standard
 *   construction that is authenticated (tamper-evident).
 *
 * @module api/vetkeys
 */

import {
  TransportSecretKey,
  DerivedPublicKey,
  EncryptedVetKey,
} from "@dfinity/vetkeys";
import { HttpAgent, Identity } from "@icp-sdk/core/agent";
import { createKeyVaultActor } from "./keyvault.did";

/** Standard AES-GCM initialization vector length in bytes. */
const IV_LENGTH = 12;

/**
 * Derive an AES-256-GCM {@link CryptoKey} for the current user via vetKD.
 *
 * This is the main entry point for vetKD on the client side. The returned
 * `CryptoKey` can be passed to {@link encryptWithVetKey} and
 * {@link decryptWithVetKey} to protect API keys before on-chain storage.
 *
 * ### Step-by-step
 *
 * 1. Extract the caller's principal bytes from the agent's identity. These
 *    bytes **must** match the `input` the canister passes to `vetkd_derive_key`
 *    (i.e. `Principal.toBlob(msg.caller)`). A mismatch will cause verification
 *    to fail silently and produce a wrong key.
 * 2. Generate a fresh {@link TransportSecretKey} (ephemeral, never leaves memory).
 * 3. Send the transport public key to the KeyVault canister and receive the
 *    encrypted vetKey + the verification key in parallel.
 * 4. Decrypt and verify the vetKey using the transport secret + verification key.
 * 5. Derive AES-256-GCM key material from the vetKey via HKDF with the domain
 *    separator `"openclaw-api-keys-v1"`.
 *
 * @param agent - An authenticated {@link HttpAgent} whose identity determines
 *   the derived key. Different principals produce different AES keys.
 * @returns A Web Crypto {@link CryptoKey} usable for AES-256-GCM encrypt/decrypt.
 * @throws If the agent has no identity, or if the canister returns an error.
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
  const transportSecretKey = TransportSecretKey.random();
  const transportPublicKey = transportSecretKey.publicKeyBytes();

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
  const aesKeyMaterial = await vetKey.asDerivedKeyMaterial();
  return aesKeyMaterial.deriveAesGcmCryptoKey("openclaw-api-keys-v1");
}

/**
 * Encrypt a plaintext string with AES-256-GCM using a vetKD-derived key.
 *
 * The output format is `[12-byte random IV | AES-GCM ciphertext + auth tag]`.
 * A fresh random IV is generated for every call, so encrypting the same
 * plaintext twice produces different ciphertext (as required by GCM security).
 *
 * @param plaintext - The string to encrypt (e.g. an API key like `"sk-ant-..."`).
 * @param aesKey - A {@link CryptoKey} obtained from {@link deriveAesKey}.
 * @returns A `Uint8Array` containing the IV followed by the ciphertext.
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
 * Decrypt ciphertext that was produced by {@link encryptWithVetKey}.
 *
 * Expects the input format `[12-byte IV | AES-GCM ciphertext + auth tag]`.
 * If the ciphertext was tampered with, the Web Crypto API will throw an
 * `OperationError` (GCM authentication failure).
 *
 * @param encryptedData - The `Uint8Array` previously returned by {@link encryptWithVetKey}.
 * @param aesKey - The same {@link CryptoKey} that was used for encryption
 *   (derived from the same principal via {@link deriveAesKey}).
 * @returns The original plaintext string.
 * @throws If the data is too short, the key is wrong, or the ciphertext was tampered with.
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
