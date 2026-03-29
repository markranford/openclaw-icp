/**
 * @file Compact compute power slider for the chat header.
 *
 * Displays a small horizontal slider with speed/depth endpoints that lets
 * the user adjust MagickMind's compute_power value (0-100) in real time.
 * The value is committed on mouseUp/touchEnd to avoid excessive saves.
 *
 * @module chat/ComputePowerSlider
 */

import { useCallback, useRef } from "react";

interface ComputePowerSliderProps {
  value: number;
  onChange: (value: number) => void;
}

/** Inject slider-thumb styling once (needed for cross-browser range input). */
const sliderStyleId = "compute-power-slider-styles";
function ensureSliderStyles() {
  if (document.getElementById(sliderStyleId)) return;
  const style = document.createElement("style");
  style.id = sliderStyleId;
  style.textContent = `
    .compute-power-range {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      border-radius: 2px;
      background: linear-gradient(to right, var(--accent), var(--text-muted));
      outline: none;
      cursor: pointer;
    }
    .compute-power-range::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--accent);
      border: 2px solid var(--bg-secondary);
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .compute-power-range::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--accent);
      border: 2px solid var(--bg-secondary);
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
  `;
  document.head.appendChild(style);
}

export default function ComputePowerSlider({ value, onChange }: ComputePowerSliderProps) {
  const localRef = useRef(value);

  // Keep local ref in sync with prop when not dragging
  if (localRef.current !== value) {
    localRef.current = value;
  }

  // Inject styles on first render
  ensureSliderStyles();

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    localRef.current = parseInt(e.target.value, 10);
    // Force re-render so the label updates during drag
    // We call onChange only on commit (mouseUp/touchEnd)
    e.target.parentElement?.querySelector<HTMLSpanElement>("[data-cp-label]")
      ?.replaceChildren(String(localRef.current));
  }, []);

  const handleCommit = useCallback(() => {
    onChange(localRef.current);
  }, [onChange]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.35rem",
        minWidth: 120,
        maxWidth: 140,
      }}
    >
      {/* Speed icon */}
      <span style={{ fontSize: "0.8rem", lineHeight: 1 }} title="Speed">
        {"\u26A1"}
      </span>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "1px" }}>
        <input
          type="range"
          className="compute-power-range"
          min={0}
          max={100}
          defaultValue={value}
          onInput={handleInput}
          onMouseUp={handleCommit}
          onTouchEnd={handleCommit}
          style={{ width: "100%" }}
        />
        <span
          data-cp-label=""
          style={{
            fontSize: "0.6rem",
            color: "var(--text-muted)",
            lineHeight: 1,
          }}
        >
          {value}
        </span>
      </div>

      {/* Depth icon */}
      <span style={{ fontSize: "0.8rem", lineHeight: 1 }} title="Depth">
        {"\uD83E\uDDE0"}
      </span>
    </div>
  );
}
