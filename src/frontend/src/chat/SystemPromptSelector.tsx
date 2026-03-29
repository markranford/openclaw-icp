/**
 * @file Dropdown selector for choosing or creating a system prompt template.
 *
 * Displayed in the chat header when starting a new conversation (messages.length === 0).
 * After the first message is sent, shows a readonly badge with the template name.
 *
 * Features:
 * - Lists built-in templates (grouped first) and user-created templates
 * - "Custom..." option reveals a textarea for free-form input
 * - "Save as Template" button when custom text is entered
 * - "None" option to clear the system prompt
 * - Delete button for user-created templates
 *
 * @module chat/SystemPromptSelector
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import {
  createGatewayActor,
  type CandidSystemPromptTemplate,
} from "../api/gateway.did";

/** Props for the SystemPromptSelector component. */
interface SystemPromptSelectorProps {
  /** The current system prompt text (empty string = none). */
  systemPrompt: string;
  /** The display name for the active template (empty = none). */
  systemPromptName: string;
  /** Called when the user selects a template or enters custom text. */
  onSelect: (prompt: string, name: string) => void;
  /** Whether the conversation has started (messages have been sent). */
  hasMessages: boolean;
}

export default function SystemPromptSelector({
  systemPrompt,
  systemPromptName,
  onSelect,
  hasMessages,
}: SystemPromptSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [templates, setTemplates] = useState<CandidSystemPromptTemplate[]>([]);
  const [isCustom, setIsCustom] = useState(false);
  const [customText, setCustomText] = useState("");
  const [saveName, setSaveName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { authClient } = useAuth();

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsCustom(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  // Load templates when dropdown opens
  const loadTemplates = useCallback(async () => {
    if (isLoadingTemplates) return;
    setIsLoadingTemplates(true);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.listTemplates();
      if ("ok" in result) {
        setTemplates(result.ok as CandidSystemPromptTemplate[]);
      }
    } catch {
      // Silently fail — templates are a nice-to-have
    } finally {
      setIsLoadingTemplates(false);
    }
  }, [authClient, isLoadingTemplates]);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    setIsCustom(false);
    loadTemplates();
  }, [loadTemplates]);

  const handleSelectTemplate = useCallback(
    (tpl: CandidSystemPromptTemplate) => {
      onSelect(tpl.content, tpl.name);
      setIsOpen(false);
      setIsCustom(false);
    },
    [onSelect],
  );

  const handleClear = useCallback(() => {
    onSelect("", "");
    setIsOpen(false);
    setIsCustom(false);
    setCustomText("");
  }, [onSelect]);

  const handleCustomApply = useCallback(() => {
    if (customText.trim()) {
      onSelect(customText.trim(), "Custom");
      setIsOpen(false);
      setIsCustom(false);
    }
  }, [customText, onSelect]);

  const handleSaveAsTemplate = useCallback(async () => {
    if (!saveName.trim() || !customText.trim() || isSaving) return;
    setIsSaving(true);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.saveTemplate(saveName.trim(), customText.trim());
      if ("ok" in result) {
        const saved = result.ok as CandidSystemPromptTemplate;
        onSelect(saved.content, saved.name);
        setIsOpen(false);
        setIsCustom(false);
        setCustomText("");
        setSaveName("");
      }
    } catch {
      // Silently fail
    } finally {
      setIsSaving(false);
    }
  }, [saveName, customText, isSaving, authClient, onSelect]);

  const handleDelete = useCallback(
    async (templateId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const agent = await createAgent(authClient ?? undefined);
        const gateway = createGatewayActor(agent);
        await gateway.deleteTemplate(templateId);
        setTemplates((prev) => prev.filter((t) => t.id !== templateId));
      } catch {
        // Silently fail
      }
    },
    [authClient],
  );

  // After first message: show readonly badge
  if (hasMessages) {
    if (!systemPromptName) return null;
    return (
      <span
        style={{
          fontSize: "0.75rem",
          color: "var(--text-muted)",
          backgroundColor: "var(--bg-tertiary)",
          padding: "0.2rem 0.5rem",
          borderRadius: "6px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "180px",
        }}
        title={systemPrompt}
      >
        System: {systemPromptName}
      </span>
    );
  }

  const builtInTemplates = templates.filter((t) => t.isBuiltIn);
  const userTemplates = templates.filter((t) => !t.isBuiltIn);

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      {/* Trigger button */}
      <button
        onClick={() => (isOpen ? setIsOpen(false) : handleOpen())}
        style={{
          backgroundColor: systemPrompt ? "var(--accent)" : "var(--bg-tertiary)",
          color: systemPrompt ? "white" : "var(--text-primary)",
          border: "1px solid var(--border)",
          borderRadius: "8px",
          padding: "0.4rem 0.75rem",
          fontSize: "0.85rem",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {systemPromptName || "System Prompt"}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            width: "320px",
            maxHeight: "420px",
            overflowY: "auto",
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
            zIndex: 100,
          }}
        >
          {isCustom ? (
            /* Custom prompt editor */
            <div style={{ padding: "0.75rem" }}>
              <textarea
                value={customText}
                onChange={(e) => setCustomText(e.target.value.slice(0, 2000))}
                placeholder="Enter your custom system prompt..."
                rows={5}
                style={{
                  width: "100%",
                  resize: "vertical",
                  backgroundColor: "var(--bg-primary)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  padding: "0.5rem",
                  fontSize: "0.85rem",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: "0.5rem",
                  fontSize: "0.75rem",
                  color: "var(--text-muted)",
                }}
              >
                <span>{customText.length}/2000</span>
                <button
                  onClick={handleCustomApply}
                  disabled={!customText.trim()}
                  style={{
                    backgroundColor: customText.trim() ? "var(--accent)" : "var(--bg-tertiary)",
                    color: customText.trim() ? "white" : "var(--text-muted)",
                    border: "none",
                    borderRadius: "6px",
                    padding: "0.3rem 0.6rem",
                    fontSize: "0.8rem",
                    cursor: customText.trim() ? "pointer" : "default",
                  }}
                >
                  Apply
                </button>
              </div>
              {/* Save as template row */}
              <div
                style={{
                  display: "flex",
                  gap: "0.4rem",
                  marginTop: "0.5rem",
                  alignItems: "center",
                }}
              >
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value.slice(0, 60))}
                  placeholder="Template name"
                  style={{
                    flex: 1,
                    backgroundColor: "var(--bg-primary)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    padding: "0.3rem 0.5rem",
                    fontSize: "0.8rem",
                    outline: "none",
                  }}
                />
                <button
                  onClick={handleSaveAsTemplate}
                  disabled={!saveName.trim() || !customText.trim() || isSaving}
                  style={{
                    backgroundColor:
                      saveName.trim() && customText.trim() && !isSaving
                        ? "var(--accent)"
                        : "var(--bg-tertiary)",
                    color:
                      saveName.trim() && customText.trim() && !isSaving
                        ? "white"
                        : "var(--text-muted)",
                    border: "none",
                    borderRadius: "6px",
                    padding: "0.3rem 0.6rem",
                    fontSize: "0.8rem",
                    cursor:
                      saveName.trim() && customText.trim() && !isSaving ? "pointer" : "default",
                    whiteSpace: "nowrap",
                  }}
                >
                  {isSaving ? "..." : "Save"}
                </button>
              </div>
              <button
                onClick={() => setIsCustom(false)}
                style={{
                  marginTop: "0.5rem",
                  backgroundColor: "transparent",
                  color: "var(--text-muted)",
                  border: "none",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                Back to templates
              </button>
            </div>
          ) : (
            /* Template list */
            <div>
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
                None (no system prompt)
              </button>

              {/* Built-in templates */}
              {builtInTemplates.length > 0 && (
                <div>
                  <div style={sectionLabelStyle}>Built-in</div>
                  {builtInTemplates.map((tpl) => (
                    <button
                      key={tpl.id}
                      onClick={() => handleSelectTemplate(tpl)}
                      style={{
                        ...itemStyle,
                        fontWeight: systemPrompt === tpl.content ? 600 : 400,
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>{tpl.name}</div>
                      <div style={previewStyle}>
                        {tpl.content.length > 80
                          ? tpl.content.slice(0, 80) + "..."
                          : tpl.content}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* User templates */}
              {userTemplates.length > 0 && (
                <div>
                  <div style={sectionLabelStyle}>My Templates</div>
                  {userTemplates.map((tpl) => (
                    <div key={tpl.id} style={{ position: "relative" }}>
                      <button
                        onClick={() => handleSelectTemplate(tpl)}
                        style={{
                          ...itemStyle,
                          fontWeight: systemPrompt === tpl.content ? 600 : 400,
                          paddingRight: "2.5rem",
                        }}
                      >
                        <div style={{ fontWeight: 500 }}>{tpl.name}</div>
                        <div style={previewStyle}>
                          {tpl.content.length > 80
                            ? tpl.content.slice(0, 80) + "..."
                            : tpl.content}
                        </div>
                      </button>
                      <button
                        onClick={(e) => handleDelete(tpl.id, e)}
                        title="Delete template"
                        style={{
                          position: "absolute",
                          right: "0.5rem",
                          top: "50%",
                          transform: "translateY(-50%)",
                          backgroundColor: "transparent",
                          border: "none",
                          color: "var(--text-muted)",
                          cursor: "pointer",
                          fontSize: "0.85rem",
                          padding: "0.2rem 0.4rem",
                          borderRadius: "4px",
                        }}
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Custom option */}
              <button
                onClick={() => setIsCustom(true)}
                style={{
                  ...itemStyle,
                  borderTop: "1px solid var(--border)",
                  color: "var(--accent)",
                  fontWeight: 500,
                }}
              >
                Custom...
              </button>

              {isLoadingTemplates && (
                <div
                  style={{
                    padding: "0.5rem 0.75rem",
                    fontSize: "0.8rem",
                    color: "var(--text-muted)",
                    textAlign: "center",
                  }}
                >
                  Loading...
                </div>
              )}
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
  padding: "0.6rem 0.75rem",
  cursor: "pointer",
  fontSize: "0.85rem",
  lineHeight: 1.4,
};

const sectionLabelStyle: React.CSSProperties = {
  padding: "0.4rem 0.75rem 0.2rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const previewStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-muted)",
  marginTop: "0.15rem",
  lineHeight: 1.3,
};
