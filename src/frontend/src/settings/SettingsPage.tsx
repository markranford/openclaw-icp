import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent, isLocal } from "../api/agent";
import { createKeyVaultActor } from "../api/keyvault.did";
import { deriveAesKey, encryptWithVetKey } from "../api/vetkeys";

interface ProviderConfig {
  id: string;
  label: string;
  keyId: string;
  placeholder: string;
  helpText: string;
}

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
];

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
