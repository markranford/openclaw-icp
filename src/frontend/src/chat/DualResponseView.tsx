/**
 * @file Side-by-side dual response view for MagickMind's Dual Brain mode.
 *
 * Shows the fast brain and smart brain responses in two equal columns.
 * The smart panel displays a loading shimmer until its reply arrives.
 * Each panel has a "Use this" button to select the official response.
 * Includes a collapse toggle and subtle diff highlighting.
 *
 * @module chat/DualResponseView
 */

import { useState, useMemo, useCallback } from "react";

interface DualResponseViewProps {
  fastReply: string;
  smartReply: string | null; // null while loading
  onSelectReply: (reply: "fast" | "smart") => void;
  isLoading: boolean;
}

/** Inject shimmer animation once. */
const shimmerStyleId = "dual-response-shimmer-styles";
function ensureShimmerStyles() {
  if (document.getElementById(shimmerStyleId)) return;
  const style = document.createElement("style");
  style.id = shimmerStyleId;
  style.textContent = `
    @keyframes shimmer-pulse {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .dual-shimmer {
      background: linear-gradient(
        90deg,
        var(--bg-tertiary) 25%,
        var(--bg-secondary) 50%,
        var(--bg-tertiary) 75%
      );
      background-size: 200% 100%;
      animation: shimmer-pulse 1.8s ease-in-out infinite;
      border-radius: 4px;
    }
  `;
  document.head.appendChild(style);
}

/** Simple word-level diff: returns arrays of segments with highlight flags. */
function diffWords(a: string, b: string): { aSegments: { text: string; diff: boolean }[]; bSegments: { text: string; diff: boolean }[] } {
  const wordsA = a.split(/(\s+)/);
  const wordsB = b.split(/(\s+)/);
  const maxLen = Math.max(wordsA.length, wordsB.length);

  const aSegments: { text: string; diff: boolean }[] = [];
  const bSegments: { text: string; diff: boolean }[] = [];

  for (let i = 0; i < maxLen; i++) {
    const wa = wordsA[i] ?? "";
    const wb = wordsB[i] ?? "";
    const isDiff = wa !== wb;
    if (wa) aSegments.push({ text: wa, diff: isDiff });
    if (wb) bSegments.push({ text: wb, diff: isDiff });
  }

  return { aSegments, bSegments };
}

export default function DualResponseView({
  fastReply,
  smartReply,
  onSelectReply,
  isLoading,
}: DualResponseViewProps) {
  ensureShimmerStyles();

  const [collapsed, setCollapsed] = useState<"none" | "fast" | "smart">("none");

  const { aSegments, bSegments } = useMemo(() => {
    if (!smartReply) return { aSegments: [], bSegments: [] };
    return diffWords(fastReply, smartReply);
  }, [fastReply, smartReply]);

  const renderHighlighted = useCallback(
    (segments: { text: string; diff: boolean }[]) =>
      segments.map((seg, i) => (
        <span
          key={i}
          style={
            seg.diff
              ? { backgroundColor: "rgba(var(--accent-rgb, 99,102,241), 0.15)", borderRadius: 2 }
              : undefined
          }
        >
          {seg.text}
        </span>
      )),
    []
  );

  const cardStyle: React.CSSProperties = {
    flex: 1,
    backgroundColor: "var(--bg-tertiary)",
    borderRadius: 12,
    padding: "1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    minWidth: 0,
  };

  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    fontSize: "0.82rem",
    fontWeight: 600,
    color: "var(--text-secondary)",
  };

  const bodyStyle: React.CSSProperties = {
    fontSize: "0.92rem",
    lineHeight: 1.6,
    color: "var(--text-primary)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    flex: 1,
  };

  const btnStyle: React.CSSProperties = {
    padding: "0.4rem 0.85rem",
    fontSize: "0.78rem",
    fontWeight: 600,
    border: "1px solid var(--accent)",
    borderRadius: 6,
    backgroundColor: "transparent",
    color: "var(--accent)",
    cursor: "pointer",
    transition: "all 0.15s ease",
    alignSelf: "flex-start",
  };

  const showFast = collapsed !== "fast";
  const showSmart = collapsed !== "smart";

  return (
    <div style={{ padding: "0 1.5rem 1rem" }}>
      {/* Collapse toggle */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: "0.5rem",
          gap: "0.4rem",
        }}
      >
        {collapsed !== "none" && (
          <button
            onClick={() => setCollapsed("none")}
            style={{
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-muted)",
              fontSize: "0.7rem",
              padding: "0.15rem 0.5rem",
              cursor: "pointer",
            }}
          >
            Show both
          </button>
        )}
        {showFast && showSmart && (
          <>
            <button
              onClick={() => setCollapsed("smart")}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-muted)",
                fontSize: "0.7rem",
                padding: "0.15rem 0.5rem",
                cursor: "pointer",
              }}
            >
              Hide smart
            </button>
            <button
              onClick={() => setCollapsed("fast")}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-muted)",
                fontSize: "0.7rem",
                padding: "0.15rem 0.5rem",
                cursor: "pointer",
              }}
            >
              Hide fast
            </button>
          </>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: "1px",
          backgroundColor: "var(--border)",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        {/* Fast Brain panel */}
        {showFast && (
          <div style={cardStyle}>
            <div style={headerStyle}>
              <span>{"\u26A1"}</span> Fast Brain
            </div>
            <div style={bodyStyle}>
              {smartReply && aSegments.length > 0
                ? renderHighlighted(aSegments)
                : fastReply}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
                {new Date().toLocaleTimeString()}
              </span>
              <button style={btnStyle} onClick={() => onSelectReply("fast")}>
                Use this
              </button>
            </div>
          </div>
        )}

        {/* Smart Brain panel */}
        {showSmart && (
          <div style={cardStyle}>
            <div style={headerStyle}>
              <span>{"\uD83E\uDDE0"}</span> Smart Brain
            </div>
            {smartReply === null || isLoading ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <div className="dual-shimmer" style={{ height: 14, width: "90%" }} />
                <div className="dual-shimmer" style={{ height: 14, width: "75%" }} />
                <div className="dual-shimmer" style={{ height: 14, width: "85%" }} />
                <div className="dual-shimmer" style={{ height: 14, width: "60%" }} />
                <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
                  Processing deeper response...
                </span>
              </div>
            ) : (
              <>
                <div style={bodyStyle}>
                  {bSegments.length > 0 ? renderHighlighted(bSegments) : smartReply}
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
                    {new Date().toLocaleTimeString()}
                  </span>
                  <button style={btnStyle} onClick={() => onSelectReply("smart")}>
                    Use this
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
