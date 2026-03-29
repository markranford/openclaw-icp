/// OpenClaw ICP — Authentication & Reentrancy Guards
///
/// This module provides two critical security primitives used by the Gateway
/// (and potentially other canisters):
///
///   1. **requireAuth** — a simple check that rejects the anonymous principal.
///      On ICP, any caller that has not authenticated with an identity provider
///      (Internet Identity, NFID, etc.) arrives as the anonymous principal
///      (2vxsx-fae). This function should be called at the top of every
///      public shared function that requires a real user.
///
///   2. **CallerGuard** — a reentrancy guard that prevents a single principal
///      from having two concurrent in-flight operations. This is essential on
///      ICP because `await` yields control back to the scheduler, allowing the
///      same caller to invoke the function again before the first call
///      completes. Without the guard, a user could exploit the race window to
///      double-spend or corrupt conversation state. The guard is implemented as
///      a mutable OrderedMap of currently-in-flight principals and must always
///      be released in a `finally` block.
///
/// Both types are designed to be stateless at the module level; the CallerGuard
/// is instantiated as a `transient` field in the actor so its state resets on
/// upgrade (safe, since no calls are in flight after an upgrade).
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Result "mo:base/Result";

module {

  public type AuthError = {
    #NotAuthenticated;
    #AlreadyProcessing;
  };

  /// Reject anonymous principal — call at top of every shared function
  public func requireAuth(caller : Principal) : Result.Result<(), AuthError> {
    if (Principal.isAnonymous(caller)) {
      #err(#NotAuthenticated);
    } else {
      #ok(());
    };
  };

  /// CallerGuard — prevents reentrancy across await points.
  /// Uses a mutable map of principals currently being processed.
  public class CallerGuard() {
    let ops = Map.Make<Principal>(Principal.compare);
    var pending : Map.Map<Principal, Bool> = ops.empty();

    /// Attempt to acquire the guard for a principal.
    /// Returns #err if the principal already has an in-flight operation.
    public func acquire(principal : Principal) : Result.Result<(), AuthError> {
      switch (ops.get(pending, principal)) {
        case (?_) { #err(#AlreadyProcessing) };
        case null {
          pending := ops.put(pending, principal, true);
          #ok(());
        };
      };
    };

    /// Release the guard for a principal. Call in finally block.
    public func release(principal : Principal) {
      pending := ops.delete(pending, principal);
    };
  };
}
