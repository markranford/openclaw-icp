/// OpenClaw ICP — Wallet Canister
///
/// Manages user token balances (ICP, ckBTC, ckUSDC) with ICRC-1 ledger
/// integration for deposits and withdrawals. Also provides the pay-per-request
/// deduct/refund mechanism used by the Gateway for external LLM calls.
///
/// ## Key design patterns:
///
/// **Saga pattern for deposits:**
///   1. Query on-chain balance at the user's subaccount.
///   2. Compute delta = on-chain balance - lastNotifiedBalance.
///   3. Credit the user's internal balance (optimistic, before the sweep).
///   4. Sweep tokens from the user's subaccount to the canister's default account.
///   5. If the sweep fails, COMPENSATE: roll back the internal balance credit.
///
/// **Saga pattern for withdrawals:**
///   1. Debit the user's internal balance (optimistic, before the transfer).
///   2. Transfer tokens from the canister's default account to the destination.
///   3. If the transfer fails, COMPENSATE: re-credit the internal balance.
///
/// **Why lastNotifiedBalance exists:**
///   Without it, a user could call notifyDeposit twice for the same on-chain
///   transfer and get double-credited. lastNotifiedBalance tracks the on-chain
///   balance as of the last successful notification, so only the delta (new
///   deposits since last check) gets credited.
///
/// **Subaccount derivation scheme:**
///   Each user gets a unique ICRC-1 subaccount derived from their principal:
///     [principal_bytes.length] ++ [principal_bytes] ++ [zero-padding to 32 bytes]
///   This is length-prefixed to avoid collisions between principals of different
///   lengths, and zero-padded to exactly 32 bytes as required by ICRC-1.
///   This scheme is compatible with ckBTC and other ICRC-1 tokens.
///
/// **Configurable ledger IDs:**
///   The ICP, ckBTC, and ckUSDC ledger canister IDs default to their mainnet
///   values but can be reconfigured at runtime via admin setter functions
///   (setIcpLedger, setCkbtcLedger, setCkusdcLedger). For local development,
///   point these to locally deployed ledger replicas so deposit/withdraw work.
///   The IDs are persistent `var`s so they survive canister upgrades.
///
/// **Gateway pay-per-request cycle:**
///   The Gateway calls deductForRequest before an external LLM call, and
///   refundForRequest if the call fails. Both are gateway-only endpoints.
///   This is NOT the saga pattern per se (the saga is in the Gateway itself),
///   but these are the wallet-side primitives that enable it.
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

/// The Wallet actor class. `deployer` becomes the immutable admin.
/// `= self` binds the actor reference so we can use Principal.fromActor(self)
/// to get our own canister ID (needed for ICRC-1 account construction).
persistent actor class Wallet(deployer : Principal) = self {

  // ── Types ───────────────────────────────────────────────────────
  type TokenType = Types.TokenType;
  type TransactionRecord = Types.TransactionRecord;
  type TransactionType = Types.TransactionType;
  type Account = Types.Account;

  // ── ICRC-1 Ledger Interface ───────────────────────────────────
  // Minimal interface for the ICRC-1 ledger canisters we interact with.
  // Only the methods we actually call are declared here.
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
  // Transaction history per user is bounded to prevent unbounded memory growth.
  // When the limit is hit, the oldest transaction is pruned.
  let MAX_TRANSACTIONS_PER_USER : Nat = 1000;
  let LOW_CYCLES_THRESHOLD : Nat = 500_000_000_000; // 0.5T cycles

  // Ledger canister IDs — default to their MAINNET principals.
  // Configurable via admin setter functions so local dev can point to
  // locally deployed ledger canisters. The getLedger() helper creates
  // actor references dynamically from these IDs.
  var icpLedgerId : Text = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  var ckbtcLedgerId : Text = "mxzaz-hqaaa-aaaar-qaada-cai";
  var ckusdcLedgerId : Text = "xevnm-gaaaa-aaaar-qafnq-cai";

  // Transfer fees in the smallest unit (e8s for ICP/ckBTC, e6s for ckUSDC).
  // These are the standard ICRC-1 fees at time of writing. If the ledger
  // increases fees, transfers may fail with BadFee and we would need to update.
  let ICP_FEE : Nat = 10_000;       // 0.0001 ICP (8 decimals)
  let CKBTC_FEE : Nat = 10;         // 10 satoshis (8 decimals)
  let CKUSDC_FEE : Nat = 10_000;    // 0.01 ckUSDC (6 decimals)

  // ── State ─────────────────────────────────────────────────────

  // Transient comparators (see Gateway main.mo for explanation).
  transient let principalOps = Map.Make<Principal>(Principal.compare);
  transient let textOps = Map.Make<Text>(Text.compare);

  // Internal balances: user principal -> (token name string -> amount in smallest units).
  // These track what the user has deposited minus what they have withdrawn and spent.
  // They are the authoritative source for "how much can this user spend?".
  var balances : Map.Map<Principal, Map.Map<Text, Nat>> = principalOps.empty();

  // Last notified on-chain balance per user per token. Used by notifyDeposit to
  // compute the delta (new deposits since last check). Without this, calling
  // notifyDeposit twice would double-credit the same on-chain balance.
  var lastNotifiedBalance : Map.Map<Principal, Map.Map<Text, Nat>> = principalOps.empty();

  // Transaction history per user. Bounded to MAX_TRANSACTIONS_PER_USER entries;
  // oldest entries are pruned when the limit is exceeded.
  var transactions : Map.Map<Principal, [TransactionRecord]> = principalOps.empty();

  // Monotonically increasing counter for generating unique transaction IDs.
  var txCounter : Nat = 0;

  // The Gateway canister, authorised to call deductForRequest/refundForRequest.
  var gatewayPrincipal : ?Principal = null;

  // Admin is the deployer — immutable after construction
  let admin : Principal = deployer;

  // ── Transient ─────────────────────────────────────────────────
  // CallerGuard resets on upgrade (no in-flight operations after upgrade).
  transient let guard = Auth.CallerGuard();

  // Ledger actor references are now created dynamically by getLedger()
  // from the configurable ledger ID vars above. This ensures that after
  // calling setIcpLedger/setCkbtcLedger/setCkusdcLedger, subsequent
  // deposit/withdraw calls use the updated canister IDs.

  // ── Helpers ───────────────────────────────────────────────────

  // Convert TokenType variant to its string representation (used as map key).
  func tokenToText(t : TokenType) : Text {
    switch (t) {
      case (#ICP) { "ICP" };
      case (#ckBTC) { "ckBTC" };
      case (#ckUSDC) { "ckUSDC" };
    };
  };

  // Return the ICRC-1 ledger actor reference for the given token type.
  // Actor references are created dynamically from the current ledger ID vars
  // so that admin-updated IDs take effect immediately.
  func getLedger(t : TokenType) : ICRC1Ledger {
    switch (t) {
      case (#ICP) { actor (icpLedgerId) : ICRC1Ledger };
      case (#ckBTC) { actor (ckbtcLedgerId) : ICRC1Ledger };
      case (#ckUSDC) { actor (ckusdcLedgerId) : ICRC1Ledger };
    };
  };

  // Return the standard transfer fee for the given token type.
  func getFee(t : TokenType) : Nat {
    switch (t) {
      case (#ICP) { ICP_FEE };
      case (#ckBTC) { CKBTC_FEE };
      case (#ckUSDC) { CKUSDC_FEE };
    };
  };

  /// Derive a deterministic 32-byte ICRC-1 subaccount from a user's principal.
  ///
  /// Layout: [1 byte: principal length] [N bytes: principal] [zero-padded to 32]
  ///
  /// The length prefix ensures that principals of different byte lengths cannot
  /// collide (e.g. a 10-byte principal zero-padded vs an 11-byte principal).
  /// This scheme is compatible with ckBTC minter subaccount derivation.
  func userSubaccount(user : Principal) : Blob {
    let principalBlob = Principal.toBlob(user);
    let bytes = Blob.toArray(principalBlob);
    let buf = Buffer.Buffer<Nat8>(32);
    buf.add(Nat8.fromNat(bytes.size())); // length prefix (1 byte)
    for (b in bytes.vals()) { buf.add(b) }; // principal bytes
    while (buf.size() < 32) { buf.add(0 : Nat8) }; // zero-pad to 32 bytes
    Blob.fromArray(Buffer.toArray(buf));
  };

  // Get the current time as Nat64 nanoseconds (for ICRC-1 created_at_time field).
  // The created_at_time field enables the ledger's built-in deduplication:
  // if the same transfer is submitted twice within the dedup window, the ledger
  // rejects the duplicate.
  func now() : Nat64 {
    Nat64.fromNat(Int.abs(Time.now()));
  };

  // Read the internal balance for a user+token pair. Returns 0 if no entry.
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

  // Write the internal balance for a user+token pair.
  func setBalance(user : Principal, token : Text, amount : Nat) {
    let userBals = switch (principalOps.get(balances, user)) {
      case null { textOps.empty() };
      case (?b) { b };
    };
    let updated = textOps.put(userBals, token, amount);
    balances := principalOps.put(balances, user, updated);
  };

  // Read the last notified on-chain balance for a user+token pair.
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

  // Write the last notified on-chain balance for a user+token pair.
  func setLastNotified(user : Principal, token : Text, amount : Nat) {
    let userLast = switch (principalOps.get(lastNotifiedBalance, user)) {
      case null { textOps.empty() };
      case (?l) { l };
    };
    let updated = textOps.put(userLast, token, amount);
    lastNotifiedBalance := principalOps.put(lastNotifiedBalance, user, updated);
  };

  // Append a transaction record to the user's history. If the history exceeds
  // MAX_TRANSACTIONS_PER_USER, the oldest entry is pruned (FIFO).
  func recordTransaction(user : Principal, record : TransactionRecord) {
    let existing = switch (principalOps.get(transactions, user)) {
      case null { [] };
      case (?txs) { txs };
    };
    // Prune oldest entry if at capacity (keep newest MAX-1, then add new one)
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

  // Generate a monotonically increasing transaction ID.
  func nextTxId() : Nat {
    txCounter += 1;
    txCounter;
  };

  // ── Admin ─────────────────────────────────────────────────────

  /// Register the Gateway canister principal. Only the Gateway is allowed to
  /// call deductForRequest and refundForRequest. Must be called by the admin
  /// (deployer) after deploying both canisters.
  public shared (msg) func setGateway(gateway : Principal) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    gatewayPrincipal := ?gateway;
    #ok(());
  };

  /// Set the ICP ledger canister ID. For local dev, point this to the
  /// locally deployed ICP ledger replica. Defaults to mainnet ID.
  public shared (msg) func setIcpLedger(id : Text) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    icpLedgerId := id;
    #ok(());
  };

  /// Set the ckBTC ledger canister ID. For local dev, point this to the
  /// locally deployed ckBTC ledger replica. Defaults to mainnet ID.
  public shared (msg) func setCkbtcLedger(id : Text) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    ckbtcLedgerId := id;
    #ok(());
  };

  /// Set the ckUSDC ledger canister ID. For local dev, point this to the
  /// locally deployed ckUSDC ledger replica. Defaults to mainnet ID.
  public shared (msg) func setCkusdcLedger(id : Text) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    ckusdcLedgerId := id;
    #ok(());
  };

  /// Query the currently configured ledger canister IDs.
  /// Useful for verifying the configuration after calling the setters.
  public query func getLedgerIds() : async { icp : Text; ckbtc : Text; ckusdc : Text } {
    { icp = icpLedgerId; ckbtc = ckbtcLedgerId; ckusdc = ckusdcLedgerId };
  };

  // ── Deposit Flow (Saga Pattern) ───────────────────────────────

  /// Get the ICRC-1 deposit address for a specific token.
  /// Returns the canister's own principal as the owner and a user-specific
  /// subaccount. Users transfer tokens to this address, then call notifyDeposit
  /// to credit their internal balance.
  public shared query (msg) func getDepositAddress(token : TokenType) : async Result.Result<{ owner : Principal; subaccount : Blob }, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    #ok({
      owner = Principal.fromActor(self);
      subaccount = userSubaccount(msg.caller);
    });
  };

  /// Notify the wallet that a deposit has been made and credit the user.
  ///
  /// Full saga flow:
  ///   1. Query the on-chain balance at the user's subaccount.
  ///   2. Compute delta = on-chain balance - lastNotifiedBalance.
  ///      If delta <= 0, no new deposit to credit.
  ///   3. SAGA: Optimistically credit internal balance and update lastNotifiedBalance
  ///      BEFORE the sweep await. This prevents double-credit if the function is
  ///      called again (the CallerGuard also helps, but the state update is the
  ///      primary protection).
  ///   4. Sweep tokens from the user's subaccount to the canister's default account
  ///      (consolidates funds for easier withdrawal management). If delta <= fee,
  ///      the sweep is skipped (not worth paying the fee) but the credit still stands.
  ///   5. If the sweep fails, COMPENSATE: roll back both the balance credit and
  ///      the lastNotifiedBalance update.
  ///   6. Record the transaction in the user's history.
  ///
  /// Returns the credited delta amount on success.
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

  /// Withdraw tokens from the user's internal balance to an external ICRC-1 account.
  ///
  /// Full saga flow:
  ///   1. Validate: amount must exceed the transfer fee (otherwise the user
  ///      receives nothing) and must not exceed the internal balance.
  ///   2. SAGA: Debit the internal balance BEFORE the ledger transfer await.
  ///      This prevents double-spending: if the user somehow calls withdraw
  ///      concurrently (bypassing the guard), the second call sees the reduced
  ///      balance and fails.
  ///   3. Execute the ICRC-1 transfer from the canister's default account to the
  ///      destination. The user receives (amount - fee).
  ///   4. If the transfer fails, COMPENSATE: re-credit the internal balance.
  ///   5. On success, record the transaction and return the ledger block index.
  ///
  /// The created_at_time field provides ledger-level deduplication (S8).
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
  // These two functions are the wallet-side primitives for the Gateway's saga
  // pattern. The Gateway calls deductForRequest BEFORE the LLM outcall, and
  // refundForRequest if the outcall fails. Both are gateway-only: no other
  // caller can debit or credit a user's balance.

  /// Deduct a fee for an external LLM request (gateway-only).
  /// This is the "forward action" of the saga. If the user's balance is
  /// insufficient, returns an error and the Gateway skips the LLM call.
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

  /// Credit a user's internal balance for persona earnings withdrawal (gateway-only).
  public shared (msg) func creditForEarnings(
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
      txType = #Refund;  // Reuse Refund type for credits
      counterparty = null;
      memo = ?"Persona marketplace earnings";
      timestamp = Time.now();
    });

    #ok(());
  };

  /// Refund a fee after a failed LLM request (gateway-only).
  /// This is the "compensating action" of the saga. Called by the Gateway when
  /// the HTTPS outcall to the LLM provider fails after payment was deducted.
  /// The refund is best-effort — if this call itself fails, the user loses the fee.
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
  // Fast, no-consensus queries for the frontend to display balances and history.

  /// Get the caller's internal balance for a specific token (in smallest units).
  public shared query (msg) func getTokenBalance(token : TokenType) : async Result.Result<Nat, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    #ok(getBalance(msg.caller, tokenToText(token)));
  };

  /// Get the caller's internal balances for all supported tokens.
  /// Returns an array of (token_name, balance) tuples.
  public shared query (msg) func getAllBalances() : async Result.Result<[(Text, Nat)], Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    let tokens = ["ICP", "ckBTC", "ckUSDC"];
    let buf = Buffer.Buffer<(Text, Nat)>(3);
    for (t in tokens.vals()) {
      buf.add((t, getBalance(msg.caller, t)));
    };
    #ok(Buffer.toArray(buf));
  };

  /// Get the caller's transaction history (up to MAX_TRANSACTIONS_PER_USER entries).
  /// Includes deposits, withdrawals, LLM fees, and refunds.
  public shared query (msg) func getTransactions() : async Result.Result<[TransactionRecord], Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    switch (principalOps.get(transactions, msg.caller)) {
      case null { #ok([]) };
      case (?txs) { #ok(txs) };
    };
  };

  // ── Monitoring ────────────────────────────────────────────────
  // Unauthenticated query calls for operational monitoring.

  /// Return the canister's current cycle balance.
  public query func getCycleBalance() : async Nat {
    Cycles.balance();
  };

  /// Structured health/status endpoint with low-cycle warning flag.
  public query func getStatus() : async { health : Text; cycles : Nat; lowCycles : Bool } {
    let bal = Cycles.balance();
    { health = "operational"; cycles = bal; lowCycles = bal < LOW_CYCLES_THRESHOLD };
  };

  /// Simple health-check string for uptime monitors.
  public query func health() : async Text {
    "OpenClaw Wallet v0.3.0 — ICRC-1 enabled";
  };
}
