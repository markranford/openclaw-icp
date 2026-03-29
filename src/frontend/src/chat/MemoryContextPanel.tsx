/**
 * @file Collapsible sidebar panel for the chat view that shows memory context.
 *
 * Shows active context info, quick memory search, knowledge base selector,
 * and a memory timeline of recalled facts.
 *
 * @module chat/MemoryContextPanel
 */

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import { createGatewayActor, type CandidMemoryResult } from "../api/gateway.did";

// ── Helpers ──────────────────────────────────────────────────────────

function unwrap(result: CandidMemoryResult): string {
  if ("Success" in result) return result.Success;
  if ("Failed" in result) throw new Error(result.Failed);
  throw new Error(("NotConfigured" in result) ? result.NotConfigured : "Unknown error");
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Types ────────────────────────────────────────────────────────────

interface CorpusItem {
  id: string;
  name: string;
  description?: string;
  chunkCount?: number;
}

interface MemoryEntry {
  content: string;
  source: "corpus" | "episodic" | "chat";
  timestamp?: string;
}

export interface MemoryContextPanelProps {
  mindspaceId: string;
  isOpen: boolean;
  onToggle: () => void;
  onContextLoaded: (context: string) => void;
}

// ── Component ────────────────────────────────────────────────────────

export default function MemoryContextPanel({
  mindspaceId,
  isOpen,
  onToggle,
  onContextLoaded,
}: MemoryContextPanelProps) {
  const { authClient } = useAuth();

  // Active context state
  const [contextLoaded, setContextLoaded] = useState(false);
  const [corpusChunks, setCorpusChunks] = useState(0);
  const [episodicCount, setEpisodicCount] = useState(0);
  const [historyCount, setHistoryCount] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [loading, setLoading] = useState(false);

  // Quick search state
  const [quickQuery, setQuickQuery] = useState("");
  const [quickResults, setQuickResults] = useState<Array<{ content: string; timestamp?: string }>>([]);
  const [quickSearching, setQuickSearching] = useState(false);

  // Knowledge base selector state
  const [allCorpora, setAllCorpora] = useState<CorpusItem[]>([]);
  const [activeCorpusIds, setActiveCorpusIds] = useState<Set<string>>(new Set());

  // Memory timeline
  const [timeline, setTimeline] = useState<MemoryEntry[]>([]);

  const getGateway = useCallback(async () => {
    const agent = await createAgent(authClient ?? undefined);
    return createGatewayActor(agent);
  }, [authClient]);

  // Load corpora list
  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      try {
        const gw = await getGateway();
        const result = await gw.listCorpora();
        const data = tryParse(unwrap(result));
        if (Array.isArray(data)) {
          setAllCorpora(data as CorpusItem[]);
        }
      } catch {
        // Silently handle
      }
    })();
  }, [isOpen, getGateway]);

  // Load context on mount or refresh
  const loadContext = useCallback(async () => {
    setLoading(true);
    try {
      const gw = await getGateway();
      const result = await gw.prepareContext(mindspaceId, BigInt(20), [], []);
      const raw = unwrap(result);
      const parsed = tryParse(raw);

      // Try to extract sections from the composed context
      let chunks = 0;
      let episodic = 0;
      let history = 0;

      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.corpusChunks)) chunks = obj.corpusChunks.length;
        if (Array.isArray(obj.episodicMemories)) episodic = obj.episodicMemories.length;
        if (Array.isArray(obj.chatHistory)) history = obj.chatHistory.length;

        // Build timeline from available data
        const entries: MemoryEntry[] = [];
        if (Array.isArray(obj.corpusChunks)) {
          (obj.corpusChunks as Array<{ content?: string }>).slice(0, 3).forEach(c => {
            entries.push({ content: (c.content || String(c)).slice(0, 100) + "...", source: "corpus" });
          });
        }
        if (Array.isArray(obj.episodicMemories)) {
          (obj.episodicMemories as Array<{ content?: string; timestamp?: string }>).slice(0, 3).forEach(m => {
            entries.push({
              content: (m.content || String(m)).slice(0, 100) + "...",
              source: "episodic",
              timestamp: m.timestamp,
            });
          });
        }
        setTimeline(entries);
      }

      setCorpusChunks(chunks);
      setEpisodicCount(episodic);
      setHistoryCount(history);
      setTotalTokens(estimateTokens(raw));
      setContextLoaded(true);
      onContextLoaded(raw);
    } catch {
      setContextLoaded(false);
    } finally {
      setLoading(false);
    }
  }, [mindspaceId, getGateway, onContextLoaded]);

  useEffect(() => {
    if (isOpen) loadContext();
  }, [isOpen, loadContext]);

  // Quick search
  const handleQuickSearch = useCallback(async () => {
    if (!quickQuery.trim()) return;
    setQuickSearching(true);
    try {
      const gw = await getGateway();
      const result = await gw.prepareContext("default", BigInt(0), [], [quickQuery.trim()]);
      const raw = unwrap(result);
      const parsed = tryParse(raw);
      if (Array.isArray(parsed)) {
        setQuickResults(parsed.slice(0, 5) as Array<{ content: string; timestamp?: string }>);
      } else {
        setQuickResults([{ content: raw.slice(0, 300) }]);
      }
    } catch {
      setQuickResults([]);
    } finally {
      setQuickSearching(false);
    }
  }, [quickQuery, getGateway]);

  // Toggle corpus
  const handleToggleCorpus = useCallback((corpusId: string) => {
    setActiveCorpusIds(prev => {
      const next = new Set(prev);
      if (next.has(corpusId)) next.delete(corpusId);
      else next.add(corpusId);
      return next;
    });
    // Re-compose context would happen in a real implementation
  }, []);

  if (!isOpen) return null;

  const sourceColors: Record<string, string> = {
    corpus: "#6366f1",
    episodic: "#22c55e",
    chat: "#eab308",
  };

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        backgroundColor: "var(--bg-secondary)",
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: "0.88rem", fontWeight: 600 }}>Memory Context</span>
        <button
          onClick={onToggle}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "1rem",
            padding: 0,
          }}
        >
          x
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "0.75rem" }}>
        {/* Section 1: Active Context */}
        <div style={{ marginBottom: "1rem" }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.5rem",
          }}>
            <h4 style={{ margin: 0, fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>
              ACTIVE CONTEXT
            </h4>
            <button
              onClick={loadContext}
              disabled={loading}
              style={{
                background: "none",
                border: "none",
                color: "var(--accent)",
                cursor: loading ? "not-allowed" : "pointer",
                fontSize: "0.72rem",
                padding: 0,
                opacity: loading ? 0.5 : 1,
              }}
            >
              {loading ? "..." : "Refresh"}
            </button>
          </div>

          {contextLoaded ? (
            <div style={{
              backgroundColor: "var(--bg-primary)",
              borderRadius: 8,
              padding: "0.65rem 0.75rem",
              fontSize: "0.78rem",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem" }}>
                <span style={{ color: "var(--text-secondary)" }}>Mindspace</span>
                <span style={{ fontWeight: 500 }}>{mindspaceId}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem" }}>
                <span style={{ color: "var(--text-secondary)" }}>Corpus chunks</span>
                <span style={{ fontWeight: 500 }}>{corpusChunks}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem" }}>
                <span style={{ color: "var(--text-secondary)" }}>Episodic memories</span>
                <span style={{ fontWeight: 500 }}>{episodicCount}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem" }}>
                <span style={{ color: "var(--text-secondary)" }}>Chat messages</span>
                <span style={{ fontWeight: 500 }}>{historyCount}</span>
              </div>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                paddingTop: "0.3rem",
                borderTop: "1px solid var(--border)",
                marginTop: "0.3rem",
              }}>
                <span style={{ color: "var(--text-secondary)" }}>Est. tokens</span>
                <span style={{ fontWeight: 500, fontFamily: "monospace", color: "var(--text-muted)" }}>
                  ~{totalTokens.toLocaleString()}
                </span>
              </div>
            </div>
          ) : (
            <div style={{
              textAlign: "center",
              padding: "0.75rem",
              fontSize: "0.78rem",
              color: "var(--text-muted)",
            }}>
              {loading ? "Loading context..." : "No context loaded"}
            </div>
          )}
        </div>

        {/* Section 2: Quick Memory Search */}
        <div style={{ marginBottom: "1rem" }}>
          <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>
            QUICK MEMORY SEARCH
          </h4>
          <div style={{ display: "flex", gap: "0.3rem", marginBottom: "0.5rem" }}>
            <input
              style={{
                flex: 1,
                padding: "0.35rem 0.5rem",
                backgroundColor: "var(--bg-primary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                fontSize: "0.78rem",
                outline: "none",
              }}
              value={quickQuery}
              onChange={(e) => setQuickQuery(e.target.value)}
              placeholder="Search memories..."
              onKeyDown={(e) => { if (e.key === "Enter") handleQuickSearch(); }}
            />
            <button
              onClick={handleQuickSearch}
              disabled={quickSearching || !quickQuery.trim()}
              style={{
                padding: "0.35rem 0.5rem",
                backgroundColor: quickQuery.trim() && !quickSearching ? "var(--accent)" : "var(--bg-primary)",
                color: quickQuery.trim() && !quickSearching ? "white" : "var(--text-muted)",
                border: "none",
                borderRadius: 5,
                fontSize: "0.72rem",
                cursor: quickQuery.trim() && !quickSearching ? "pointer" : "default",
              }}
            >
              {quickSearching ? "..." : "Go"}
            </button>
          </div>

          {quickResults.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              {quickResults.map((r, i) => (
                <div
                  key={i}
                  style={{
                    padding: "0.4rem 0.5rem",
                    backgroundColor: "var(--bg-primary)",
                    borderRadius: 6,
                    fontSize: "0.72rem",
                    lineHeight: 1.4,
                    cursor: "pointer",
                    border: "1px solid var(--border)",
                    transition: "border-color 0.15s",
                  }}
                  onClick={() => {
                    onContextLoaded(r.content || String(r));
                  }}
                  title="Click to inject as additional context"
                >
                  <div style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    color: "var(--text-secondary)",
                  }}>
                    {r.content || String(r)}
                  </div>
                  {r.timestamp && (
                    <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: "0.2rem" }}>
                      {r.timestamp}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Section 3: Knowledge Base Selector */}
        <div style={{ marginBottom: "1rem" }}>
          <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>
            KNOWLEDGE BASES
          </h4>
          {allCorpora.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              {allCorpora.map(c => {
                const active = activeCorpusIds.has(c.id);
                return (
                  <label
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      padding: "0.35rem 0.5rem",
                      backgroundColor: active ? "rgba(99, 102, 241, 0.08)" : "var(--bg-primary)",
                      borderRadius: 5,
                      cursor: "pointer",
                      fontSize: "0.78rem",
                      border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                      transition: "all 0.15s",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => handleToggleCorpus(c.id)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.name}
                    </span>
                    {c.chunkCount !== undefined && (
                      <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
                        {c.chunkCount}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontStyle: "italic" }}>
              No knowledge bases available
            </div>
          )}
        </div>

        {/* Section 4: Memory Timeline */}
        <div>
          <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>
            MEMORY TIMELINE
          </h4>
          {timeline.length > 0 ? (
            <div style={{ position: "relative", paddingLeft: "1rem" }}>
              {/* Vertical line */}
              <div style={{
                position: "absolute",
                left: "4px",
                top: 0,
                bottom: 0,
                width: "2px",
                backgroundColor: "var(--border)",
              }} />
              {timeline.map((entry, i) => (
                <div key={i} style={{ position: "relative", marginBottom: "0.6rem" }}>
                  {/* Dot */}
                  <div style={{
                    position: "absolute",
                    left: "-0.75rem",
                    top: "4px",
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    backgroundColor: sourceColors[entry.source] || "var(--text-muted)",
                  }} />
                  <div style={{
                    fontSize: "0.72rem",
                    lineHeight: 1.4,
                    color: "var(--text-secondary)",
                  }}>
                    {entry.content}
                  </div>
                  <div style={{
                    display: "flex",
                    gap: "0.4rem",
                    alignItems: "center",
                    marginTop: "0.15rem",
                  }}>
                    <span style={{
                      fontSize: "0.62rem",
                      padding: "1px 5px",
                      borderRadius: "999px",
                      backgroundColor: sourceColors[entry.source] + "20",
                      color: sourceColors[entry.source] || "var(--text-muted)",
                      fontWeight: 500,
                    }}>
                      {entry.source}
                    </span>
                    {entry.timestamp && (
                      <span style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}>
                        {entry.timestamp}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontStyle: "italic" }}>
              No memories recalled yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
