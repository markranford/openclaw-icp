/// OpenClaw ICP — Wallet Canister
/// ICRC-1/2 token management with saga pattern for safe deposits/withdrawals
/// Security: CallerGuard, anonymous rejection, created_at_time dedup, saga compensation
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Nat "mo:base/Nat";
import Nat8 "mo:base/Nat8";
import Nat64 "mo:base/Nat64";
import Int "mo:base/Int";
import Text "mo:base/Text";
import Time "mo:base/Time";
import Blob "mo:base/Blob";
import Buffer "mo:base/Buffer";
import Result "mo:base/Result";
import Array "mo:base/Array";
import Cycles "mo:base/ExperimentalCycles";

import Types "../gateway/Types";
import Auth "../gateway/Auth";

persistent actor class Wallet(deployer : Principal) = self {

  // ── Types ───────────────────────────────────────────────────────
  type TokenType = Types.TokenType;
  type TransactionRecord = Types.TransactionRecord;
  type TransactionType = Types.TransactionType;
  type Account = Types.Account;

  // ── ICRC-1 Ledger Interface ───────────────────────────────────
  type ICRC1Ledger = actor {
    icrc1_balance_of : shared query (Account) -> async Nat;
    icrc1_transfer : shared ({
      to : Account;
      amount : Nat;
      fee : ?Nat;
      memo : ?Blob;
      from_subaccount : ?Blob;
      created_at_time : ?Nat64;
    }) -> async { #Ok : Nat; #Err : Types.ICRC1TransferError };
    icrc1_fee : shared query () -> async Nat;
  };

  // ── Constants ─────────────────────────────────────────────────
  let MAX_TRANSACTIONS_PER_USER : Nat = 1000;

  // Ledger canister IDs (mainnet)
  let ICP_LEDGER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  let CKBTC_LEDGER_ID = "mxzaz-hqaaa-aaaar-qaada-cai";
  let CKUSDC_LEDGER_ID = "xevnm-gaaaa-aaaar-qafnq-cai";

  // Transfer fees in smallest units
  let ICP_FEE : Nat = 10_000;       // 0.0001 ICP (8 decimals)
  let CKBTC_FEE : Nat = 10;         // 10 satoshis (8 decimals)
  let CKUSDC_FEE : Nat = 10_000;    // 0.01 ckUSDC (6 decimals)

  // ── State ─────────────────────────────────────────────────────

  transient let principalOps = Map.Make<Principal>(Principal.compare);
  transient let textOps = Map.Make<Text>(Text.compare);

  // Internal balances: user → (token_text → amount)
  var balances : Map.Map<Principal, Map.Map<Text, Nat>> = principalOps.empty();

  // Last notified balance per user per token (prevents double-credit on deposit)
  var lastNotifiedBalance : Map.Map<Principal, Map.Map<Text, Nat>> = principalOps.empty();

  // Transaction history per user
  var transactions : Map.Map<Principal, [TransactionRecord]> = principalOps.empty();

  // Counter for transaction IDs
  var txCounter : Nat = 0;

  // Authorized gateway canister for pay-per-request deductions
  var gatewayPrincipal : ?Principal = null;

  // Admin
  let admin : Principal = deployer;

  // ── Transient ─────────────────────────────────────────────────
  transient let guard = Auth.CallerGuard();

  // ── Ledger References (transient — recreated after upgrade) ───
  transient let icpLedger : ICRC1Ledger = actor (ICP_LEDGER_ID);
  transient let ckbtcLedger : ICRC1Ledger = actor (CKBTC_LEDGER_ID);
  transient let ckusdcLedger : ICRC1Ledger = actor (CKUSDC_LEDGER_ID);

  // ── Helpers ───────────────────────────────────────────────────

  func tokenToText(t : TokenType) : Text {
    switch (t) {
      case (#ICP) { "ICP" };
      case (#ckBTC) { "ckBTC" };
      case (#ckUSDC) { "ckUSDC" };
    };
  };

  func getLedger(t : TokenType) : ICRC1Ledger {
    switch (t) {
      case (#ICP) { icpLedger };
      case (#ckBTC) { ckbtcLedger };
      case (#ckUSDC) { ckusdcLedger };
    };
  };

  func getFee(t : TokenType) : Nat {
    switch (t) {
      case (#ICP) { ICP_FEE };
      case (#ckBTC) { CKBTC_FEE };
      case (#ckUSDC) { CKUSDC_FEE };
    };
  };

  /// Deterministic 32-byte subaccount from principal (ckBTC-compatible)
  func userSubaccount(user : Principal) : Blob {
    let principalBlob = Principal.toBlob(user);
    let bytes = Blob.toArray(principalBlob);
    let buf = Buffer.Buffer<Nat8>(32);
    buf.add(Nat8.fromNat(bytes.size())); // length prefix
    for (b in bytes.vals()) { buf.add(b) };
    while (buf.size() < 32) { buf.add(0 : Nat8) };
    Blob.fromArray(Buffer.toArray(buf));
  };

  func now() : Nat64 {
    Nat64.fromNat(Int.abs(Time.now()));
  };

  func getBalance(user : Principal, token : Text) : Nat {
    switch (principalOps.get(balances, user)) {
      case null { 0 };
      case (?userBals) {
        switch (textOps.get(userBals, token)) {
          case null { 0 };
          case (?bal) { bal };
        };
      };
    };
  };

  func setBalance(user : Principal, token : Text, amount : Nat) {
    let userBals = switch (principalOps.get(balances, user)) {
      case null { textOps.empty() };
      case (?b) { b };
    };
    let updated = textOps.put(userBals, token, amount);
    balances := principalOps.put(balances, user, updated);
  };

  func getLastNotified(user : Principal, token : Text) : Nat {
    switch (principalOps.get(lastNotifiedBalance, user)) {
      case null { 0 };
      case (?userLast) {
        switch (textOps.get(userLast, token)) {
          case null { 0 };
          case (?n) { n };
        };
      };
    };
  };

  func setLastNotified(user : Principal, token : Text, amount : Nat) {
    let userLast = switch (principalOps.get(lastNotifiedBalance, user)) {
      case null { textOps.empty() };
      case (?l) { l };
    };
    let updated = textOps.put(userLast, token, amount);
    lastNotifiedBalance := principalOps.put(lastNotifiedBalance, user, updated);
  };

  func recordTransaction(user : Principal, record : TransactionRecord) {
    let existing = switch (principalOps.get(transactions, user)) {
      case null { [] };
      case (?txs) { txs };
    };
    // Prune if exceeding limit (keep newest)
    let pruned = if (existing.size() >= MAX_TRANSACTIONS_PER_USER) {
      Array.tabulate<TransactionRecord>(
        MAX_TRANSACTIONS_PER_USER - 1,
        func(i) { existing[i + 1] },
      );
    } else { existing };
    let buf = Buffer.fromArray<TransactionRecord>(pruned);
    buf.add(record);
    transactions := principalOps.put(transactions, user, Buffer.toArray(buf));
  };

  func nextTxId() : Nat {
    txCounter += 1;
    txCounter;
  };

  // ── Admin ─────────────────────────────────────────────────────

  public shared (msg) func setGateway(gateway : Principal) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    gatewayPrincipal := ?gateway;
    #ok(());
  };

  // ── Deposit Flow (Saga Pattern) ───────────────────────────────

  /// Get the deposit address for a specific token
  public shared query (msg) func getDepositAddress(token : TokenType) : async Result.Result<{ owner : Principal; subaccount : Blob }, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    #ok({
      owner = Principal.fromActor(self);
      subaccount = userSubaccount(msg.caller);
    });
  };

  /// Notify the wallet that a deposit has been made. Credits the delta.
  /// Saga: credit internal balance BEFORE sweep await; compensate on sweep failure.
  public shared (msg) func notifyDeposit(token : TokenType) : async Result.Result<Nat, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };

    switch (guard.acquire(msg.caller)) {
      case (#err(_)) { return #err("Already processing") };
      case (#ok(())) {};
    };

    try {
      let caller = msg.caller; // capture before await (S7)
      let tokenText = tokenToText(token);
      let ledger = getLedger(token);
      let sub = userSubaccount(caller);

      // 1. Check on-chain balance at user's subaccount
      let onChainBalance = await ledger.icrc1_balance_of({
        owner = Principal.fromActor(self);
        subaccount = ?sub;
      });

      // 2. Calculate delta (new deposit amount)
      let lastNotified = getLastNotified(caller, tokenText);
      if (onChainBalance <= lastNotified) {
        return #ok(0); // No new deposit
      };
      let delta = onChainBalance - lastNotified;

      // 3. SAGA: Update state BEFORE sweep await (S2)
      let oldLastNotified = lastNotified;
      let oldBalance = getBalance(caller, tokenText);
      setLastNotified(caller, tokenText, onChainBalance);
      setBalance(caller, tokenText, oldBalance + delta);

      // 4. Sweep from subaccount to default account
      let fee = getFee(token);
      if (delta > fee) {
        let sweepResult = await ledger.icrc1_transfer({
          from_subaccount = ?sub;
          to = { owner = Principal.fromActor(self); subaccount = null };
          amount = delta - fee;
          fee = ?fee;
          memo = null;
          created_at_time = ?now(); // S8: dedup protection
        });

        switch (sweepResult) {
          case (#Err(_)) {
            // COMPENSATE: rollback state changes
            setLastNotified(caller, tokenText, oldLastNotified);
            setBalance(caller, tokenText, oldBalance);
            return #err("Sweep transfer failed — deposit not credited");
          };
          case (#Ok(_)) {};
        };
      };
      // If delta <= fee, skip sweep (not worth the fee) but still credit

      // 5. Record transaction
      recordTransaction(caller, {
        id = nextTxId();
        tokenType = token;
        amount = delta;
        txType = #Deposit;
        counterparty = ?caller;
        memo = ?"Deposit via notifyDeposit";
        timestamp = Time.now();
      });

      #ok(delta);
    } catch (_) {
      #err("Deposit notification failed");
    } finally {
      guard.release(msg.caller);
    };
  };

  // ── Withdraw Flow (Saga Pattern) ──────────────────────────────

  /// Withdraw tokens to an external account
  /// Saga: debit internal BEFORE ledger await; re-credit on failure (S2)
  public shared (msg) func withdraw(
    token : TokenType,
    amount : Nat,
    to : Account,
  ) : async Result.Result<Nat, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };

    switch (guard.acquire(msg.caller)) {
      case (#err(_)) { return #err("Already processing") };
      case (#ok(())) {};
    };

    try {
      let caller = msg.caller; // capture before await (S7)
      let tokenText = tokenToText(token);
      let fee = getFee(token);

      // Validate amount
      if (amount <= fee) {
        return #err("Amount must be greater than transfer fee (" # Nat.toText(fee) # ")");
      };

      let currentBalance = getBalance(caller, tokenText);
      if (currentBalance < amount) {
        return #err("Insufficient balance: have " # Nat.toText(currentBalance) # ", need " # Nat.toText(amount));
      };

      // SAGA: Debit BEFORE await (S2)
      setBalance(caller, tokenText, currentBalance - amount);

      let ledger = getLedger(token);
      let transferResult = await ledger.icrc1_transfer({
        from_subaccount = null; // from canister's default account
        to = to;
        amount = amount - fee; // user receives amount minus fee
        fee = ?fee;
        memo = null;
        created_at_time = ?now(); // S8
      });

      switch (transferResult) {
        case (#Err(e)) {
          // COMPENSATE: re-credit on failure
          setBalance(caller, tokenText, currentBalance);
          let errText = switch (e) {
            case (#InsufficientFunds({ balance })) {
              "Ledger insufficient funds (canister balance: " # Nat.toText(balance) # ")";
            };
            case (#BadFee({ expected_fee })) {
              "Wrong fee: expected " # Nat.toText(expected_fee);
            };
            case (#TemporarilyUnavailable) { "Ledger temporarily unavailable" };
            case (_) { "Transfer failed" };
          };
          return #err(errText);
        };
        case (#Ok(blockIndex)) {
          // Record transaction
          recordTransaction(caller, {
            id = nextTxId();
            tokenType = token;
            amount = amount;
            txType = #Withdrawal;
            counterparty = ?to.owner;
            memo = ?"Withdrawal";
            timestamp = Time.now();
          });
          #ok(blockIndex);
        };
      };
    } catch (_) {
      #err("Withdrawal failed");
    } finally {
      guard.release(msg.caller);
    };
  };

  // ── Gateway Pay-Per-Request ───────────────────────────────────

  /// Deduct a fee for an external LLM request (gateway-only)
  public shared (msg) func deductForRequest(
    user : Principal,
    token : TokenType,
    amount : Nat,
  ) : async Result.Result<(), Text> {
    switch (gatewayPrincipal) {
      case null { return #err("Gateway not configured") };
      case (?gw) {
        if (msg.caller != gw) { return #err("Unauthorized") };
      };
    };

    let tokenText = tokenToText(token);
    let currentBalance = getBalance(user, tokenText);
    if (currentBalance < amount) {
      return #err("Insufficient balance");
    };

    setBalance(user, tokenText, currentBalance - amount);
    recordTransaction(user, {
      id = nextTxId();
      tokenType = token;
      amount = amount;
      txType = #LlmFee;
      counterparty = null;
      memo = ?"External LLM request fee";
      timestamp = Time.now();
    });

    #ok(());
  };

  /// Refund a fee after a failed LLM request (gateway-only)
  public shared (msg) func refundForRequest(
    user : Principal,
    token : TokenType,
    amount : Nat,
  ) : async Result.Result<(), Text> {
    switch (gatewayPrincipal) {
      case null { return #err("Gateway not configured") };
      case (?gw) {
        if (msg.caller != gw) { return #err("Unauthorized") };
      };
    };

    let tokenText = tokenToText(token);
    let currentBalance = getBalance(user, tokenText);
    setBalance(user, tokenText, currentBalance + amount);
    recordTransaction(user, {
      id = nextTxId();
      tokenType = token;
      amount = amount;
      txType = #Refund;
      counterparty = null;
      memo = ?"Refund for failed LLM request";
      timestamp = Time.now();
    });

    #ok(());
  };

  // ── Query Functions ───────────────────────────────────────────

  /// Get balance for a specific token
  public shared query (msg) func getTokenBalance(token : TokenType) : async Result.Result<Nat, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    #ok(getBalance(msg.caller, tokenToText(token)));
  };

  /// Get all token balances
  public shared query (msg) func getAllBalances() : async Result.Result<[(Text, Nat)], Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    let tokens = ["ICP", "ckBTC", "ckUSDC"];
    let buf = Buffer.Buffer<(Text, Nat)>(3);
    for (t in tokens.vals()) {
      buf.add((t, getBalance(msg.caller, t)));
    };
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

  // ── Monitoring ────────────────────────────────────────────────

  /// Get canister cycle balance (S6: monitoring)
  public query func getCycleBalance() : async Nat {
    Cycles.balance();
  };

  /// Health check
  public query func health() : async Text {
    "OpenClaw Wallet v0.3.0 — ICRC-1 enabled";
  };
}
