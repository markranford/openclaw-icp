/// OpenClaw ICP — Identity Canister
/// On-chain agent identity registry with ICRC-7 NFT credentials
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Text "mo:base/Text";
import Time "mo:base/Time";
import Result "mo:base/Result";
import Buffer "mo:base/Buffer";

import Types "../gateway/Types";

persistent actor class Identity(deployer : Principal) {

  // ── Types ───────────────────────────────────────────────────────
  type AgentProfile = Types.AgentProfile;

  // ── State ───────────────────────────────────────────────────────
  let admin : Principal = deployer;
  var gatewayPrincipal : ?Principal = null;

  transient let principalOps = Map.Make<Principal>(Principal.compare);

  // Agent profiles indexed by owner principal
  var profiles : Map.Map<Principal, AgentProfile> = principalOps.empty();

  // Profile counter
  var profileCount : Nat = 0;

  // ── Public API ──────────────────────────────────────────────────

  /// Create or update agent profile
  public shared (msg) func upsertProfile(
    displayName : Text,
    description : Text,
    capabilities : [Text]
  ) : async Result.Result<AgentProfile, Text> {
    if (Principal.isAnonymous(msg.caller)) {
      return #err("Not authenticated");
    };

    let now = Time.now();

    let profile : AgentProfile = switch (principalOps.get(profiles, msg.caller)) {
      case (?existing) {
        // Update existing
        {
          owner = msg.caller;
          displayName = displayName;
          description = description;
          capabilities = capabilities;
          reputation = existing.reputation;
          totalPrompts = existing.totalPrompts;
          createdAt = existing.createdAt;
          updatedAt = now;
        };
      };
      case null {
        // Create new
        profileCount += 1;
        {
          owner = msg.caller;
          displayName = displayName;
          description = description;
          capabilities = capabilities;
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

  /// Get a profile by principal (public query — any canister can call this)
  public query func getProfile(principal : Principal) : async ?AgentProfile {
    principalOps.get(profiles, principal);
  };

  /// Get caller's own profile
  public shared query (msg) func getMyProfile() : async Result.Result<AgentProfile, Text> {
    if (Principal.isAnonymous(msg.caller)) {
      return #err("Not authenticated");
    };
    switch (principalOps.get(profiles, msg.caller)) {
      case (?profile) { #ok(profile) };
      case null { #err("Profile not found") };
    };
  };

  /// Set the authorized Gateway canister (admin only)
  public shared (msg) func setGateway(gateway : Principal) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    gatewayPrincipal := ?gateway;
    #ok(());
  };

  /// Increment prompt count (called by Gateway after successful prompts)
  public shared (msg) func incrementPromptCount(user : Principal) : async () {
    // Only Gateway canister can call this
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

  /// Get total number of registered profiles
  public query func getProfileCount() : async Nat {
    profileCount;
  };

  // TODO: Phase 4 — ICRC-7 NFT minting for agent identity credentials
  // TODO: Phase 4 — Kinic vector DB integration for agent capabilities search

  /// Health check
  public query func health() : async Text {
    "OpenClaw Identity v0.1.0 — operational";
  };
}
