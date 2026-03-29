/**
 * @file Agent Identity page for viewing and editing the user's on-chain profile.
 *
 * This page implements a full CRUD flow for the agent profile stored in the
 * Identity canister:
 *
 * ## Profile display (read)
 * - Shows the display name, description, capability tags, and usage stats
 *   (total prompts, reputation score).
 * - The principal is shown in truncated form (`abcde...xyz`).
 * - An "Edit" button switches to the form view.
 *
 * ## Profile form (create / update)
 * - **Display Name** (required, max 100 chars) — validated by checking `trim()`.
 * - **Description** (optional, max 500 chars) — free-text textarea.
 * - **Capabilities** (optional) — entered as a comma-separated string, parsed
 *   into an array of trimmed, non-empty strings before submission.
 * - On mount, if no profile exists (`getMyProfile` returns an error), the form
 *   is shown automatically for first-time users.
 * - Calls `upsertProfile(displayName, description, capabilities)` to save.
 *
 * ## Stats
 * - `totalPrompts` and `reputation` are read-only values managed by the
 *   gateway canister. They increment with usage and cannot be edited.
 *
 * @module identity/IdentityPage
 */

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import { createIdentityActor, type AgentProfile } from "../api/identity.did";

/**
 * Agent Identity page component.
 *
 * Renders either the profile view (with stats and an Edit button) or the
 * profile form (for creating/updating), depending on the current state.
 *
 * Requires authentication; shows a "Please log in" message otherwise.
 */
export default function IdentityPage() {
  const { isAuthenticated, authClient, principal } = useAuth();
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Form state
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [capabilities, setCapabilities] = useState("");

  const loadProfile = useCallback(async () => {
    try {
      const agent = await createAgent(authClient ?? undefined);
      const identity = createIdentityActor(agent);
      const result = await identity.getMyProfile();

      if ("ok" in result) {
        const p = result.ok;
        setProfile(p);
        setDisplayName(p.displayName);
        setDescription(p.description);
        setCapabilities(p.capabilities.join(", "));
      } else {
        setProfile(null);
        setEditing(true); // show form for new users
      }
    } catch (e) {
      console.error("Failed to load profile:", e);
    } finally {
      setLoading(false);
    }
  }, [authClient]);

  useEffect(() => {
    if (isAuthenticated) loadProfile();
  }, [isAuthenticated, loadProfile]);

  const handleSave = useCallback(async () => {
    if (!displayName.trim()) return;
    setSaving(true);
    setMessage(null);

    try {
      const agent = await createAgent(authClient ?? undefined);
      const identity = createIdentityActor(agent);

      const caps = capabilities
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);

      const result = await identity.upsertProfile(
        displayName.trim(),
        description.trim(),
        caps,
      );

      if ("ok" in result) {
        setProfile(result.ok);
        setEditing(false);
        setMessage({ text: "Profile saved", type: "success" });
      } else {
        setMessage({ text: `Error: ${(result as { err: string }).err}`, type: "error" });
      }
    } catch (e) {
      setMessage({ text: `Error: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setSaving(false);
    }
  }, [authClient, displayName, description, capabilities]);

  if (!isAuthenticated) {
    return <div style={{ padding: "2rem", color: "var(--text-secondary)" }}>Please log in.</div>;
  }

  const cardStyle = {
    padding: "1.25rem",
    backgroundColor: "var(--bg-secondary)",
    borderRadius: 10,
    border: "1px solid var(--border)",
    marginBottom: "1.5rem",
  };

  const inputStyle = {
    width: "100%",
    padding: "0.5rem 0.75rem",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: "0.85rem",
    outline: "none" as const,
  };

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 640, margin: "0 auto", color: "var(--text-primary)" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>Agent Identity</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: "2rem" }}>
        Your on-chain agent profile. Reputation is built through usage.
      </p>

      {loading ? (
        <p style={{ color: "var(--text-secondary)" }}>Loading profile...</p>
      ) : profile && !editing ? (
        <>
          {/* Profile Card */}
          <div style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: 600 }}>{profile.displayName}</h3>
              <button
                onClick={() => setEditing(true)}
                style={{ padding: "0.3rem 0.75rem", backgroundColor: "transparent", color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 6, fontSize: "0.8rem", cursor: "pointer" }}
              >
                Edit
              </button>
            </div>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: "1rem" }}>
              {profile.description || "No description set."}
            </p>

            {/* Capabilities */}
            {profile.capabilities.length > 0 && (
              <div style={{ marginBottom: "1rem", display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                {profile.capabilities.map((cap, i) => (
                  <span
                    key={i}
                    style={{
                      padding: "2px 10px",
                      backgroundColor: "rgba(99, 102, 241, 0.15)",
                      color: "var(--accent)",
                      borderRadius: 12,
                      fontSize: "0.75rem",
                    }}
                  >
                    {cap}
                  </span>
                ))}
              </div>
            )}

            {/* Reputation & Stats */}
            {(() => {
              const rep = Number(profile.reputation);
              const tier = rep <= 10 ? "Newcomer" : rep <= 30 ? "Active" : rep <= 70 ? "Contributor" : rep <= 120 ? "Expert" : "Legend";
              const tierColor = rep <= 10 ? "#94a3b8" : rep <= 30 ? "#22c55e" : rep <= 70 ? "#3b82f6" : rep <= 120 ? "#a855f7" : "#f59e0b";
              const maxRep = 162;
              const pct = Math.min(100, Math.round((rep / maxRep) * 100));

              return (
                <div style={{ paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }}>
                  {/* Reputation bar */}
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
                    <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)", minWidth: "70px" }}>Reputation</span>
                    <div style={{ flex: 1, height: 8, backgroundColor: "var(--bg-primary)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", backgroundColor: tierColor, borderRadius: 4, transition: "width 0.5s" }} />
                    </div>
                    <span style={{ fontSize: "0.85rem", fontWeight: 600, color: tierColor, minWidth: "80px", textAlign: "right" }}>
                      {tier} ({rep})
                    </span>
                  </div>

                  {/* Reputation breakdown */}
                  <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "1rem", lineHeight: 1.6 }}>
                    {(() => {
                      const prompts = Number(profile.totalPrompts);
                      const promptPts = Math.min(Math.floor(prompts / 10), 100);
                      const descPts = profile.description ? 5 : 0;
                      const capPts = Math.min(profile.capabilities.length * 2, 10);
                      return `${promptPts} from prompts (${prompts} total) · ${descPts + capPts} from profile · rest from account age`;
                    })()}
                  </div>

                  {/* Stats row */}
                  <div style={{ display: "flex", gap: "2rem" }}>
                    <div>
                      <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{profile.totalPrompts.toString()}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>Total Prompts</div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: "0.25rem" }}>
                        {principal ? `${principal.slice(0, 12)}...${principal.slice(-6)}` : "—"}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>Principal</div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </>
      ) : (
        /* Profile Form */
        <div style={cardStyle}>
          <h3 style={{ fontSize: "1rem", fontWeight: 500, marginBottom: "1rem" }}>
            {profile ? "Edit Profile" : "Create Your Agent Profile"}
          </h3>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>
              Display Name *
            </label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your agent name"
              maxLength={100}
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does your agent do?"
              maxLength={500}
              rows={3}
              style={{ ...inputStyle, resize: "vertical" as const }}
            />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>
              Capabilities (comma-separated)
            </label>
            <input
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
              placeholder="coding, research, writing, analysis"
              style={inputStyle}
            />
          </div>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              onClick={handleSave}
              disabled={saving || !displayName.trim()}
              style={{
                padding: "0.5rem 1.5rem",
                backgroundColor: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: "0.85rem",
                cursor: saving || !displayName.trim() ? "not-allowed" : "pointer",
                opacity: saving || !displayName.trim() ? 0.5 : 1,
              }}
            >
              {saving ? "Saving..." : "Save Profile"}
            </button>
            {profile && (
              <button
                onClick={() => setEditing(false)}
                style={{ padding: "0.5rem 1rem", backgroundColor: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", borderRadius: 6, fontSize: "0.85rem", cursor: "pointer" }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {message && (
        <p style={{ fontSize: "0.85rem", color: message.type === "success" ? "#22c55e" : "#ef4444" }}>
          {message.text}
        </p>
      )}
    </div>
  );
}
