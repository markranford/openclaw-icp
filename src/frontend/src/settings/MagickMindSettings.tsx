/**
 * @file Settings card for configuring MagickMind deep integration.
 *
 * Allows users to configure:
 * - **Mindspace ID**: Isolated conversation context with its own memory and knowledge.
 *   Different mindspaces keep conversations and memory completely separate.
 * - **Brain Mode**: Fast Brain (instant responses, lower latency) vs Smart Brain
 *   (deeper processing, higher quality).
 * - **Fast Brain Model**: Which LLM model to use for Fast Brain responses.
 * - **Smart Brain Models**: Which LLM models to use for Smart Brain synthesis.
 * - **Compute Power**: Balance between speed and depth (0-100).
 *
 * Configuration is stored on-chain via the Gateway canister's `setMagickMindConfig`
 * and `getMagickMindConfig` methods. The brain mode and mindspace are applied
 * server-side to all MagickMind requests for the authenticated user.
 *
 * @module settings/MagickMindSettings
 */

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import { createGatewayActor } from "../api/gateway.did";
import type { CandidMagickMindBrainMode } from "../api/gateway.did";

/** Suggested Smart Brain models for quick-add. */
const SUGGESTED_MODELS = [
  "gpt-4o",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "openrouter/meta-llama/llama-4-maverick",
];

/**
 * MagickMind configuration card for the settings page.
 *
 * On mount, fetches the current config from the Gateway canister.
 * The user can edit the mindspace ID, toggle brain mode, configure Multi-LLM, then save.
 */
export default function MagickMindSettings() {
  const { isAuthenticated, authClient } = useAuth();

  const [mindspaceId, setMindspaceId] = useState("default");
  const [brainMode, setBrainMode] = useState<"Fast" | "Smart">("Fast");
  const [fastModelId, setFastModelId] = useState("gpt-4o-mini");
  const [smartModelIds, setSmartModelIds] = useState<string[]>([]);
  const [computePower, setComputePower] = useState(50);
  const [smartModelInput, setSmartModelInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [hasConfig, setHasConfig] = useState(false);

  // Fetch existing config on mount
  useEffect(() => {
    if (!isAuthenticated) return;

    (async () => {
      try {
        const agent = await createAgent(authClient ?? undefined);
        const gw = createGatewayActor(agent);
        const result = await gw.getMagickMindConfig();

        if ("ok" in result) {
          setMindspaceId(result.ok.mindspaceId);
          setBrainMode("Fast" in result.ok.brainMode ? "Fast" : "Smart");
          setFastModelId(result.ok.fastModelId || "gpt-4o-mini");
          setSmartModelIds([...(result.ok.smartModelIds || [])]);
          setComputePower(Number(result.ok.computePower ?? 50n));
          setHasConfig(true);
        }
        // If err (e.g. no config yet), keep defaults
      } catch (e) {
        console.warn("Failed to fetch MagickMind config:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [isAuthenticated, authClient]);

  const handleAddSmartModel = useCallback(() => {
    const model = smartModelInput.trim();
    if (!model || smartModelIds.includes(model)) return;
    setSmartModelIds((prev) => [...prev, model]);
    setSmartModelInput("");
  }, [smartModelInput, smartModelIds]);

  const handleRemoveSmartModel = useCallback((model: string) => {
    setSmartModelIds((prev) => prev.filter((m) => m !== model));
  }, []);

  const handleSave = useCallback(async () => {
    const trimmedId = mindspaceId.trim() || "default";
    setSaving(true);
    setMessage(null);

    try {
      const agent = await createAgent(authClient ?? undefined);
      const gw = createGatewayActor(agent);

      const brainModeValue: CandidMagickMindBrainMode =
        brainMode === "Fast" ? { Fast: null } : { Smart: null };

      const result = await gw.setMagickMindConfig(
        trimmedId,
        brainModeValue,
        fastModelId.trim() || "gpt-4o-mini",
        smartModelIds,
        BigInt(computePower),
      );

      if ("ok" in result) {
        setMindspaceId(trimmedId);
        setHasConfig(true);
        setMessage({ text: "MagickMind config saved", type: "success" });
      } else {
        const errKey = Object.keys(result.err)[0];
        const errVal = Object.values(result.err)[0];
        const errMsg = errVal === null ? errKey : `${errKey}: ${errVal}`;
        setMessage({ text: `Error: ${errMsg}`, type: "error" });
      }
    } catch (e) {
      setMessage({
        text: `Error: ${e instanceof Error ? e.message : "Unknown error"}`,
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }, [mindspaceId, brainMode, fastModelId, smartModelIds, computePower, authClient]);

  if (!isAuthenticated) return null;

  return (
    <div
      style={{
        marginBottom: "1.5rem",
        padding: "1.25rem",
        backgroundColor: "var(--bg-secondary)",
        borderRadius: 10,
        border: "1px solid var(--border)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.75rem",
        }}
      >
        <h3 style={{ fontSize: "1rem", fontWeight: 500 }}>MagickMind Configuration</h3>
        <span
          style={{
            fontSize: "0.75rem",
            padding: "2px 8px",
            borderRadius: 12,
            backgroundColor: hasConfig
              ? "rgba(34, 197, 94, 0.15)"
              : "rgba(239, 68, 68, 0.15)",
            color: hasConfig ? "#22c55e" : "#ef4444",
          }}
        >
          {hasConfig ? "Configured" : "Not configured"}
        </span>
      </div>

      <p
        style={{
          fontSize: "0.8rem",
          color: "var(--text-secondary)",
          marginBottom: "1rem",
          lineHeight: 1.5,
        }}
      >
        Configure your MagickMind integration. Mindspaces are isolated conversation contexts
        with their own memory and knowledge — use different IDs to keep topics separate.
        Brain mode controls response quality vs speed.
      </p>

      {loading ? (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          Loading config...
        </p>
      ) : (
        <>
          {/* Mindspace ID */}
          <div style={{ marginBottom: "1rem" }}>
            <label
              style={{
                display: "block",
                fontSize: "0.8rem",
                color: "var(--text-secondary)",
                marginBottom: "0.35rem",
                fontWeight: 500,
              }}
            >
              Mindspace ID
            </label>
            <input
              type="text"
              value={mindspaceId}
              onChange={(e) => setMindspaceId(e.target.value)}
              placeholder="default"
              disabled={saving}
              style={inputStyle}
            />
            <p
              style={{
                fontSize: "0.75rem",
                color: "var(--text-secondary)",
                marginTop: "0.25rem",
                opacity: 0.7,
              }}
            >
              Each mindspace has its own memory and conversation history.
              Use "default" for general use, or create named spaces like "work" or "research".
            </p>
          </div>

          {/* Brain Mode */}
          <div style={{ marginBottom: "1rem" }}>
            <label
              style={{
                display: "block",
                fontSize: "0.8rem",
                color: "var(--text-secondary)",
                marginBottom: "0.35rem",
                fontWeight: 500,
              }}
            >
              Brain Mode
            </label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                onClick={() => setBrainMode("Fast")}
                disabled={saving}
                style={{
                  flex: 1,
                  padding: "0.6rem 1rem",
                  backgroundColor:
                    brainMode === "Fast" ? "var(--accent)" : "var(--bg-primary)",
                  color:
                    brainMode === "Fast" ? "#fff" : "var(--text-secondary)",
                  border: `1px solid ${brainMode === "Fast" ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 6,
                  fontSize: "0.85rem",
                  cursor: saving ? "not-allowed" : "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                Fast Brain
                <span
                  style={{
                    display: "block",
                    fontSize: "0.7rem",
                    opacity: 0.7,
                    marginTop: "0.15rem",
                  }}
                >
                  Instant responses, lower latency
                </span>
              </button>
              <button
                onClick={() => setBrainMode("Smart")}
                disabled={saving}
                style={{
                  flex: 1,
                  padding: "0.6rem 1rem",
                  backgroundColor:
                    brainMode === "Smart" ? "var(--accent)" : "var(--bg-primary)",
                  color:
                    brainMode === "Smart" ? "#fff" : "var(--text-secondary)",
                  border: `1px solid ${brainMode === "Smart" ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 6,
                  fontSize: "0.85rem",
                  cursor: saving ? "not-allowed" : "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                Smart Brain
                <span
                  style={{
                    display: "block",
                    fontSize: "0.7rem",
                    opacity: 0.7,
                    marginTop: "0.15rem",
                  }}
                >
                  Deeper processing, higher quality
                </span>
              </button>
            </div>
          </div>

          {/* Multi-LLM Section */}
          <div
            style={{
              backgroundColor: "var(--bg-primary)",
              borderRadius: 8,
              border: "1px solid var(--border)",
              padding: "1rem",
              marginBottom: "1rem",
            }}
          >
            <h4 style={{ margin: "0 0 0.75rem 0", fontSize: "0.88rem", fontWeight: 600, color: "var(--text-primary)" }}>
              Multi-LLM Settings
            </h4>

            {/* Fast Brain Model */}
            <div style={{ marginBottom: "1rem" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.8rem",
                  color: "var(--text-secondary)",
                  marginBottom: "0.35rem",
                  fontWeight: 500,
                }}
              >
                Fast Brain Model
              </label>
              <input
                type="text"
                value={fastModelId}
                onChange={(e) => setFastModelId(e.target.value)}
                placeholder="gpt-4o-mini"
                disabled={saving}
                style={inputStyle}
              />
              <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.2rem" }}>
                The model used for Fast Brain responses (quick, low-latency).
              </p>
            </div>

            {/* Smart Brain Models */}
            <div style={{ marginBottom: "1rem" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.8rem",
                  color: "var(--text-secondary)",
                  marginBottom: "0.35rem",
                  fontWeight: 500,
                }}
              >
                Smart Brain Models
              </label>

              {/* Current model chips */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.5rem" }}>
                {smartModelIds.map((model) => (
                  <span
                    key={model}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.3rem",
                      backgroundColor: "var(--accent)",
                      color: "white",
                      padding: "0.2rem 0.6rem",
                      borderRadius: "999px",
                      fontSize: "0.78rem",
                      fontWeight: 500,
                    }}
                  >
                    {model}
                    <button
                      onClick={() => handleRemoveSmartModel(model)}
                      disabled={saving}
                      style={{
                        background: "none",
                        border: "none",
                        color: "rgba(255,255,255,0.8)",
                        cursor: saving ? "not-allowed" : "pointer",
                        padding: "0 2px",
                        fontSize: "0.85rem",
                        lineHeight: 1,
                      }}
                    >
                      x
                    </button>
                  </span>
                ))}
                {smartModelIds.length === 0 && (
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                    No models added yet
                  </span>
                )}
              </div>

              {/* Add model input */}
              <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
                <input
                  type="text"
                  value={smartModelInput}
                  onChange={(e) => setSmartModelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddSmartModel();
                    }
                  }}
                  placeholder="Add model ID..."
                  disabled={saving}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  onClick={handleAddSmartModel}
                  disabled={!smartModelInput.trim() || saving}
                  style={{
                    backgroundColor: smartModelInput.trim() && !saving ? "var(--accent)" : "var(--bg-secondary)",
                    color: smartModelInput.trim() && !saving ? "white" : "var(--text-muted)",
                    border: "none",
                    borderRadius: 6,
                    padding: "0.4rem 0.75rem",
                    fontSize: "0.8rem",
                    cursor: smartModelInput.trim() && !saving ? "pointer" : "default",
                    transition: "background-color 0.15s ease",
                  }}
                >
                  Add
                </button>
              </div>

              {/* Suggested models */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                {SUGGESTED_MODELS.map((model) => {
                  if (smartModelIds.includes(model)) return null;
                  return (
                    <button
                      key={model}
                      onClick={() => setSmartModelIds((prev) => [...prev, model])}
                      disabled={saving}
                      style={{
                        fontSize: "0.7rem",
                        padding: "2px 8px",
                        borderRadius: "999px",
                        border: "1px dashed var(--border)",
                        backgroundColor: "transparent",
                        color: "var(--text-muted)",
                        cursor: saving ? "not-allowed" : "pointer",
                        transition: "all 0.15s",
                      }}
                    >
                      + {model}
                    </button>
                  );
                })}
              </div>

              <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.3rem" }}>
                Models used for Smart Brain synthesis. Multiple models are queried and synthesized for deeper responses.
              </p>
            </div>

            {/* Compute Power */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                <label
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--text-secondary)",
                    fontWeight: 500,
                  }}
                >
                  Compute Power
                </label>
                <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-primary)" }}>
                  {computePower}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={computePower}
                onChange={(e) => setComputePower(parseInt(e.target.value, 10))}
                disabled={saving}
                style={{
                  width: "100%",
                  height: "6px",
                  accentColor: "var(--accent)",
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.2rem" }}>
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Speed</span>
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Depth</span>
              </div>
              <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                Balance between response speed (0) and processing depth (100).
              </p>
            </div>
          </div>

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "0.5rem 1.5rem",
              backgroundColor: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: "0.85rem",
              cursor: saving ? "not-allowed" : "pointer",
              opacity: saving ? 0.5 : 1,
            }}
          >
            {saving ? "Saving..." : "Save Configuration"}
          </button>

          {/* Status message */}
          {message && (
            <p
              style={{
                marginTop: "0.5rem",
                fontSize: "0.8rem",
                color: message.type === "success" ? "#22c55e" : "#ef4444",
              }}
            >
              {message.text}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── Shared styles ───────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  backgroundColor: "var(--bg-primary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.85rem",
  outline: "none",
  boxSizing: "border-box",
};
