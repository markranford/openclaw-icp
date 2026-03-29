/**
 * @file Agent factory and environment configuration for the OpenClaw frontend.
 *
 * This module is the single entry point for creating authenticated {@link HttpAgent}
 * instances that communicate with ICP canisters. It handles two runtime modes:
 *
 * - **Local development** (`localhost` / `*.localhost`): Uses a deterministic
 *   Ed25519 identity persisted in `localStorage` so the caller's principal
 *   remains stable across page reloads. The agent points at `http://127.0.0.1:4943`
 *   (the local `dfx` replica) and fetches the root key (required for local replicas
 *   since they use a self-signed root key that is not hard-coded in the SDK).
 *
 * - **Production / mainnet**: Uses the identity provided by an {@link AuthClient}
 *   (Internet Identity delegation) or a raw {@link Identity}. The agent points at
 *   `window.location.origin` (the boundary-node URL).
 *
 * Canister IDs are injected at build time via Vite environment variables
 * (`VITE_GATEWAY_CANISTER_ID`, etc.) and are re-exported as constants for use
 * by the `.did.ts` actor helpers.
 *
 * @module api/agent
 */

import { HttpAgent, Actor, ActorSubclass, Identity } from "@icp-sdk/core/agent";
import { AuthClient } from "@icp-sdk/auth/client";
import { Ed25519KeyIdentity } from "@dfinity/identity";

/**
 * Canister IDs injected at build time by Vite.
 *
 * During local development the values come from `dfx deploy` output and are
 * typically set in a `.env.local` file (e.g. `VITE_GATEWAY_CANISTER_ID=bkyz2-...`).
 * On mainnet they are baked into the production build.
 *
 * If a variable is missing the constant defaults to an empty string, which will
 * cause actor creation to fail with a clear error.
 */
const GATEWAY_CANISTER_ID = import.meta.env.VITE_GATEWAY_CANISTER_ID ?? "";
const KEYVAULT_CANISTER_ID = import.meta.env.VITE_KEYVAULT_CANISTER_ID ?? "";
const WALLET_CANISTER_ID = import.meta.env.VITE_WALLET_CANISTER_ID ?? "";
const IDENTITY_CANISTER_ID = import.meta.env.VITE_IDENTITY_CANISTER_ID ?? "";

/**
 * Determine the HTTP host the agent should connect to.
 *
 * - Local: `http://127.0.0.1:4943` (the default `dfx start` port).
 * - Production: the current page origin (boundary-node URL).
 *
 * @returns The base URL string for the {@link HttpAgent}.
 */
function getHost(): string {
  if (isLocal()) {
    return "http://127.0.0.1:4943";
  }
  return window.location.origin;
}

/**
 * Detect whether the app is running against a local dfx replica.
 *
 * The check looks at `window.location.hostname`:
 * - `"localhost"` — bare localhost (e.g. `http://localhost:3000`)
 * - `*.localhost`  — canister URLs served by `dfx` (e.g. `http://bkyz2-fmaaa-aaaaa-qaaaq-cai.localhost:4943`)
 *
 * @returns `true` when the frontend is served from a local development environment.
 */
export function isLocal(): boolean {
  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * Retrieve the developer Ed25519 identity from `localStorage`.
 *
 * During local development an Ed25519 keypair is generated once and stored
 * under the key `"openclaw_dev_identity"`. This ensures the principal is
 * stable across page reloads, which is important because canister state
 * (balances, profiles, conversations) is keyed by principal.
 *
 * @returns The deserialized identity, or `null` if none exists or it is corrupted.
 */
function getDevIdentity(): Ed25519KeyIdentity | null {
  const KEY = "openclaw_dev_identity";
  const stored = localStorage.getItem(KEY);
  if (stored) {
    try {
      return Ed25519KeyIdentity.fromJSON(stored);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Create an authenticated {@link HttpAgent} suitable for calling OpenClaw canisters.
 *
 * Identity resolution order:
 * 1. If running locally, the persisted Ed25519 dev identity takes priority.
 * 2. Otherwise, if `authClientOrIdentity` is an {@link AuthClient}, its
 *    delegation identity is extracted via `getIdentity()`.
 * 3. Otherwise, `authClientOrIdentity` is used directly as an {@link Identity}.
 *
 * On local replicas the agent also calls `fetchRootKey()` which is necessary
 * because the local replica's root key is ephemeral and not the same as the
 * hard-coded mainnet root key.
 *
 * @param authClientOrIdentity - An optional {@link AuthClient} (from Internet Identity login)
 *   or a raw {@link Identity}. Ignored in local dev mode when a dev identity exists.
 * @returns A configured {@link HttpAgent} ready to create canister actors.
 *
 * @example
 * ```ts
 * const agent = await createAgent(authClient);
 * const gateway = createGatewayActor(agent);
 * ```
 */
export async function createAgent(authClientOrIdentity?: AuthClient | Identity): Promise<HttpAgent> {
  let identity: Identity | undefined;

  // In local dev, prefer the stored Ed25519 identity for a stable principal
  if (isLocal()) {
    const devId = getDevIdentity();
    if (devId) identity = devId as unknown as Identity;
  }

  // Fall back to the provided AuthClient or raw Identity
  if (!identity && authClientOrIdentity) {
    if ("getIdentity" in authClientOrIdentity) {
      identity = (authClientOrIdentity as AuthClient).getIdentity();
    } else {
      identity = authClientOrIdentity as Identity;
    }
  }

  const agent = await HttpAgent.create({
    identity,
    host: getHost(),
  });

  // Local replicas use an ephemeral root key that must be fetched at runtime.
  // NEVER call fetchRootKey() in production — it would be a security risk.
  if (isLocal()) {
    await agent.fetchRootKey();
  }

  return agent;
}

// TODO: Generate typed actors from .did files using @icp-sdk/bindgen
// For now, actors will be created manually when canister IDs are known

export {
  GATEWAY_CANISTER_ID,
  KEYVAULT_CANISTER_ID,
  WALLET_CANISTER_ID,
  IDENTITY_CANISTER_ID,
};
