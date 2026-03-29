/// OpenClaw ICP — Identity Canister
///
/// On-chain agent identity registry. Each user (identified by their ICP
/// principal) can create a profile with a display name, description, and a
/// list of capabilities. The Gateway increments the profile's `totalPrompts`
/// counter after each successful LLM call, providing a basic usage metric.
///
/// ## Agent profile lifecycle:
///   1. User calls upsertProfile(displayName, description, capabilities).
///      - If no profile exists: creates one (reputation=0, totalPrompts=0).
///      - If a profile exists: updates displayName, description, capabilities
///        while preserving reputation, totalPrompts, and createdAt.
///   2. Gateway calls incrementPromptCount(user) after each successful prompt.
///      This is fire-and-forget (Gateway ignores failures).
///   3. Anyone can query getProfile(principal) to view a profile.
///   4. Users can query getMyProfile() for their own profile.
///
/// ## Input validation constraints:
///   - displayName: 1-100 characters (required, non-empty)
///   - description: 0-500 characters
///   - capabilities: max 20 items, each max 50 characters
///
/// ## Reputation system:
///   Auto-calculated from verifiable on-chain activity:
///   - Prompt milestones: 1 point per 10 prompts (max 100)
///   - Profile completeness: +5 for description, +2 per capability (max 10)
///   - Account age: +1 per week since creation (max 52)
///   Tiers: Newcomer (0-10), Active (11-30), Contributor (31-70),
///          Expert (71-120), Legend (121+)
import Principal "mo:base/Principal";
import Map "mo:base/OrderedMap";
import Nat "mo:base/Nat";
import Int "mo:base/Int";
import Text "mo:base/Text";
import Time "mo:base/Time";
import Result "mo:base/Result";
import Cycles "mo:base/ExperimentalCycles";

import Types "../gateway/Types";

/// The Identity actor class. `deployer` becomes the immutable admin.
persistent actor class Identity(deployer : Principal) {

  // ── Types ───────────────────────────────────────────────────────
  type AgentProfile = Types.AgentProfile;

  // ── Constants (storage quotas) ─────────────────────────────────
  // These limits protect the canister from oversized or abusive input,
  // bounding per-profile memory consumption.
  let MAX_CAPABILITIES : Nat = 20;         // Max number of capability tags
  let MAX_DISPLAY_NAME : Nat = 100;        // Max chars for display name
  let LOW_CYCLES_THRESHOLD : Nat = 500_000_000_000; // 0.5T cycles
  let MAX_DESCRIPTION : Nat = 500;         // Max chars for description
  let MAX_CAPABILITY_LENGTH : Nat = 50;    // Max chars per capability string

  // ── State ───────────────────────────────────────────────────────
  let admin : Principal = deployer;
  // The Gateway canister, authorised to call incrementPromptCount.
  var gatewayPrincipal : ?Principal = null;

  // Transient comparator (see Gateway main.mo for explanation).
  transient let principalOps = Map.Make<Principal>(Principal.compare);

  // Primary storage: principal -> AgentProfile.
  var profiles : Map.Map<Principal, AgentProfile> = principalOps.empty();
  // Running count of total profiles ever created (not decremented on delete,
  // if delete were to be added in the future).
  var profileCount : Nat = 0;

  // ── Reputation Calculation ────────────────────────────────────
  //
  // Auto-calculated reputation based on verifiable on-chain activity.
  // Score components:
  //   - Prompt milestones: 1 point per 10 prompts (capped at 100)
  //   - Profile completeness: +5 for description, +2 per capability (capped at 10)
  //   - Account age: +1 per week since profile creation (capped at 52)
  // Total possible: 162 points
  //
  // Reputation tiers for frontend display:
  //   0-10   = Newcomer
  //   11-30  = Active
  //   31-70  = Contributor
  //   71-120 = Expert
  //   121+   = Legend

  func calculateReputation(profile : AgentProfile) : Nat {
    var rep : Nat = 0;

    // Prompt milestones: 1 point per 10 prompts (max 100)
    rep += Nat.min(profile.totalPrompts / 10, 100);

    // Profile completeness: +5 for having a description, +2 per capability (max 10)
    if (Text.size(profile.description) > 0) { rep += 5 };
    rep += Nat.min(profile.capabilities.size() * 2, 10);

    // Account age: +1 per week since creation (max 52 = 1 year)
    let now = Time.now();
    if (now > profile.createdAt) {
      let nanosSinceCreation : Int = now - profile.createdAt;
      let weeksSinceCreation : Int = nanosSinceCreation / 604_800_000_000_000; // 7 days in nanoseconds
      rep += Nat.min(Int.abs(weeksSinceCreation), 52);
    };

    rep;
  };

  // ── Validation ────────────────────────────────────────────────

  // Validate all profile input fields against storage quotas.
  // Returns #err with a descriptive message if any constraint is violated.
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

  /// Create or update the caller's agent profile.
  ///
  /// If a profile already exists for the caller, the displayName, description,
  /// and capabilities are updated while preserving:
  ///   - `reputation` (always 0 for now — future feature)
  ///   - `totalPrompts` (incremented only by the Gateway)
  ///   - `createdAt` (immutable timestamp of first profile creation)
  ///
  /// If no profile exists, a new one is created with reputation=0 and
  /// totalPrompts=0. The profileCount is incremented for analytics.
  ///
  /// All inputs are validated against the storage quota constants.
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

    // Build profile with preserved stats, then recalculate reputation
    let baseProfile : AgentProfile = switch (principalOps.get(profiles, msg.caller)) {
      case (?existing) {
        {
          owner = msg.caller;
          displayName;
          description;
          capabilities;
          reputation = 0; // recalculated below
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
          reputation = 0; // recalculated below
          totalPrompts = 0;
          createdAt = now;
          updatedAt = now;
        };
      };
    };

    // Recalculate reputation based on current state (prompts, completeness, age)
    let profile : AgentProfile = {
      baseProfile with reputation = calculateReputation(baseProfile);
    };

    profiles := principalOps.put(profiles, msg.caller, profile);
    #ok(profile);
  };

  /// Look up any user's profile by their principal. Public and unauthenticated —
  /// profiles are considered public information. Returns null if not found.
  public query func getProfile(principal : Principal) : async ?AgentProfile {
    principalOps.get(profiles, principal);
  };

  /// Get the authenticated caller's own profile. Returns an error if the caller
  /// is anonymous or has no profile. Convenience wrapper over getProfile.
  public shared query (msg) func getMyProfile() : async Result.Result<AgentProfile, Text> {
    if (Principal.isAnonymous(msg.caller)) { return #err("Not authenticated") };
    switch (principalOps.get(profiles, msg.caller)) {
      case (?profile) { #ok(profile) };
      case null { #err("Profile not found") };
    };
  };

  // ── Admin ─────────────────────────────────────────────────────

  /// Register the Gateway canister principal. Only the Gateway is allowed to
  /// call incrementPromptCount. Must be called by the admin (deployer).
  public shared (msg) func setGateway(gateway : Principal) : async Result.Result<(), Text> {
    if (msg.caller != admin) { return #err("Not admin") };
    gatewayPrincipal := ?gateway;
    #ok(());
  };

  /// Increment the prompt count for a user's profile. Gateway-only.
  ///
  /// Called by the Gateway after each successful LLM prompt (step 8 of the
  /// prompt flow). This is fire-and-forget: the Gateway awaits the call for
  /// ordering but catches and ignores any errors.
  ///
  /// If the user has no profile, this is a no-op (the user can use the platform
  /// without creating an identity profile). If the Gateway is not configured,
  /// this is also a no-op — enabling graceful degradation during local dev.
  public shared (msg) func incrementPromptCount(user : Principal) : async () {
    switch (gatewayPrincipal) {
      case null { return };
      case (?gw) { if (msg.caller != gw) { return } };
    };
    switch (principalOps.get(profiles, user)) {
      case (?profile) {
        let withPrompt = {
          profile with
          totalPrompts = profile.totalPrompts + 1;
          updatedAt = Time.now();
        };
        // Recalculate reputation (prompt count changed → may unlock new tier)
        let updated = {
          withPrompt with reputation = calculateReputation(withPrompt);
        };
        profiles := principalOps.put(profiles, user, updated);
      };
      case null {};
    };
  };

  /// Get total number of registered profiles (for analytics dashboards).
  public query func getProfileCount() : async Nat { profileCount };

  // ── Monitoring ─────────────────────────────────────────────────
  // Unauthenticated query calls for operational monitoring.

  /// Return the canister's current cycle balance.
  public query func getCycleBalance() : async Nat { Cycles.balance() };

  /// Structured health/status endpoint with low-cycle warning flag.
  public query func getStatus() : async { health : Text; cycles : Nat; lowCycles : Bool } {
    let bal = Cycles.balance();
    { health = "operational"; cycles = bal; lowCycles = bal < LOW_CYCLES_THRESHOLD };
  };

  /// Simple health-check string for uptime monitors.
  public query func health() : async Text {
    "OpenClaw Identity v0.3.0 — operational";
  };
}
