import { IDL } from "@icp-sdk/core/candid";
import { Actor, HttpAgent, type ActorSubclass } from "@icp-sdk/core/agent";
import { KEYVAULT_CANISTER_ID } from "./agent";

// ── Candid IDL ──────────────────────────────────────────────────

const Result = IDL.Variant({ ok: IDL.Null, err: IDL.Text });
const ResultBlob = IDL.Variant({ ok: IDL.Vec(IDL.Nat8), err: IDL.Text });

export const idlFactory: IDL.InterfaceFactory = ({ IDL: _IDL }) => {
  return IDL.Service({
    // vetKD key derivation
    getVetkeyVerificationKey: IDL.Func([], [IDL.Vec(IDL.Nat8)], []),
    getEncryptedVetkey: IDL.Func([IDL.Vec(IDL.Nat8)], [ResultBlob], []),
    // Key storage
    storeEncryptedKey: IDL.Func([IDL.Text, IDL.Vec(IDL.Nat8)], [Result], []),
    getEncryptedKey: IDL.Func([IDL.Principal, IDL.Text], [ResultBlob], []),
    hasKey: IDL.Func([IDL.Text], [IDL.Bool], ["query"]),
    deleteKey: IDL.Func([IDL.Text], [Result], []),
    health: IDL.Func([], [IDL.Text], ["query"]),
  });
};

// ── TypeScript types ────────────────────────────────────────────

export type KeyVaultResult = { ok: null } | { err: string };
export type KeyVaultBlobResult = { ok: Uint8Array | number[] } | { err: string };

export interface KeyVaultService {
  getVetkeyVerificationKey: () => Promise<Uint8Array | number[]>;
  getEncryptedVetkey: (transportPubKey: Uint8Array | number[]) => Promise<KeyVaultBlobResult>;
  storeEncryptedKey: (keyId: string, blob: Uint8Array | number[]) => Promise<KeyVaultResult>;
  hasKey: (keyId: string) => Promise<boolean>;
  deleteKey: (keyId: string) => Promise<KeyVaultResult>;
  health: () => Promise<string>;
}

// ── Actor helper ────────────────────────────────────────────────

export function createKeyVaultActor(
  agent: HttpAgent,
  canisterId?: string,
): ActorSubclass<KeyVaultService> {
  return Actor.createActor<KeyVaultService>(idlFactory, {
    agent,
    canisterId: canisterId ?? KEYVAULT_CANISTER_ID,
  });
}
