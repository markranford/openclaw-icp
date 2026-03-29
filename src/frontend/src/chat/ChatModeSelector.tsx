/**
 * @file Segmented control for selecting the chat mode when MagickMind is active.
 *
 * Three modes:
 * - **Standard** — normal single response
 * - **Dual Brain** — fires dualPrompt, shows fast + smart side-by-side
 * - **Compare** — opens model picker, fires compareModels
 *
 * When "Compare" is selected, a small popover lets the user pick 2-4 models
 * from a checklist of suggested models, plus a text input for custom IDs.
 *
 * @module chat/ChatModeSelector
 */

import { useState, useCallback, useRef, useEffect } from "react";

type ChatMode = "standard" | "dual" | "compare";

interface ChatModeSelectorProps {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  compareModels: string[];
  onCompareModelsChange: (models: string[]) => void;
}

const SUGGESTED_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "openrouter/meta-llama/llama-4-maverick",
];

const MODES: { key: ChatMode; label: string }[] = [
  { key: "standard", label: "Standard" },
  { key: "dual", label: "Dual Brain" },
  { key: "compare", label: "Compare" },
];

export default function ChatModeSelector({
  mode,
  onModeChange,
  compareModels,
  onCompareModelsChange,
}: ChatModeSelectorProps) {
  const [showPopover, setShowPopover] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!showPopover) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showPopover]);

  const handleModeClick = useCallback(
    (m: ChatMode) => {
      onModeChange(m);
      if (m === "compare") {
        setShowPopover(true);
      } else {
        setShowPopover(false);
      }
    },
    [onModeChange]
  );

  const toggleModel = useCallback(
    (model: string) => {
      if (compareModels.includes(model)) {
        if (compareModels.length <= 2) return; // minimum 2
        onCompareModelsChange(compareModels.filter((m) => m !== model));
      } else {
        if (compareModels.length >= 4) return; // maximum 4
        onCompareModelsChange([...compareModels, model]);
      }
    },
    [compareModels, onCompareModelsChange]
  );

  const handleAddCustom = useCallback(() => {
    const trimmed = customInput.trim();
    if (!trimmed || compareModels.includes(trimmed) || compareModels.length >= 4) return;
    onCompareModelsChange([...compareModels, trimmed]);
    setCustomInput("");
  }, [customInput, compareModels, onCompareModelsChange]);

  const pillBase: React.CSSProperties = {
    padding: "0.25rem 0.6rem",
    fontSize: "0.72rem",
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
    transition: "all 0.15s ease",
    lineHeight: 1.3,
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }} ref={popoverRef}>
      {/* Segmented control */}
      <div
        style={{
          display: "flex",
          backgroundColor: "var(--bg-primary)",
          borderRadius: 8,
          border: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        {MODES.map((m, i) => (
          <button
            key={m.key}
            onClick={() => handleModeClick(m.key)}
            style={{
              ...pillBase,
              backgroundColor: mode === m.key ? "var(--accent)" : "transparent",
              color: mode === m.key ? "#fff" : "var(--text-muted)",
              borderLeft: i > 0 ? "1px solid var(--border)" : "none",
              borderRadius: 0,
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Compare model picker popover */}
      {showPopover && mode === "compare" && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 100,
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "0.75rem",
            minWidth: 240,
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
          }}
        >
          <div
            style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              color: "var(--text-secondary)",
              marginBottom: "0.5rem",
            }}
          >
            Select 2-4 models to compare
          </div>

          {/* Checklist */}
          {SUGGESTED_MODELS.map((model) => {
            const checked = compareModels.includes(model);
            const disabled =
              (!checked && compareModels.length >= 4) ||
              (checked && compareModels.length <= 2);
            return (
              <label
                key={model}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  padding: "0.25rem 0",
                  fontSize: "0.78rem",
                  color: disabled && !checked ? "var(--text-muted)" : "var(--text-primary)",
                  cursor: disabled ? "default" : "pointer",
                  opacity: disabled && !checked ? 0.5 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggleModel(model)}
                  style={{ accentColor: "var(--accent)" }}
                />
                {model.split("/").pop()}
              </label>
            );
          })}

          {/* Custom model input */}
          <div
            style={{
              display: "flex",
              gap: "0.3rem",
              marginTop: "0.5rem",
              borderTop: "1px solid var(--border)",
              paddingTop: "0.5rem",
            }}
          >
            <input
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddCustom();
                }
              }}
              placeholder="Custom model ID..."
              style={{
                flex: 1,
                padding: "0.3rem 0.5rem",
                fontSize: "0.75rem",
                backgroundColor: "var(--bg-primary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                outline: "none",
              }}
            />
            <button
              onClick={handleAddCustom}
              disabled={!customInput.trim() || compareModels.length >= 4}
              style={{
                padding: "0.3rem 0.5rem",
                fontSize: "0.72rem",
                fontWeight: 600,
                backgroundColor:
                  customInput.trim() && compareModels.length < 4
                    ? "var(--accent)"
                    : "var(--bg-tertiary)",
                color:
                  customInput.trim() && compareModels.length < 4
                    ? "#fff"
                    : "var(--text-muted)",
                border: "none",
                borderRadius: 4,
                cursor:
                  customInput.trim() && compareModels.length < 4
                    ? "pointer"
                    : "default",
              }}
            >
              Add
            </button>
          </div>

          {/* Currently selected (non-suggested) */}
          {compareModels
            .filter((m) => !SUGGESTED_MODELS.includes(m))
            .map((model) => (
              <div
                key={model}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: "0.3rem",
                  fontSize: "0.75rem",
                  color: "var(--text-primary)",
                }}
              >
                <span>{model}</span>
                <button
                  onClick={() => toggleModel(model)}
                  disabled={compareModels.length <= 2}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: compareModels.length <= 2 ? "default" : "pointer",
                    fontSize: "0.75rem",
                    padding: "0 4px",
                  }}
                >
                  x
                </button>
              </div>
            ))}

          <button
            onClick={() => setShowPopover(false)}
            style={{
              width: "100%",
              marginTop: "0.6rem",
              padding: "0.35rem",
              fontSize: "0.72rem",
              fontWeight: 600,
              backgroundColor: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
