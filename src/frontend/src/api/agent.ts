import { HttpAgent, Actor, ActorSubclass, Identity } from "@icp-sdk/core/agent";
import { AuthClient } from "@icp-sdk/auth/client";
import { Ed25519KeyIdentity } from "@dfinity/identity";

// Canister IDs will be injected by icp-cli via ic_env cookie
// For local development, these can be overridden
const GATEWAY_CANISTER_ID = import.meta.env.VITE_GATEWAY_CANISTER_ID ?? "";
const KEYVAULT_CANISTER_ID = import.meta.env.VITE_KEYVAULT_CANISTER_ID ?? "";
const WALLET_CANISTER_ID = import.meta.env.VITE_WALLET_CANISTER_ID ?? "";
const IDENTITY_CANISTER_ID = import.meta.env.VITE_IDENTITY_CANISTER_ID ?? "";

function getHost(): string {
  if (isLocal()) {
    return "http://127.0.0.1:4943";
  }
  return window.location.origin;
}

export function isLocal(): boolean {
  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

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
 * Create an authenticated HttpAgent.
 * In local dev mode, uses the stored Ed25519 identity.
 * In production, uses the AuthClient identity from II.
 */
export async function createAgent(authClientOrIdentity?: AuthClient | Identity): Promise<HttpAgent> {
  let identity: Identity | undefined;

  if (isLocal()) {
    const devId = getDevIdentity();
    if (devId) identity = devId as unknown as Identity;
  }

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
