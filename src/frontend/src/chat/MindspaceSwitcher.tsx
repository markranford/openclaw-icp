import { useState, useRef, useEffect, useCallback } from "react";

interface MindspaceSwitcherProps {
  mindspaceId: string;
  onChange: (newMindspaceId: string) => void;
}

/**
 * Compact inline-editable pill that shows and lets users change
 * the active MagickMind mindspace. Designed to sit in the chat header bar.
 */
export default function MindspaceSwitcher({ mindspaceId, onChange }: MindspaceSwitcherProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(mindspaceId);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync draft when the prop changes externally
  useEffect(() => {
    if (!isEditing) setDraft(mindspaceId);
  }, [mindspaceId, isEditing]);

  // Auto-focus the input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== mindspaceId) {
      onChange(trimmed);
    } else {
      setDraft(mindspaceId);
    }
    setIsEditing(false);
  }, [draft, mindspaceId, onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        setDraft(mindspaceId);
        setIsEditing(false);
      }
    },
    [commit, mindspaceId],
  );

  if (isEditing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <span style={{ fontSize: "0.85rem", lineHeight: 1 }}>🧠</span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          style={{
            width: "120px",
            padding: "3px 6px",
            fontSize: "0.78rem",
            fontFamily: "inherit",
            border: "1px solid var(--accent)",
            borderRadius: "6px",
            backgroundColor: "var(--bg-primary)",
            color: "var(--text-primary)",
            outline: "none",
          }}
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => setIsEditing(true)}
      title="Click to change mindspace"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "3px 8px",
        fontSize: "0.78rem",
        fontFamily: "inherit",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        backgroundColor: "var(--bg-tertiary)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        transition: "border-color 0.15s",
        lineHeight: 1.3,
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
      }}
    >
      <span style={{ fontSize: "0.85rem", lineHeight: 1 }}>🧠</span>
      <span>{mindspaceId}</span>
    </button>
  );
}
