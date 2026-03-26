/// OpenClaw ICP — Authentication & reentrancy guards
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
