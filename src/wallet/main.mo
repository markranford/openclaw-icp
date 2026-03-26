/// OpenClaw ICP — Wallet Canister
/// ICP + ckUSDC + ckBTC payments, pay-per-request metering
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Nat "mo:base/Nat";
import Text "mo:base/Text";
import Int "mo:base/Int";
import Time "mo:base/Time";
import Result "mo:base/Result";
import Buffer "mo:base/Buffer";

import Types "../gateway/Types";

persistent actor class Wallet(deployer : Principal) {

  // ── Types ───────────────────────────────────────────────────────
  type TokenType = Types.TokenType;
  type TransactionRecord = Types.TransactionRecord;

  // ── Well-known canister IDs ─────────────────────────────────────
  // ICP Ledger:   ryjl3-tyaaa-aaaaa-aaaba-cai
  // ckBTC Ledger: mxzaz-hqaaa-aaaar-qaada-cai
  // ckUSDC:       (to be confirmed)
  // ckETH Ledger: ss2fx-dyaaa-aaaar-qacoq-cai

  // ── State ───────────────────────────────────────────────────────

  transient let principalOps = Map.Make<Principal>(Principal.compare);

  // Internal balances per user per token type (tracked in e8s / smallest unit)
  // Map<Principal, Map<TokenType_Text, Nat>>
  transient let textOps = Map.Make<Text>(Text.compare);
  var balances : Map.Map<Principal, Map.Map<Text, Nat>> = principalOps.empty();

  // Transaction history per user
  var transactions : Map.Map<Principal, [TransactionRecord]> = principalOps.empty();

  // Transaction counter for IDs
  var txCounter : Nat = 0;

  // Authorized gateway canister for pay-per-request deductions
  var gatewayPrincipal : ?Principal = null;
  let admin : Principal = deployer;

  // ── Helpers ─────────────────────────────────────────────────────

  func tokenTypeToText(t : TokenType) : Text {
    switch (t) {
      case (#ICP) { "ICP" };
      case (#ckUSDC) { "ckUSDC" };
      case (#ckBTC) { "ckBTC" };
    };
  };

  func getBalance(user : Principal, token : TokenType) : Nat {
    let tokenKey = tokenTypeToText(token);
    switch (principalOps.get(balances, user)) {
      case null { 0 };
      case (?tokenMap) {
        switch (textOps.get(tokenMap, tokenKey)) {
          case null { 0 };
          case (?bal) { bal };
        };
      };
    };
  };

  func setBalance(user : Principal, token : TokenType, amount : Nat) {
    let tokenKey = tokenTypeToText(token);
    let tokenMap = switch (principalOps.get(balances, user)) {
      case null { textOps.empty() };
      case (?tm) { tm };
    };
    let updatedMap = textOps.put(tokenMap, tokenKey, amount);
    balances := principalOps.put(balances, user, updatedMap);
  };

  func recordTx(user : Principal, record : TransactionRecord) {
    let existing = switch (principalOps.get(transactions, user)) {
      case null { [] };
      case (?txs) { txs };
    };
    let buf = Buffer.fromArray<TransactionRecord>(existing);
    buf.add(record);
    transactions := principalOps.put(transactions, user, Buffer.toArray(buf));
  };

  // ── Admin ───────────────────────────────────────────────────────

  public shared (msg) func setGateway(gateway : Principal) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    gatewayPrincipal := ?gateway;
    #ok(());
  };

  // ── Public API ──────────────────────────────────────────────────

  /// Get balance for a specific token
  public shared query (msg) func getTokenBalance(token : TokenType) : async Result.Result<Nat, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    #ok(getBalance(msg.caller, token));
  };

  /// Get all balances
  public shared query (msg) func getAllBalances() : async Result.Result<[(Text, Nat)], Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    let buf = Buffer.Buffer<(Text, Nat)>(3);
    buf.add(("ICP", getBalance(msg.caller, #ICP)));
    buf.add(("ckUSDC", getBalance(msg.caller, #ckUSDC)));
    buf.add(("ckBTC", getBalance(msg.caller, #ckBTC)));
    #ok(Buffer.toArray(buf));
  };

  /// Get transaction history
  public shared query (msg) func getTransactions() : async Result.Result<[TransactionRecord], Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    switch (principalOps.get(transactions, msg.caller)) {
      case null { #ok([]) };
      case (?txs) { #ok(txs) };
    };
  };

  /// Deduct balance for a pay-per-request LLM call (only callable by Gateway)
  public shared (msg) func deductForRequest(user : Principal, token : TokenType, amount : Nat) : async Result.Result<(), Text> {
    switch (gatewayPrincipal) {
      case null { return #err("Gateway not configured") };
      case (?gw) {
        if (msg.caller != gw) { return #err("Unauthorized") };
      };
    };

    let currentBalance = getBalance(user, token);
    if (currentBalance < amount) {
      return #err("Insufficient balance");
    };

    setBalance(user, token, currentBalance - amount);

    txCounter += 1;
    recordTx(user, {
      id = txCounter;
      tokenType = token;
      amount = amount;
      direction = #Outgoing;
      counterparty = null; // self-reference
      memo = ?"LLM request fee";
      timestamp = Time.now();
    });

    #ok(());
  };

  // TODO: Phase 3 — ICRC-1 deposit/withdraw via ledger canister calls
  // TODO: Phase 6 — DEX swap integration (Kong, ICPSwap)

  /// Health check
  public query func health() : async Text {
    "OpenClaw Wallet v0.1.0 — operational";
  };
}
