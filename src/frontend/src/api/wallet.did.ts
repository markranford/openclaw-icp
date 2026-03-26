import { IDL } from "@icp-sdk/core/candid";
import { Actor, HttpAgent, type ActorSubclass } from "@icp-sdk/core/agent";
import { WALLET_CANISTER_ID } from "./agent";

// ── Candid IDL ──────────────────────────────────────────────────

const TokenType = IDL.Variant({
  ICP: IDL.Null,
  ckBTC: IDL.Null,
  ckUSDC: IDL.Null,
});

const TransactionType = IDL.Variant({
  Deposit: IDL.Null,
  Withdrawal: IDL.Null,
  LlmFee: IDL.Null,
  Refund: IDL.Null,
});

const Account = IDL.Record({
  owner: IDL.Principal,
  subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
});

const TransactionRecord = IDL.Record({
  id: IDL.Nat,
  tokenType: TokenType,
  amount: IDL.Nat,
  txType: TransactionType,
  counterparty: IDL.Opt(IDL.Principal),
  memo: IDL.Opt(IDL.Text),
  timestamp: IDL.Int,
});

const DepositAddress = IDL.Record({
  owner: IDL.Principal,
  subaccount: IDL.Vec(IDL.Nat8),
});

const Result = IDL.Variant({ ok: IDL.Null, err: IDL.Text });
const ResultNat = IDL.Variant({ ok: IDL.Nat, err: IDL.Text });
const ResultBalances = IDL.Variant({
  ok: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Nat)),
  err: IDL.Text,
});
const ResultTxs = IDL.Variant({
  ok: IDL.Vec(TransactionRecord),
  err: IDL.Text,
});
const ResultDeposit = IDL.Variant({ ok: DepositAddress, err: IDL.Text });

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

export type TokenTypeVariant =
  | { ICP: null }
  | { ckBTC: null }
  | { ckUSDC: null };

export type TransactionTypeVariant =
  | { Deposit: null }
  | { Withdrawal: null }
  | { LlmFee: null }
  | { Refund: null };

export interface TransactionRecord {
  id: bigint;
  tokenType: TokenTypeVariant;
  amount: bigint;
  txType: TransactionTypeVariant;
  counterparty: [] | [Uint8Array];
  memo: [] | [string];
  timestamp: bigint;
}

export interface DepositAddress {
  owner: Uint8Array;
  subaccount: Uint8Array;
}

export type WalletResult<T> = { ok: T } | { err: string };

export interface WalletService {
  getAllBalances: () => Promise<WalletResult<[string, bigint][]>>;
  getTokenBalance: (token: TokenTypeVariant) => Promise<WalletResult<bigint>>;
  getTransactions: () => Promise<WalletResult<TransactionRecord[]>>;
  getDepositAddress: (token: TokenTypeVariant) => Promise<WalletResult<DepositAddress>>;
  notifyDeposit: (token: TokenTypeVariant) => Promise<WalletResult<bigint>>;
  withdraw: (
    token: TokenTypeVariant,
    amount: bigint,
    to: { owner: Uint8Array; subaccount: [] | [Uint8Array] },
  ) => Promise<WalletResult<bigint>>;
  getCycleBalance: () => Promise<bigint>;
  health: () => Promise<string>;
}

// ── Actor helper ────────────────────────────────────────────────

export function createWalletActor(
  agent: HttpAgent,
  canisterId?: string,
): ActorSubclass<WalletService> {
  return Actor.createActor<WalletService>(idlFactory, {
    agent,
    canisterId: canisterId ?? WALLET_CANISTER_ID,
  });
}
