/// OpenClaw ICP — Identity Canister
/// On-chain agent identity registry with reputation tracking
/// Security: input validation, anonymous rejection, storage quotas
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Text "mo:base/Text";
import Time "mo:base/Time";
import Result "mo:base/Result";
import Cycles "mo:base/ExperimentalCycles";

import Types "../gateway/Types";

persistent actor class Identity(deployer : Principal) {

  // ── Types ───────────────────────────────────────────────────────
  type AgentProfile = Types.AgentProfile;

  // ── Constants (S5: storage quotas) ────────────────────────────
  let MAX_CAPABILITIES : Nat = 20;
  let MAX_DISPLAY_NAME : Nat = 100;
  let MAX_DESCRIPTION : Nat = 500;
  let MAX_CAPABILITY_LENGTH : Nat = 50;

  // ── State ───────────────────────────────────────────────────────
  let admin : Principal = deployer;
  var gatewayPrincipal : ?Principal = null;

  transient let principalOps = Map.Make<Principal>(Principal.compare);

  var profiles : Map.Map<Principal, AgentProfile> = principalOps.empty();
  var profileCount : Nat = 0;

  // ── Validation ────────────────────────────────────────────────

  func validateProfileInput(
    displayName : Text,
    description : Text,
    capabilities : [Text],
  ) : Result.Result<(), Text> {
    if (Text.size(displayName) == 0) { return #err("Display name cannot be empty") };
    if (Text.size(displayName) > MAX_DISPLAY_NAME) {
      return #err("Display name too long: max " # debug_show(MAX_DISPLAY_NAME) # " characters");
    };
    if (Text.size(description) > MAX_DESCRIPTION) {
      return #err("Description too long: max " # debug_show(MAX_DESCRIPTION) # " characters");
    };
    if (capabilities.size() > MAX_CAPABILITIES) {
      return #err("Too many capabilities: max " # debug_show(MAX_CAPABILITIES));
    };
    for (cap in capabilities.vals()) {
      if (Text.size(cap) > MAX_CAPABILITY_LENGTH) {
        return #err("Capability too long: max " # debug_show(MAX_CAPABILITY_LENGTH) # " characters");
      };
    };
    #ok(());
  };

  // ── Public API ────────────────────────────────────────────────

  /// Create or update agent profile (S5: validated inputs)
  public shared (msg) func upsertProfile(
    displayName : Text,
    description : Text,
    capabilities : [Text],
  ) : async Result.Result<AgentProfile, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };

    switch (validateProfileInput(displayName, description, capabilities)) {
      case (#err(e)) { return #err(e) };
      case (#ok(())) {};
    };

    let now = Time.now();

    let profile : AgentProfile = switch (principalOps.get(profiles, msg.caller)) {
      case (?existing) {
        {
          owner = msg.caller;
          displayName;
          description;
          capabilities;
          reputation = existing.reputation;
          totalPrompts = existing.totalPrompts;
          createdAt = existing.createdAt;
          updatedAt = now;
        };
      };
      case null {
        profileCount += 1;
        {
          owner = msg.caller;
          displayName;
          description;
          capabilities;
          reputation = 0;
          totalPrompts = 0;
          createdAt = now;
          updatedAt = now;
        };
      };
    };

    profiles := principalOps.put(profiles, msg.caller, profile);
    #ok(profile);
  };

  /// Get a profile by principal (public query)
  public query func getProfile(principal : Principal) : async ?AgentProfile {
    principalOps.get(profiles, principal);
  };

  /// Get caller's own profile
  public shared query (msg) func getMyProfile() : async Result.Result<AgentProfile, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    switch (principalOps.get(profiles, msg.caller)) {
      case (?profile) { #ok(profile) };
      case null { #err("Profile not found") };
    };
  };

  // ── Admin ─────────────────────────────────────────────────────

  public shared (msg) func setGateway(gateway : Principal) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    gatewayPrincipal := ?gateway;
    #ok(());
  };

  /// Increment prompt count (gateway-only, S4: auth gated)
  public shared (msg) func incrementPromptCount(user : Principal) : async () {
    switch (gatewayPrincipal) {
      case null { return };
      case (?gw) { if (msg.caller != gw) { return } };
    };
    switch (principalOps.get(profiles, user)) {
      case (?profile) {
        let updated = {
          profile with
          totalPrompts = profile.totalPrompts + 1;
          updatedAt = Time.now();
        };
        profiles := principalOps.put(profiles, user, updated);
      };
      case null {};
    };
  };

  /// Get total registered profiles
  public query func getProfileCount() : async Nat { profileCount };

  // ── Monitoring (S6) ───────────────────────────────────────────

  public query func getCycleBalance() : async Nat { Cycles.balance() };

  public query func health() : async Text {
    "OpenClaw Identity v0.3.0 — operational";
  };
}
