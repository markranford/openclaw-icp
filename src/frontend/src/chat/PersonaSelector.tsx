/**
 * @file Compact dropdown selector for choosing an AI persona in the chat header.
 *
 * Displays the currently selected persona (avatar + name) or "No Persona".
 * Dropdown lists all personas grouped by "Built-in" and "My Personas".
 * When a persona is selected, calls `compilePersona` to get the system prompt
 * and passes it up to ChatPage.
 *
 * @module chat/PersonaSelector
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import { createGatewayActor, type CandidPersona } from "../api/gateway.did";

interface PersonaSelectorProps {
  selectedPersonaId: string | null;
  onSelect: (personaId: string | null, compiledPrompt: string) => void;
}

export default function PersonaSelector({
  selectedPersonaId,
  onSelect,
}: PersonaSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [personas, setPersonas] = useState<CandidPersona[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { authClient } = useAuth();

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  // Load personas when dropdown opens
  const loadPersonas = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.listPersonas();
      if ("ok" in result) {
        setPersonas(result.ok as CandidPersona[]);
      }
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [authClient, isLoading]);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    loadPersonas();
  }, [loadPersonas]);

  // Select a persona: compile its prompt
  const handleSelectPersona = useCallback(
    async (persona: CandidPersona) => {
      setIsOpen(false);
      setIsCompiling(true);
      try {
        const agent = await createAgent(authClient ?? undefined);
        const gateway = createGatewayActor(agent);
        const result = await gateway.compilePersona(persona.id);
        if ("ok" in result) {
          onSelect(persona.id, result.ok as string);
        }
      } catch {
        // Silently fail
      } finally {
        setIsCompiling(false);
      }
    },
    [authClient, onSelect]
  );

  const handleClear = useCallback(() => {
    setIsOpen(false);
    onSelect(null, "");
  }, [onSelect]);

  // Find current persona for display
  const currentPersona = personas.find((p) => p.id === selectedPersonaId);
  const builtIn = personas.filter((p) => p.isBuiltIn);
  const userPersonas = personas.filter((p) => !p.isBuiltIn);

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      {/* Trigger button */}
      <button
        onClick={() => (isOpen ? setIsOpen(false) : handleOpen())}
        disabled={isCompiling}
        style={{
          backgroundColor: selectedPersonaId ? "var(--accent)" : "var(--bg-tertiary)",
          color: selectedPersonaId ? "white" : "var(--text-primary)",
          border: "1px solid var(--border)",
          borderRadius: "8px",
          padding: "0.35rem 0.7rem",
          fontSize: "0.82rem",
          cursor: isCompiling ? "wait" : "pointer",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "center",
          gap: "0.35rem",
          transition: "all 0.15s ease",
        }}
      >
        {isCompiling ? (
          <span>Loading...</span>
        ) : currentPersona ? (
          <>
            <span>{currentPersona.avatar || "🎭"}</span>
            <span>{currentPersona.name}</span>
          </>
        ) : (
          <span>🎭 Persona</span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            width: "280px",
            maxHeight: "380px",
            overflowY: "auto",
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
            zIndex: 100,
          }}
        >
          {/* None option */}
          <button
            onClick={handleClear}
            style={{
              ...itemStyle,
              color: "var(--text-muted)",
              fontStyle: "italic",
              borderBottom: "1px solid var(--border)",
            }}
          >
            None (no persona)
          </button>

          {isLoading && (
            <div
              style={{
                padding: "0.75rem",
                fontSize: "0.8rem",
                color: "var(--text-muted)",
                textAlign: "center",
              }}
            >
              Loading...
            </div>
          )}

          {!isLoading && builtIn.length > 0 && (
            <div>
              <div style={sectionLabelStyle}>Built-in</div>
              {builtIn.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleSelectPersona(p)}
                  style={{
                    ...itemStyle,
                    fontWeight: selectedPersonaId === p.id ? 600 : 400,
                    backgroundColor:
                      selectedPersonaId === p.id
                        ? "var(--bg-tertiary)"
                        : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontSize: "1.1rem" }}>{p.avatar || "🎭"}</span>
                    <div>
                      <div style={{ fontWeight: 500, fontSize: "0.85rem" }}>{p.name}</div>
                      {p.description && (
                        <div
                          style={{
                            fontSize: "0.72rem",
                            color: "var(--text-muted)",
                            lineHeight: 1.3,
                            marginTop: "1px",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            maxWidth: "200px",
                          }}
                        >
                          {p.description}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {!isLoading && userPersonas.length > 0 && (
            <div>
              <div style={sectionLabelStyle}>My Personas</div>
              {userPersonas.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleSelectPersona(p)}
                  style={{
                    ...itemStyle,
                    fontWeight: selectedPersonaId === p.id ? 600 : 400,
                    backgroundColor:
                      selectedPersonaId === p.id
                        ? "var(--bg-tertiary)"
                        : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontSize: "1.1rem" }}>{p.avatar || "🎭"}</span>
                    <div>
                      <div style={{ fontWeight: 500, fontSize: "0.85rem" }}>{p.name}</div>
                      {p.description && (
                        <div
                          style={{
                            fontSize: "0.72rem",
                            color: "var(--text-muted)",
                            lineHeight: 1.3,
                            marginTop: "1px",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            maxWidth: "200px",
                          }}
                        >
                          {p.description}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {!isLoading && personas.length === 0 && (
            <div
              style={{
                padding: "0.75rem",
                fontSize: "0.8rem",
                color: "var(--text-muted)",
                textAlign: "center",
              }}
            >
              No personas available
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Shared styles
const itemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  backgroundColor: "transparent",
  border: "none",
  color: "var(--text-primary)",
  padding: "0.55rem 0.75rem",
  cursor: "pointer",
  fontSize: "0.85rem",
  lineHeight: 1.4,
  transition: "background-color 0.15s ease",
};

const sectionLabelStyle: React.CSSProperties = {
  padding: "0.4rem 0.75rem 0.2rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
