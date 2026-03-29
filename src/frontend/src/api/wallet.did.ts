/**
 * @file Hand-written Candid IDL factory and TypeScript types for the **Wallet** canister.
 *
 * The Wallet canister manages per-user token balances for ICP, ckBTC, and ckUSDC.
 * It supports:
 * - **Deposits** — Each user gets a unique ICRC-1 subaccount. After transferring
 *   tokens to that address externally, the user calls `notifyDeposit` to credit
 *   their in-canister balance.
 * - **Withdrawals** — Transfer tokens from the in-canister balance to an
 *   arbitrary principal + subaccount.
 * - **LLM fees** — The gateway canister debits the user's balance when external
 *   model calls are made (recorded as `LlmFee` transactions).
 * - **Transaction history** — Full ledger of deposits, withdrawals, fees, and refunds.
 *
 * See {@link ./gateway.did.ts} for Candid-to-JS type mapping conventions.
 *
 * @module api/wallet.did
 */

import { IDL } from "@icp-sdk/core/candid";
import { Actor, HttpAgent, type ActorSubclass } from "@icp-sdk/core/agent";
import { WALLET_CANISTER_ID } from "./agent";

// ── Candid IDL ──────────────────────────────────────────────────

/** Supported token types. Each variant maps to an ICRC-1 ledger canister. */
const TokenType = IDL.Variant({
  ICP: IDL.Null,
  ckBTC: IDL.Null,
  ckUSDC: IDL.Null,
});

/** Categorizes a transaction in the wallet's history. */
const TransactionType = IDL.Variant({
  Deposit: IDL.Null,
  Withdrawal: IDL.Null,
  LlmFee: IDL.Null,
  Refund: IDL.Null,
});

/** ICRC-1 account: a principal with an optional 32-byte subaccount. */
const Account = IDL.Record({
  owner: IDL.Principal,
  subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
});

/** A single entry in the wallet's transaction history. */
const TransactionRecord = IDL.Record({
  id: IDL.Nat,
  tokenType: TokenType,
  amount: IDL.Nat,
  txType: TransactionType,
  counterparty: IDL.Opt(IDL.Principal),
  memo: IDL.Opt(IDL.Text),
  timestamp: IDL.Int,
});

/** The unique deposit address (principal + subaccount) assigned to a user for a token. */
const DepositAddress = IDL.Record({
  owner: IDL.Principal,
  subaccount: IDL.Vec(IDL.Nat8),
});

/** Result with no success payload. */
const Result = IDL.Variant({ ok: IDL.Null, err: IDL.Text });
/** Result carrying a `nat` on success (e.g. amount deposited or block height). */
const ResultNat = IDL.Variant({ ok: IDL.Nat, err: IDL.Text });
/** Result carrying a list of `(token name, balance)` tuples. */
const ResultBalances = IDL.Variant({
  ok: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Nat)),
  err: IDL.Text,
});
/** Result carrying a list of transaction records. */
const ResultTxs = IDL.Variant({
  ok: IDL.Vec(TransactionRecord),
  err: IDL.Text,
});
/** Result carrying a deposit address. */
const ResultDeposit = IDL.Variant({ ok: DepositAddress, err: IDL.Text });

/**
 * Candid IDL factory for the Wallet canister.
 *
 * Methods:
 * - `getAllBalances`     — Return all token balances for the caller (query).
 * - `getTokenBalance`   — Return a single token's balance (query).
 * - `getTransactions`   — Return the caller's full transaction history (query).
 * - `getDepositAddress` — Return the caller's unique deposit address for a token (query).
 * - `notifyDeposit`     — Check for new deposits and credit the caller's balance (update).
 * - `withdraw`          — Transfer tokens out to an ICRC-1 account (update).
 * - `getCycleBalance`   — Return the canister's remaining cycles (query).
 * - `health`            — Liveness check (query).
 */
export const idlFactory: IDL.InterfaceFactory = ({ IDL: _IDL }) => {
  return IDL.Service({
    getAllBalances: IDL.Func([], [ResultBalances], ["query"]),
    getTokenBalance: IDL.Func([TokenType], [ResultNat], ["query"]),
    getTransactions: IDL.Func([], [ResultTxs], ["query"]),
    getDepositAddress: IDL.Func([TokenType], [ResultDeposit], ["query"]),
    notifyDeposit: IDL.Func([TokenType], [ResultNat], []),
    withdraw: IDL.Func([TokenType, IDL.Nat, Account], [ResultNat], []),
    getCycleBalance: IDL.Func([], [IDL.Nat], ["query"]),
    health: IDL.Func([], [IDL.Text], ["query"]),
  });
};

// ── TypeScript types ────────────────────────────────────────────

/**
 * Supported token type variant.
 * Exactly one key will be present; the `null` value is the Candid unit-variant convention.
 */
export type TokenTypeVariant =
  | { ICP: null }
  | { ckBTC: null }
  | { ckUSDC: null };

/**
 * Transaction category variant.
 * - `Deposit`    — Tokens credited after `notifyDeposit`.
 * - `Withdrawal` — Tokens sent out via `withdraw`.
 * - `LlmFee`    — Automatic deduction for an external LLM call.
 * - `Refund`     — Tokens returned after a failed LLM call.
 */
export type TransactionTypeVariant =
  | { Deposit: null }
  | { Withdrawal: null }
  | { LlmFee: null }
  | { Refund: null };

/** A single transaction record from the wallet's on-chain history. */
export interface TransactionRecord {
  /** Sequential transaction ID. */
  id: bigint;
  /** Which token was involved. */
  tokenType: TokenTypeVariant;
  /** Amount in the token's smallest unit (e.g. e8s for ICP). */
  amount: bigint;
  /** Category of this transaction. */
  txType: TransactionTypeVariant;
  /** The other party's principal, if applicable. `[]` = none. */
  counterparty: [] | [Uint8Array];
  /** Human-readable memo. `[]` = none. */
  memo: [] | [string];
  /** Nanosecond timestamp of the transaction. */
  timestamp: bigint;
}

/**
 * A user's unique deposit address for a specific token.
 * To deposit, the user transfers tokens to `(owner, subaccount)` via the
 * relevant ICRC-1 ledger, then calls `notifyDeposit`.
 */
export interface DepositAddress {
  owner: Uint8Array;
  subaccount: Uint8Array;
}

/**
 * Generic result type for wallet canister calls.
 * @typeParam T - The success payload type.
 */
export type WalletResult<T> = { ok: T } | { err: string };

/** Strongly-typed service interface for the Wallet canister actor. */
export interface WalletService {
  /** Get all token balances as `[tokenName, amount]` tuples. */
  getAllBalances: () => Promise<WalletResult<[string, bigint][]>>;
  /** Get the balance for a single token type. */
  getTokenBalance: (token: TokenTypeVariant) => Promise<WalletResult<bigint>>;
  /** Get the caller's full transaction history. */
  getTransactions: () => Promise<WalletResult<TransactionRecord[]>>;
  /** Get the caller's unique deposit address for a token type. */
  getDepositAddress: (token: TokenTypeVariant) => Promise<WalletResult<DepositAddress>>;
  /**
   * Notify the canister of a deposit. The canister checks the ICRC-1 ledger
   * for new incoming transfers and credits the caller's balance.
   * @returns The amount credited (0n if no new deposit found).
   */
  notifyDeposit: (token: TokenTypeVariant) => Promise<WalletResult<bigint>>;
  /**
   * Withdraw tokens to an external ICRC-1 account.
   * @param token - Which token to withdraw.
   * @param amount - Amount in smallest units.
   * @param to - Destination account (principal + optional subaccount).
   * @returns The ledger block height of the transfer.
   */
  withdraw: (
    token: TokenTypeVariant,
    amount: bigint,
    to: { owner: Uint8Array; subaccount: [] | [Uint8Array] },
  ) => Promise<WalletResult<bigint>>;
  /** Get the canister's remaining cycle balance. */
  getCycleBalance: () => Promise<bigint>;
  /** Canister health check. */
  health: () => Promise<string>;
}

// ── Actor helper ────────────────────────────────────────────────

/**
 * Create a typed actor for the Wallet canister.
 *
 * @param agent - An authenticated {@link HttpAgent} (from {@link createAgent}).
 * @param canisterId - Optional override; defaults to `VITE_WALLET_CANISTER_ID`.
 * @returns An {@link ActorSubclass} typed to {@link WalletService}.
 */
export function createWalletActor(
  agent: HttpAgent,
  canisterId?: string,
): ActorSubclass<WalletService> {
  return Actor.createActor<WalletService>(idlFactory, {
    agent,
    canisterId: canisterId ?? WALLET_CANISTER_ID,
  });
}
