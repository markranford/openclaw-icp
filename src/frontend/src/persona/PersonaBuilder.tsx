/**
 * @file Full-page persona management interface for creating and editing AI personality profiles.
 *
 * Two-column layout: left panel shows a grid of persona cards, right panel shows
 * the editor/preview form for the selected persona.
 *
 * @module persona/PersonaBuilder
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import { createGatewayActor, type CandidPersona } from "../api/gateway.did";
import PersonaTraitsPanel from "./PersonaTraitsPanel";

/** Empty persona template for "Create New". */
function emptyPersona(): Omit<CandidPersona, "createdAt" | "updatedAt"> {
  return {
    id: "",
    name: "",
    avatar: "",
    description: "",
    personality: "",
    tone: "",
    expertise: [],
    instructions: "",
    isBuiltIn: false,
  };
}

export default function PersonaBuilder() {
  const { authClient } = useAuth();
  const [personas, setPersonas] = useState<CandidPersona[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selected, setSelected] = useState<CandidPersona | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [previewPrompt, setPreviewPrompt] = useState<string | null>(null);
  const [expertiseInput, setExpertiseInput] = useState("");
  const [activeTab, setActiveTab] = useState<"basic" | "traits">("basic");

  // Form state
  const [form, setForm] = useState(emptyPersona());

  const containerRef = useRef<HTMLDivElement>(null);

  // Load personas
  const loadPersonas = useCallback(async () => {
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
  }, [authClient]);

  useEffect(() => {
    loadPersonas();
  }, [loadPersonas]);

  // Select a persona for editing
  const handleSelect = useCallback((persona: CandidPersona) => {
    setSelected(persona);
    setIsCreating(false);
    setPreviewPrompt(null);
    setForm({
      id: persona.id,
      name: persona.name,
      avatar: persona.avatar,
      description: persona.description,
      personality: persona.personality,
      tone: persona.tone,
      expertise: [...persona.expertise],
      instructions: persona.instructions,
      isBuiltIn: persona.isBuiltIn,
    });
  }, []);

  // Create new
  const handleCreateNew = useCallback(() => {
    setSelected(null);
    setIsCreating(true);
    setPreviewPrompt(null);
    setForm(emptyPersona());
  }, []);

  // Update form field
  const updateField = useCallback(
    <K extends keyof ReturnType<typeof emptyPersona>>(
      field: K,
      value: ReturnType<typeof emptyPersona>[K]
    ) => {
      setForm((prev) => ({ ...prev, [field]: value }));
    },
    []
  );

  // Add expertise tag
  const handleAddExpertise = useCallback(() => {
    const tag = expertiseInput.trim();
    if (!tag || form.expertise.length >= 10) return;
    if (form.expertise.includes(tag)) {
      setExpertiseInput("");
      return;
    }
    setForm((prev) => ({ ...prev, expertise: [...prev.expertise, tag] }));
    setExpertiseInput("");
  }, [expertiseInput, form.expertise]);

  // Remove expertise tag
  const handleRemoveExpertise = useCallback((index: number) => {
    setForm((prev) => ({
      ...prev,
      expertise: prev.expertise.filter((_, i) => i !== index),
    }));
  }, []);

  // Save persona
  const handleSave = useCallback(async () => {
    if (!form.name.trim() || isSaving) return;
    setIsSaving(true);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const personaId: [] | [string] = form.id ? [form.id] : [];
      const result = await gateway.savePersona(
        personaId,
        form.name,
        form.avatar,
        form.description,
        form.personality,
        form.tone,
        form.expertise,
        form.instructions
      );
      if ("ok" in result) {
        const saved = result.ok as CandidPersona;
        setSelected(saved);
        setIsCreating(false);
        setForm({
          id: saved.id,
          name: saved.name,
          avatar: saved.avatar,
          description: saved.description,
          personality: saved.personality,
          tone: saved.tone,
          expertise: [...saved.expertise],
          instructions: saved.instructions,
          isBuiltIn: saved.isBuiltIn,
        });
        await loadPersonas();
      }
    } catch {
      // Silently fail
    } finally {
      setIsSaving(false);
    }
  }, [form, isSaving, authClient, loadPersonas]);

  // Delete persona
  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const agent = await createAgent(authClient ?? undefined);
        const gateway = createGatewayActor(agent);
        await gateway.deletePersona(id);
        setDeleteConfirm(null);
        if (selected?.id === id) {
          setSelected(null);
          setIsCreating(false);
          setForm(emptyPersona());
        }
        await loadPersonas();
      } catch {
        // Silently fail
      }
    },
    [authClient, selected, loadPersonas]
  );

  // Preview compiled prompt
  const handlePreview = useCallback(async () => {
    if (!form.id) return;
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.compilePersona(form.id);
      if ("ok" in result) {
        setPreviewPrompt(result.ok as string);
      }
    } catch {
      setPreviewPrompt("Failed to compile persona prompt.");
    }
  }, [form.id, authClient]);

  const builtInPersonas = personas.filter((p) => p.isBuiltIn);
  const userPersonas = personas.filter((p) => !p.isBuiltIn);
  const showEditor = isCreating || selected !== null;

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        height: "100vh",
        backgroundColor: "var(--bg-primary)",
        color: "var(--text-primary)",
        overflow: "hidden",
      }}
    >
      {/* Left panel: persona list */}
      <div
        style={{
          width: "40%",
          minWidth: "300px",
          maxWidth: "520px",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--bg-secondary)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "1.25rem 1.5rem 1rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>
            Personas
          </h1>
          <button
            onClick={handleCreateNew}
            style={{
              backgroundColor: "var(--accent)",
              color: "white",
              border: "none",
              borderRadius: "8px",
              padding: "0.5rem 1rem",
              fontSize: "0.85rem",
              fontWeight: 600,
              cursor: "pointer",
              transition: "opacity 0.15s ease",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = "0.85";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = "1";
            }}
          >
            + Create New
          </button>
        </div>

        {/* Persona cards */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "1rem",
          }}
        >
          {isLoading && (
            <div
              style={{
                textAlign: "center",
                padding: "2rem",
                color: "var(--text-muted)",
                fontSize: "0.85rem",
              }}
            >
              Loading personas...
            </div>
          )}

          {!isLoading && builtInPersonas.length > 0 && (
            <>
              <div style={sectionLabel}>Built-in</div>
              <div style={gridStyle}>
                {builtInPersonas.map((p) => (
                  <PersonaCard
                    key={p.id}
                    persona={p}
                    isSelected={selected?.id === p.id && !isCreating}
                    onSelect={() => handleSelect(p)}
                    onDelete={null}
                  />
                ))}
              </div>
            </>
          )}

          {!isLoading && userPersonas.length > 0 && (
            <>
              <div style={{ ...sectionLabel, marginTop: builtInPersonas.length > 0 ? "1.5rem" : 0 }}>
                My Personas
              </div>
              <div style={gridStyle}>
                {userPersonas.map((p) => (
                  <PersonaCard
                    key={p.id}
                    persona={p}
                    isSelected={selected?.id === p.id && !isCreating}
                    onSelect={() => handleSelect(p)}
                    onDelete={() => setDeleteConfirm(p.id)}
                  />
                ))}
              </div>
            </>
          )}

          {!isLoading && personas.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: "3rem 1rem",
                color: "var(--text-muted)",
                fontSize: "0.85rem",
              }}
            >
              No personas yet. Create your first one!
            </div>
          )}
        </div>
      </div>

      {/* Right panel: editor/preview */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {showEditor ? (
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "1.5rem 2rem",
            }}
          >
            <h2
              style={{
                margin: "0 0 1rem 0",
                fontSize: "1.15rem",
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              {isCreating ? "Create New Persona" : `Edit: ${selected?.name ?? ""}`}
              {form.isBuiltIn && (
                <span
                  style={{
                    marginLeft: "0.75rem",
                    fontSize: "0.7rem",
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-muted)",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    fontWeight: 500,
                    verticalAlign: "middle",
                  }}
                >
                  Read-only
                </span>
              )}
            </h2>

            {/* Tab Switcher */}
            {!isCreating && form.id && (
              <div
                style={{
                  display: "flex",
                  gap: "0",
                  marginBottom: "1.5rem",
                  backgroundColor: "var(--bg-tertiary)",
                  borderRadius: "8px",
                  padding: "3px",
                  border: "1px solid var(--border)",
                }}
              >
                <button
                  onClick={() => setActiveTab("basic")}
                  style={{
                    flex: 1,
                    padding: "0.5rem 1rem",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    border: "none",
                    borderRadius: "6px",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    backgroundColor: activeTab === "basic" ? "var(--accent)" : "transparent",
                    color: activeTab === "basic" ? "white" : "var(--text-secondary)",
                  }}
                >
                  Basic
                </button>
                <button
                  onClick={() => setActiveTab("traits")}
                  style={{
                    flex: 1,
                    padding: "0.5rem 1rem",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    border: "none",
                    borderRadius: "6px",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    backgroundColor: activeTab === "traits" ? "var(--accent)" : "transparent",
                    color: activeTab === "traits" ? "white" : "var(--text-secondary)",
                  }}
                >
                  Advanced Traits
                </button>
              </div>
            )}

            {/* Advanced Traits Tab */}
            {activeTab === "traits" && !isCreating && form.id ? (
              <PersonaTraitsPanel
                personaId={form.id}
                personaName={form.name}
                isBuiltIn={form.isBuiltIn}
              />
            ) : (
            <>
            {/* Avatar */}
            <FormField label="Avatar Emoji" count={form.avatar.length} max={4}>
              <input
                value={form.avatar}
                onChange={(e) => updateField("avatar", e.target.value.slice(0, 4))}
                placeholder="e.g. 🤖"
                disabled={form.isBuiltIn}
                style={inputStyle}
              />
            </FormField>

            {/* Name */}
            <FormField label="Name" count={form.name.length} max={50}>
              <input
                value={form.name}
                onChange={(e) => updateField("name", e.target.value.slice(0, 50))}
                placeholder="Persona name"
                disabled={form.isBuiltIn}
                style={inputStyle}
              />
            </FormField>

            {/* Description */}
            <FormField label="Description" count={form.description.length} max={200}>
              <textarea
                value={form.description}
                onChange={(e) => updateField("description", e.target.value.slice(0, 200))}
                placeholder="Brief description of this persona"
                disabled={form.isBuiltIn}
                rows={2}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </FormField>

            {/* Personality */}
            <FormField
              label="Personality"
              count={form.personality.length}
              max={500}
              helper="Core traits and behavioral style"
            >
              <textarea
                value={form.personality}
                onChange={(e) => updateField("personality", e.target.value.slice(0, 500))}
                placeholder="e.g. Friendly, analytical, detail-oriented..."
                disabled={form.isBuiltIn}
                rows={3}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </FormField>

            {/* Tone */}
            <FormField
              label="Tone"
              count={form.tone.length}
              max={200}
              helper="How does this persona communicate?"
            >
              <input
                value={form.tone}
                onChange={(e) => updateField("tone", e.target.value.slice(0, 200))}
                placeholder="e.g. Professional yet approachable"
                disabled={form.isBuiltIn}
                style={inputStyle}
              />
            </FormField>

            {/* Expertise */}
            <FormField
              label="Expertise"
              count={form.expertise.length}
              max={10}
              countLabel="tags"
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.5rem" }}>
                {form.expertise.map((tag, i) => (
                  <span
                    key={i}
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
                    {tag}
                    {!form.isBuiltIn && (
                      <button
                        onClick={() => handleRemoveExpertise(i)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "rgba(255,255,255,0.8)",
                          cursor: "pointer",
                          padding: "0 2px",
                          fontSize: "0.85rem",
                          lineHeight: 1,
                        }}
                      >
                        x
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {!form.isBuiltIn && form.expertise.length < 10 && (
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <input
                    value={expertiseInput}
                    onChange={(e) => setExpertiseInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddExpertise();
                      }
                    }}
                    placeholder="Add expertise tag..."
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    onClick={handleAddExpertise}
                    disabled={!expertiseInput.trim()}
                    style={{
                      backgroundColor: expertiseInput.trim()
                        ? "var(--accent)"
                        : "var(--bg-tertiary)",
                      color: expertiseInput.trim() ? "white" : "var(--text-muted)",
                      border: "none",
                      borderRadius: "6px",
                      padding: "0.4rem 0.75rem",
                      fontSize: "0.8rem",
                      cursor: expertiseInput.trim() ? "pointer" : "default",
                      transition: "background-color 0.15s ease",
                    }}
                  >
                    Add
                  </button>
                </div>
              )}
            </FormField>

            {/* Instructions */}
            <FormField label="Custom Instructions" count={form.instructions.length} max={1000}>
              <textarea
                value={form.instructions}
                onChange={(e) => updateField("instructions", e.target.value.slice(0, 1000))}
                placeholder="Special instructions for how this persona should behave..."
                disabled={form.isBuiltIn}
                rows={4}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </FormField>

            {/* Actions */}
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                marginTop: "1.5rem",
                paddingBottom: "2rem",
              }}
            >
              {!form.isBuiltIn && (
                <button
                  onClick={handleSave}
                  disabled={!form.name.trim() || isSaving}
                  style={{
                    backgroundColor:
                      form.name.trim() && !isSaving
                        ? "var(--accent)"
                        : "var(--bg-tertiary)",
                    color:
                      form.name.trim() && !isSaving ? "white" : "var(--text-muted)",
                    border: "none",
                    borderRadius: "8px",
                    padding: "0.6rem 1.5rem",
                    fontSize: "0.9rem",
                    fontWeight: 600,
                    cursor: form.name.trim() && !isSaving ? "pointer" : "default",
                    transition: "all 0.15s ease",
                  }}
                >
                  {isSaving ? "Saving..." : isCreating ? "Create Persona" : "Save Changes"}
                </button>
              )}

              {form.id && (
                <button
                  onClick={handlePreview}
                  style={{
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    padding: "0.6rem 1.25rem",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                  }}
                >
                  Preview Prompt
                </button>
              )}
            </div>

            {/* Preview panel */}
            {previewPrompt !== null && (
              <div
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border)",
                  borderRadius: "10px",
                  padding: "1rem 1.25rem",
                  marginBottom: "2rem",
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
                  <span
                    style={{
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    Compiled System Prompt
                  </span>
                  <button
                    onClick={() => setPreviewPrompt(null)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: "0.85rem",
                    }}
                  >
                    Close
                  </button>
                </div>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: "0.82rem",
                    lineHeight: 1.5,
                    color: "var(--text-secondary)",
                    margin: 0,
                    fontFamily: "inherit",
                  }}
                >
                  {previewPrompt}
                </pre>
              </div>
            )}
            </>
            )}
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: "0.75rem",
              color: "var(--text-muted)",
            }}
          >
            <span style={{ fontSize: "2.5rem" }}>🎭</span>
            <span style={{ fontSize: "0.95rem" }}>
              Select a persona to edit or create a new one
            </span>
          </div>
        )}
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderRadius: "12px",
              padding: "1.5rem",
              maxWidth: "360px",
              width: "90%",
              boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
            }}
          >
            <h3
              style={{
                margin: "0 0 0.75rem 0",
                fontSize: "1rem",
                fontWeight: 600,
              }}
            >
              Delete Persona?
            </h3>
            <p
              style={{
                margin: "0 0 1.25rem 0",
                fontSize: "0.85rem",
                color: "var(--text-secondary)",
                lineHeight: 1.5,
              }}
            >
              This action cannot be undone. The persona will be permanently removed.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => setDeleteConfirm(null)}
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  padding: "0.4rem 1rem",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                style={{
                  backgroundColor: "#ef4444",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  padding: "0.4rem 1rem",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

interface PersonaCardProps {
  persona: CandidPersona;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: (() => void) | null;
}

function PersonaCard({ persona, isSelected, onSelect, onDelete }: PersonaCardProps) {
  return (
    <div
      onClick={onSelect}
      style={{
        backgroundColor: isSelected ? "var(--bg-tertiary)" : "var(--bg-primary)",
        border: isSelected
          ? "2px solid var(--accent)"
          : "1px solid var(--border)",
        borderRadius: "10px",
        padding: "1rem",
        cursor: "pointer",
        transition: "all 0.15s ease",
        position: "relative",
        minHeight: "120px",
        display: "flex",
        flexDirection: "column",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLDivElement).style.borderColor = "var(--accent)";
          (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--bg-tertiary)";
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)";
          (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--bg-primary)";
        }
      }}
    >
      {/* Built-in badge */}
      {persona.isBuiltIn && (
        <span
          style={{
            position: "absolute",
            top: "0.5rem",
            right: "0.5rem",
            fontSize: "0.6rem",
            backgroundColor: "var(--bg-secondary)",
            color: "var(--text-muted)",
            padding: "1px 6px",
            borderRadius: "4px",
            fontWeight: 500,
            letterSpacing: "0.03em",
          }}
        >
          Built-in
        </span>
      )}

      {/* Delete button */}
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete persona"
          style={{
            position: "absolute",
            top: "0.5rem",
            right: "0.5rem",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "0.8rem",
            padding: "2px 5px",
            borderRadius: "4px",
            lineHeight: 1,
            transition: "color 0.15s ease",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "#ef4444";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
          }}
        >
          x
        </button>
      )}

      {/* Avatar */}
      <div
        style={{
          fontSize: "1.8rem",
          lineHeight: 1,
          marginBottom: "0.5rem",
        }}
      >
        {persona.avatar || "🎭"}
      </div>

      {/* Name */}
      <div
        style={{
          fontSize: "0.9rem",
          fontWeight: 600,
          marginBottom: "0.25rem",
          lineHeight: 1.3,
        }}
      >
        {persona.name}
      </div>

      {/* Description */}
      {persona.description && (
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--text-muted)",
            lineHeight: 1.4,
            marginBottom: "0.5rem",
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {persona.description}
        </div>
      )}

      {/* Expertise tags */}
      {persona.expertise.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.25rem",
            marginTop: "auto",
          }}
        >
          {persona.expertise.slice(0, 3).map((tag, i) => (
            <span
              key={i}
              style={{
                fontSize: "0.65rem",
                backgroundColor: "var(--accent)",
                color: "white",
                padding: "1px 6px",
                borderRadius: "999px",
                fontWeight: 500,
              }}
            >
              {tag}
            </span>
          ))}
          {persona.expertise.length > 3 && (
            <span
              style={{
                fontSize: "0.65rem",
                color: "var(--text-muted)",
                padding: "1px 4px",
              }}
            >
              +{persona.expertise.length - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Form field wrapper ──────────────────────────────────────────────

interface FormFieldProps {
  label: string;
  count: number;
  max: number;
  countLabel?: string;
  helper?: string;
  children: React.ReactNode;
}

function FormField({ label, count, max, countLabel, helper, children }: FormFieldProps) {
  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: "0.35rem",
        }}
      >
        <label
          style={{
            fontSize: "0.82rem",
            fontWeight: 600,
            color: "var(--text-secondary)",
          }}
        >
          {label}
        </label>
        <span
          style={{
            fontSize: "0.7rem",
            color: count >= max ? "#ef4444" : "var(--text-muted)",
          }}
        >
          {count}/{max}{countLabel ? ` ${countLabel}` : ""}
        </span>
      </div>
      {helper && (
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--text-muted)",
            marginBottom: "0.3rem",
            fontStyle: "italic",
          }}
        >
          {helper}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Shared styles ───────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  backgroundColor: "var(--bg-tertiary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  padding: "0.5rem 0.75rem",
  fontSize: "0.85rem",
  outline: "none",
  boxSizing: "border-box",
  transition: "border-color 0.15s ease",
};

const sectionLabel: React.CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: "0.5rem",
  padding: "0 0.25rem",
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: "0.75rem",
};
