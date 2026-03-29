/**
 * @file Grid view for comparing responses from multiple LLM models.
 *
 * Displays 2-4 model responses in a responsive grid. Each card shows the
 * model name, response text, clickable star rating, copy button, and a
 * "Best" badge. The longest response gets auto-badged but the user can
 * override by clicking a star rating or the "Best" badge.
 *
 * @module chat/ModelCompareView
 */

import { useState, useMemo, useCallback } from "react";

interface ModelCompareViewProps {
  responses: Array<{ modelId: string; reply: string }>;
  isLoading: boolean;
  onSelectBest: (modelId: string) => void;
}

/** Inject shimmer + star styles once. */
const compareStyleId = "model-compare-styles";
function ensureCompareStyles() {
  if (document.getElementById(compareStyleId)) return;
  const style = document.createElement("style");
  style.id = compareStyleId;
  style.textContent = `
    @keyframes compare-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .compare-shimmer-line {
      background: linear-gradient(
        90deg,
        var(--bg-tertiary) 25%,
        var(--bg-secondary) 50%,
        var(--bg-tertiary) 75%
      );
      background-size: 200% 100%;
      animation: compare-shimmer 1.8s ease-in-out infinite;
      border-radius: 4px;
    }
  `;
  document.head.appendChild(style);
}

/** Friendly display name from a model ID. */
function modelDisplayName(id: string): string {
  const parts = id.split("/");
  return parts[parts.length - 1] ?? id;
}

function StarRating({
  rating,
  onChange,
}: {
  rating: number;
  onChange: (r: number) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "2px" }}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          onClick={() => onChange(star)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            fontSize: "0.9rem",
            color: star <= rating ? "var(--accent)" : "var(--text-muted)",
            opacity: star <= rating ? 1 : 0.4,
            transition: "color 0.1s, opacity 0.1s",
          }}
        >
          {"\u2605"}
        </button>
      ))}
    </div>
  );
}

export default function ModelCompareView({
  responses,
  isLoading,
  onSelectBest,
}: ModelCompareViewProps) {
  ensureCompareStyles();

  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [userBest, setUserBest] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Auto-best: longest reply unless user overrode
  const autoBestId = useMemo(() => {
    if (responses.length === 0) return null;
    return responses.reduce((best, cur) =>
      cur.reply.length > best.reply.length ? cur : best
    ).modelId;
  }, [responses]);

  const bestId = userBest ?? autoBestId;

  const handleRate = useCallback((modelId: string, rating: number) => {
    setRatings((prev) => ({ ...prev, [modelId]: rating }));
  }, []);

  const handleCopy = useCallback(async (modelId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(modelId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Fallback: silent fail
    }
  }, []);

  const handleSelectBest = useCallback(
    (modelId: string) => {
      setUserBest(modelId);
      onSelectBest(modelId);
    },
    [onSelectBest]
  );

  // Grid columns: 2 for 2-4 models, capped at 4
  const colCount = Math.min(responses.length || 2, 4);

  return (
    <div style={{ padding: "0 1.5rem 1rem" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${colCount}, 1fr)`,
          gap: "0.75rem",
        }}
      >
        {responses.map((resp) => (
          <div
            key={resp.modelId}
            style={{
              backgroundColor: "var(--bg-tertiary)",
              borderRadius: 12,
              padding: "0.85rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.6rem",
              border:
                bestId === resp.modelId
                  ? "2px solid var(--accent)"
                  : "1px solid var(--border)",
              position: "relative",
            }}
          >
            {/* Best badge */}
            {bestId === resp.modelId && (
              <span
                style={{
                  position: "absolute",
                  top: -8,
                  right: 10,
                  fontSize: "0.65rem",
                  fontWeight: 700,
                  padding: "1px 8px",
                  borderRadius: 999,
                  backgroundColor: "var(--accent)",
                  color: "#fff",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                Best
              </span>
            )}

            {/* Model name header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span
                style={{
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  backgroundColor: "var(--bg-primary)",
                  padding: "2px 8px",
                  borderRadius: 6,
                }}
              >
                {modelDisplayName(resp.modelId)}
              </span>

              {/* Copy button */}
              <button
                onClick={() => handleCopy(resp.modelId, resp.reply)}
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "2px 6px",
                  fontSize: "0.68rem",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
                title="Copy response"
              >
                {copiedId === resp.modelId ? "Copied" : "Copy"}
              </button>
            </div>

            {/* Response body */}
            <div
              style={{
                flex: 1,
                fontSize: "0.88rem",
                lineHeight: 1.6,
                color: "var(--text-primary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 260,
                overflowY: "auto",
              }}
            >
              {resp.reply}
            </div>

            {/* Footer: rating + select */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <StarRating
                rating={ratings[resp.modelId] ?? 0}
                onChange={(r) => handleRate(resp.modelId, r)}
              />
              <button
                onClick={() => handleSelectBest(resp.modelId)}
                style={{
                  padding: "0.3rem 0.65rem",
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  border: "1px solid var(--accent)",
                  borderRadius: 6,
                  backgroundColor:
                    bestId === resp.modelId
                      ? "var(--accent)"
                      : "transparent",
                  color:
                    bestId === resp.modelId ? "#fff" : "var(--accent)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                Use this
              </button>
            </div>
          </div>
        ))}

        {/* Loading placeholders for expected models that haven't responded */}
        {isLoading &&
          responses.length === 0 &&
          Array.from({ length: 2 }).map((_, i) => (
            <div
              key={`placeholder-${i}`}
              style={{
                backgroundColor: "var(--bg-tertiary)",
                borderRadius: 12,
                padding: "0.85rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
                border: "1px solid var(--border)",
              }}
            >
              <div className="compare-shimmer-line" style={{ height: 16, width: "50%" }} />
              <div className="compare-shimmer-line" style={{ height: 12, width: "90%" }} />
              <div className="compare-shimmer-line" style={{ height: 12, width: "78%" }} />
              <div className="compare-shimmer-line" style={{ height: 12, width: "85%" }} />
              <div className="compare-shimmer-line" style={{ height: 12, width: "62%" }} />
            </div>
          ))}
      </div>
    </div>
  );
}
