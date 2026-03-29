/**
 * @file Settings page for managing external LLM provider API keys.
 *
 * This page allows authenticated users to securely store, replace, and delete
 * API keys for external LLM providers (Anthropic, OpenAI, MagickMind). Keys
 * are stored on-chain in the KeyVault canister.
 *
 * ## Security: vetKD encryption vs plaintext fallback
 *
 * - **Mainnet:** On page load, the component attempts to derive a per-user
 *   AES-256-GCM key via vetKD ({@link deriveAesKey}). If successful, all keys
 *   are encrypted client-side before being sent to the canister. Node operators
 *   cannot read the plaintext.
 * - **Local dev:** vetKD is typically not available on local replicas. The
 *   component falls back to plaintext storage (safe for testing, flagged in
 *   the UI with a security note).
 *
 * ## Key lifecycle
 *
 * 1. **Check existence:** On mount, calls `hasKey(keyId)` for each provider
 *    to display "Configured" / "Not set" badges.
 * 2. **Save:** Encrypts the key with vetKD (if available) or encodes as UTF-8,
 *    then calls `storeEncryptedKey(keyId, blob)`.
 * 3. **Delete:** Calls `deleteKey(keyId)` and updates the badge.
 *
 * ## Adding a new provider
 *
 * Add an entry to the {@link PROVIDERS} array with a unique `id`, `keyId`
 * (used as the on-chain storage key), and display metadata. The rest of the
 * UI is generated automatically.
 *
 * @module settings/SettingsPage
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent, isLocal } from "../api/agent";
import { createKeyVaultActor } from "../api/keyvault.did";
import { deriveAesKey, encryptWithVetKey } from "../api/vetkeys";
import MagickMindSettings from "./MagickMindSettings";

/**
 * Configuration for a single LLM provider displayed in the settings UI.
 *
 * @property id - Unique identifier used as the React key and state map key.
 * @property label - Human-readable provider name shown in the card header.
 * @property keyId - The logical key name stored on-chain (e.g. `"anthropic_api_key"`).
 * @property placeholder - Input placeholder showing expected key format.
 * @property helpText - Brief instruction on where to obtain the key.
 */
interface ProviderConfig {
  id: string;
  label: string;
  keyId: string;
  placeholder: string;
  helpText: string;
}

/**
 * Registry of supported LLM providers. Each entry generates a settings card
 * with save/delete controls. To add a new provider, append to this array.
 */
const PROVIDERS: ProviderConfig[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    keyId: "anthropic_api_key",
    placeholder: "sk-ant-...",
    helpText: "Get your key at console.anthropic.com",
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    keyId: "openai_api_key",
    placeholder: "sk-...",
    helpText: "Get your key at platform.openai.com",
  },
  {
    id: "magickmind",
    label: "MagickMind",
    keyId: "magickmind_api_key",
    placeholder: "your MagickMind API key",
    helpText: "Free during beta at magickmind.ai",
  },
  {
    id: "resend",
    label: "Resend (Email)",
    keyId: "resend_api_key",
    placeholder: "re_...",
    helpText: "Send email from your agent. Get key at resend.com",
  },
  {
    id: "twilio_sid",
    label: "Twilio Account SID",
    keyId: "twilio_account_sid",
    placeholder: "AC...",
    helpText: "For SMS. Get from twilio.com/console",
  },
  {
    id: "twilio_token",
    label: "Twilio Auth Token",
    keyId: "twilio_auth_token",
    placeholder: "your auth token",
    helpText: "Found in Twilio console dashboard",
  },
  {
    id: "twilio_phone",
    label: "Twilio Phone Number",
    keyId: "twilio_phone_number",
    placeholder: "+1234567890",
    helpText: "Your Twilio number in E.164 format",
  },
];

/**
 * Settings page component for API key management.
 *
 * Displays a card for each provider in {@link PROVIDERS} with:
 * - A status badge (Configured / Not set).
 * - A password input for entering or replacing a key.
 * - Save and Delete buttons with per-provider loading states.
 * - Success/error messages.
 *
 * A footer banner indicates whether vetKD encryption is active.
 */
export default function SettingsPage() {
  const { isAuthenticated, authClient } = useAuth();
  const [keyStates, setKeyStates] = useState<Record<string, boolean>>({});
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, { text: string; type: "success" | "error" }>>({});
  const [loading, setLoading] = useState(true);
  const [vetKeyEnabled, setVetKeyEnabled] = useState(false);
  const aesKeyRef = useRef<CryptoKey | null>(null);

  // Check which keys exist on mount + derive vetKD AES key
  useEffect(() => {
    if (!isAuthenticated) return;

    (async () => {
      try {
        const agent = await createAgent(authClient ?? undefined);
        const kv = createKeyVaultActor(agent);

        const states: Record<string, boolean> = {};
        for (const p of PROVIDERS) {
          states[p.keyId] = await kv.hasKey(p.keyId);
        }
        setKeyStates(states);

        // Try to derive vetKD AES key (only works on mainnet or with vetKD enabled)
        if (!isLocal()) {
          try {
            aesKeyRef.current = await deriveAesKey(agent);
            setVetKeyEnabled(true);
          } catch (e) {
            console.warn("vetKD not available, using plaintext storage:", e);
          }
        }
      } catch (e) {
        console.error("Failed to check keys:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [isAuthenticated, authClient]);

  const handleSave = useCallback(
    async (provider: ProviderConfig) => {
      const value = inputs[provider.id]?.trim();
      if (!value) return;

      setSaving((prev) => ({ ...prev, [provider.id]: true }));
      setMessages((prev) => { const next = { ...prev }; delete next[provider.id]; return next; });

      try {
        const agent = await createAgent(authClient ?? undefined);
        const kv = createKeyVaultActor(agent);

        // Encrypt with vetKD if available, otherwise store as plaintext
        let blob: number[];
        if (aesKeyRef.current) {
          const encrypted = await encryptWithVetKey(value, aesKeyRef.current);
          blob = Array.from(encrypted);
        } else {
          // Fallback: plaintext (local dev or vetKD unavailable)
          const encoder = new TextEncoder();
          blob = Array.from(encoder.encode(value));
        }

        const result = await kv.storeEncryptedKey(provider.keyId, blob);
        if ("ok" in result) {
          setKeyStates((prev) => ({ ...prev, [provider.keyId]: true }));
          setInputs((prev) => ({ ...prev, [provider.id]: "" }));
          setMessages((prev) => ({
            ...prev,
            [provider.id]: { text: "Key saved successfully", type: "success" },
          }));
        } else {
          setMessages((prev) => ({
            ...prev,
            [provider.id]: { text: `Error: ${result.err}`, type: "error" },
          }));
        }
      } catch (e) {
        setMessages((prev) => ({
          ...prev,
          [provider.id]: {
            text: `Error: ${e instanceof Error ? e.message : "Unknown error"}`,
            type: "error",
          },
        }));
      } finally {
        setSaving((prev) => ({ ...prev, [provider.id]: false }));
      }
    },
    [inputs, authClient],
  );

  const handleDelete = useCallback(
    async (provider: ProviderConfig) => {
      setSaving((prev) => ({ ...prev, [provider.id]: true }));

      try {
        const agent = await createAgent(authClient ?? undefined);
        const kv = createKeyVaultActor(agent);

        const result = await kv.deleteKey(provider.keyId);
        if ("ok" in result) {
          setKeyStates((prev) => ({ ...prev, [provider.keyId]: false }));
          setMessages((prev) => ({
            ...prev,
            [provider.id]: { text: "Key deleted", type: "success" },
          }));
        } else {
          setMessages((prev) => ({
            ...prev,
            [provider.id]: { text: `Error: ${result.err}`, type: "error" },
          }));
        }
      } catch (e) {
        setMessages((prev) => ({
          ...prev,
          [provider.id]: {
            text: `Error: ${e instanceof Error ? e.message : "Unknown error"}`,
            type: "error",
          },
        }));
      } finally {
        setSaving((prev) => ({ ...prev, [provider.id]: false }));
      }
    },
    [authClient],
  );

  if (!isAuthenticated) {
    return (
      <div style={{ padding: "2rem", color: "var(--text-secondary)" }}>
        Please log in to manage settings.
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "1.5rem 2rem",
        maxWidth: 640,
        margin: "0 auto",
        color: "var(--text-primary)",
      }}
    >
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>
        Settings
      </h2>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: "2rem" }}>
        Store API keys for external LLM providers. Keys are saved to the on-chain KeyVault canister.
      </p>

      {loading ? (
        <p style={{ color: "var(--text-secondary)" }}>Loading key status...</p>
      ) : (
        PROVIDERS.map((provider) => {
          const hasKey = keyStates[provider.keyId] ?? false;
          const isSaving = saving[provider.id] ?? false;
          const msg = messages[provider.id];

          return (
            <div
              key={provider.id}
              style={{
                marginBottom: "1.5rem",
                padding: "1.25rem",
                backgroundColor: "var(--bg-secondary)",
                borderRadius: 10,
                border: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "0.75rem",
                }}
              >
                <h3 style={{ fontSize: "1rem", fontWeight: 500 }}>{provider.label}</h3>
                <span
                  style={{
                    fontSize: "0.75rem",
                    padding: "2px 8px",
                    borderRadius: 12,
                    backgroundColor: hasKey
                      ? "rgba(34, 197, 94, 0.15)"
                      : "rgba(239, 68, 68, 0.15)",
                    color: hasKey ? "#22c55e" : "#ef4444",
                  }}
                >
                  {hasKey ? "Configured" : "Not set"}
                </span>
              </div>

              <p
                style={{
                  fontSize: "0.8rem",
                  color: "var(--text-secondary)",
                  marginBottom: "0.75rem",
                }}
              >
                {provider.helpText}
              </p>

              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  type="password"
                  value={inputs[provider.id] ?? ""}
                  onChange={(e) =>
                    setInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))
                  }
                  placeholder={hasKey ? "Enter new key to replace..." : provider.placeholder}
                  disabled={isSaving}
                  style={{
                    flex: 1,
                    padding: "0.5rem 0.75rem",
                    backgroundColor: "var(--bg-primary)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    fontSize: "0.85rem",
                    outline: "none",
                  }}
                />
                <button
                  onClick={() => handleSave(provider)}
                  disabled={isSaving || !inputs[provider.id]?.trim()}
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "var(--accent)",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    fontSize: "0.85rem",
                    cursor: isSaving || !inputs[provider.id]?.trim() ? "not-allowed" : "pointer",
                    opacity: isSaving || !inputs[provider.id]?.trim() ? 0.5 : 1,
                  }}
                >
                  {isSaving ? "..." : "Save"}
                </button>
                {hasKey && (
                  <button
                    onClick={() => handleDelete(provider)}
                    disabled={isSaving}
                    style={{
                      padding: "0.5rem 0.75rem",
                      backgroundColor: "transparent",
                      color: "#ef4444",
                      border: "1px solid #ef4444",
                      borderRadius: 6,
                      fontSize: "0.85rem",
                      cursor: isSaving ? "not-allowed" : "pointer",
                      opacity: isSaving ? 0.5 : 1,
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>

              {msg && (
                <p
                  style={{
                    marginTop: "0.5rem",
                    fontSize: "0.8rem",
                    color: msg.type === "success" ? "#22c55e" : "#ef4444",
                  }}
                >
                  {msg.text}
                </p>
              )}
            </div>
          );
        })
      )}

      {/* MagickMind deep integration settings */}
      {!loading && (
        <>
          <h2
            style={{
              fontSize: "1.1rem",
              fontWeight: 600,
              marginTop: "2rem",
              marginBottom: "0.75rem",
            }}
          >
            MagickMind Integration
          </h2>
          <MagickMindSettings />
        </>
      )}

      <div
        style={{
          marginTop: "2rem",
          padding: "1rem",
          backgroundColor: "rgba(99, 102, 241, 0.1)",
          borderRadius: 8,
          border: "1px solid rgba(99, 102, 241, 0.2)",
        }}
      >
        <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          <strong style={{ color: vetKeyEnabled ? "#22c55e" : "var(--accent)" }}>
            {vetKeyEnabled ? "vetKD encryption active" : "Security note"}:
          </strong>{" "}
          {vetKeyEnabled
            ? "Keys are encrypted client-side with AES-256-GCM using vetKD-derived keys before on-chain storage. Node operators cannot read your API keys."
            : "Local dev mode: keys are stored as plaintext for testing. On mainnet, keys are automatically encrypted with vetKD before storage."}
        </p>
      </div>
    </div>
  );
}
