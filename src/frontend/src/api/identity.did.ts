/**
 * @file Hand-written Candid IDL factory and TypeScript types for the **Identity** canister.
 *
 * The Identity canister stores on-chain agent profiles for OpenClaw users.
 * Each profile is keyed by the caller's principal and includes:
 * - A human-readable display name and description.
 * - A list of self-declared capabilities (e.g. "coding", "research").
 * - Usage statistics: total prompt count and reputation score (updated by the
 *   gateway canister after each successful prompt).
 *
 * See {@link ./gateway.did.ts} for Candid-to-JS type mapping conventions.
 *
 * @module api/identity.did
 */

import { IDL } from "@icp-sdk/core/candid";
import { Actor, HttpAgent, type ActorSubclass } from "@icp-sdk/core/agent";
import { IDENTITY_CANISTER_ID } from "./agent";

// ── Candid IDL ──────────────────────────────────────────────────

/** On-chain agent profile record. Reputation and totalPrompts are managed by the canister. */
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

/** Result type for profile operations — success returns the full profile. */
const Result = IDL.Variant({ ok: AgentProfile, err: IDL.Text });

/**
 * Candid IDL factory for the Identity canister.
 *
 * Methods:
 * - `upsertProfile`    — Create or update the caller's profile (update call).
 *   Accepts `(displayName, description, capabilities)`.
 * - `getMyProfile`     — Retrieve the caller's own profile (query).
 * - `getProfile`       — Retrieve any user's profile by principal (query).
 *   Returns `opt AgentProfile` — `[]` if not found, `[profile]` if found.
 * - `getProfileCount`  — Total number of registered profiles (query).
 * - `getCycleBalance`  — Canister's remaining cycles (query).
 * - `health`           — Liveness check (query).
 */
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

/**
 * TypeScript mirror of the on-chain `AgentProfile` record.
 *
 * The `owner` field is the raw principal bytes. `reputation` and `totalPrompts`
 * are `bigint` because Candid `nat` maps to JavaScript `BigInt`.
 * Timestamps (`createdAt`, `updatedAt`) are nanoseconds since the Unix epoch.
 */
export interface AgentProfile {
  /** Raw bytes of the owning principal. */
  owner: Uint8Array;
  /** Human-readable agent name (max 100 chars). */
  displayName: string;
  /** Free-text description of what the agent does (max 500 chars). */
  description: string;
  /** Self-declared capabilities, e.g. ["coding", "research", "writing"]. */
  capabilities: string[];
  /** Reputation score, incremented by the gateway on successful prompts. */
  reputation: bigint;
  /** Total number of prompts this agent has sent. */
  totalPrompts: bigint;
  /** Profile creation time (nanoseconds since Unix epoch). */
  createdAt: bigint;
  /** Last profile update time (nanoseconds since Unix epoch). */
  updatedAt: bigint;
}

/**
 * Result type for identity canister calls that return a profile on success.
 */
export type IdentityResult = { ok: AgentProfile } | { err: string };

/** Strongly-typed service interface for the Identity canister actor. */
export interface IdentityService {
  /**
   * Create or update the caller's agent profile.
   * @param displayName - The agent's display name.
   * @param description - A description of the agent's purpose.
   * @param capabilities - A list of capability tags.
   * @returns The updated profile on success.
   */
  upsertProfile: (
    displayName: string,
    description: string,
    capabilities: string[],
  ) => Promise<IdentityResult>;

  /** Retrieve the authenticated caller's own profile. */
  getMyProfile: () => Promise<IdentityResult>;

  /**
   * Look up any user's profile by their principal.
   * @returns `[]` if no profile exists, `[profile]` if found (Candid `opt` convention).
   */
  getProfile: (principal: Uint8Array) => Promise<[] | [AgentProfile]>;

  /** Get the total number of registered agent profiles. */
  getProfileCount: () => Promise<bigint>;

  /** Get the canister's remaining cycle balance. */
  getCycleBalance: () => Promise<bigint>;

  /** Canister health check. */
  health: () => Promise<string>;
}

// ── Actor helper ────────────────────────────────────────────────

/**
 * Create a typed actor for the Identity canister.
 *
 * @param agent - An authenticated {@link HttpAgent} (from {@link createAgent}).
 * @param canisterId - Optional override; defaults to `VITE_IDENTITY_CANISTER_ID`.
 * @returns An {@link ActorSubclass} typed to {@link IdentityService}.
 */
export function createIdentityActor(
  agent: HttpAgent,
  canisterId?: string,
): ActorSubclass<IdentityService> {
  return Actor.createActor<IdentityService>(idlFactory, {
    agent,
    canisterId: canisterId ?? IDENTITY_CANISTER_ID,
  });
}
