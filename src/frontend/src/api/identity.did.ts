import { IDL } from "@icp-sdk/core/candid";
import { Actor, HttpAgent, type ActorSubclass } from "@icp-sdk/core/agent";
import { IDENTITY_CANISTER_ID } from "./agent";

// ── Candid IDL ──────────────────────────────────────────────────

const AgentProfile = IDL.Record({
  owner: IDL.Principal,
  displayName: IDL.Text,
  description: IDL.Text,
  capabilities: IDL.Vec(IDL.Text),
  reputation: IDL.Nat,
  totalPrompts: IDL.Nat,
  createdAt: IDL.Int,
  updatedAt: IDL.Int,
});

const Result = IDL.Variant({ ok: AgentProfile, err: IDL.Text });

export const idlFactory: IDL.InterfaceFactory = ({ IDL: _IDL }) => {
  return IDL.Service({
    upsertProfile: IDL.Func([IDL.Text, IDL.Text, IDL.Vec(IDL.Text)], [Result], []),
    getMyProfile: IDL.Func([], [Result], ["query"]),
    getProfile: IDL.Func([IDL.Principal], [IDL.Opt(AgentProfile)], ["query"]),
    getProfileCount: IDL.Func([], [IDL.Nat], ["query"]),
    getCycleBalance: IDL.Func([], [IDL.Nat], ["query"]),
    health: IDL.Func([], [IDL.Text], ["query"]),
  });
};

// ── TypeScript types ────────────────────────────────────────────

export interface AgentProfile {
  owner: Uint8Array;
  displayName: string;
  description: string;
  capabilities: string[];
  reputation: bigint;
  totalPrompts: bigint;
  createdAt: bigint;
  updatedAt: bigint;
}

export type IdentityResult = { ok: AgentProfile } | { err: string };

export interface IdentityService {
  upsertProfile: (
    displayName: string,
    description: string,
    capabilities: string[],
  ) => Promise<IdentityResult>;
  getMyProfile: () => Promise<IdentityResult>;
  getProfile: (principal: Uint8Array) => Promise<[] | [AgentProfile]>;
  getProfileCount: () => Promise<bigint>;
  getCycleBalance: () => Promise<bigint>;
  health: () => Promise<string>;
}

// ── Actor helper ────────────────────────────────────────────────

export function createIdentityActor(
  agent: HttpAgent,
  canisterId?: string,
): ActorSubclass<IdentityService> {
  return Actor.createActor<IdentityService>(idlFactory, {
    agent,
    canisterId: canisterId ?? IDENTITY_CANISTER_ID,
  });
}
