/**
 * @file Memory Manager page with tabs for Knowledge Bases, Episodic Memory,
 * Context Composer, and Mindspaces.
 *
 * @module memory/MemoryPage
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import { createGatewayActor, type CandidMemoryResult } from "../api/gateway.did";

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract the success payload or throw. */
function unwrap(result: CandidMemoryResult): string {
  if ("Success" in result) return result.Success;
  if ("Failed" in result) throw new Error(result.Failed);
  throw new Error(("NotConfigured" in result) ? result.NotConfigured : "Unknown error");
}

/** Try to JSON-parse a string, returning the string itself on failure. */
function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Types ────────────────────────────────────────────────────────────

interface Corpus {
  id: string;
  name: string;
  description: string;
  artifactCount?: number;
  createdAt?: string;
}

interface Artifact {
  id: string;
  name: string;
  status: "pending" | "processing" | "processed" | "failed";
}

interface Mindspace {
  id: string;
  name: string;
  description: string;
  type: string;
  corpusIds: string[];
}

type Tab = "knowledge" | "episodic" | "composer" | "mindspaces";

// ── Styles ───────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  backgroundColor: "var(--bg-primary)",
  color: "var(--text-primary)",
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  gap: "0",
  borderBottom: "1px solid var(--border)",
  backgroundColor: "var(--bg-secondary)",
  padding: "0 1.5rem",
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "0.75rem 1.25rem",
  fontSize: "0.88rem",
  fontWeight: active ? 600 : 400,
  color: active ? "var(--accent)" : "var(--text-secondary)",
  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
  background: "none",
  border: "none",
  borderBottomWidth: "2px",
  borderBottomStyle: "solid",
  borderBottomColor: active ? "var(--accent)" : "transparent",
  cursor: "pointer",
  transition: "all 0.15s ease",
});

const contentStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "1.5rem",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: "var(--bg-secondary)",
  borderRadius: 10,
  border: "1px solid var(--border)",
  padding: "1.25rem",
  marginBottom: "1rem",
  borderLeft: "3px solid var(--accent)",
  transition: "box-shadow 0.15s ease",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  backgroundColor: "var(--bg-primary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.85rem",
  outline: "none",
  boxSizing: "border-box",
};

const btnStyle = (primary = true, disabled = false): React.CSSProperties => ({
  padding: "0.5rem 1.25rem",
  backgroundColor: disabled ? "var(--bg-secondary)" : primary ? "var(--accent)" : "var(--bg-primary)",
  color: disabled ? "var(--text-muted)" : primary ? "#fff" : "var(--text-primary)",
  border: primary ? "none" : "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.85rem",
  fontWeight: 500,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.5 : 1,
  transition: "all 0.15s ease",
});

const badgeStyle = (status: string): React.CSSProperties => {
  const colors: Record<string, { bg: string; fg: string }> = {
    processed: { bg: "rgba(34, 197, 94, 0.15)", fg: "#22c55e" },
    processing: { bg: "rgba(234, 179, 8, 0.15)", fg: "#eab308" },
    failed: { bg: "rgba(239, 68, 68, 0.15)", fg: "#ef4444" },
    pending: { bg: "rgba(148, 163, 184, 0.15)", fg: "#94a3b8" },
    PRIVATE: { bg: "rgba(99, 102, 241, 0.15)", fg: "#6366f1" },
    GROUP: { bg: "rgba(34, 197, 94, 0.15)", fg: "#22c55e" },
  };
  const c = colors[status] || colors.pending;
  return {
    fontSize: "0.72rem",
    padding: "2px 8px",
    borderRadius: 12,
    backgroundColor: c.bg,
    color: c.fg,
    fontWeight: 500,
    display: "inline-block",
  };
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  color: "var(--text-secondary)",
  marginBottom: "0.35rem",
  fontWeight: 500,
};

const uploadZoneStyle = (isDragOver: boolean): React.CSSProperties => ({
  border: isDragOver ? "2px solid var(--accent)" : "2px dashed var(--border)",
  borderRadius: 10,
  padding: "2rem",
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: "0.85rem",
  cursor: "pointer",
  transition: "all 0.15s ease",
  backgroundColor: isDragOver ? "rgba(99, 102, 241, 0.05)" : "transparent",
});

// ── Component ────────────────────────────────────────────────────────

export default function MemoryPage() {
  const { isAuthenticated, authClient } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("knowledge");

  // ── Knowledge Bases state ──
  const [corpora, setCorpora] = useState<Corpus[]>([]);
  const [selectedCorpus, setSelectedCorpus] = useState<Corpus | null>(null);
  const [loadingCorpora, setLoadingCorpora] = useState(false);
  const [showCreateCorpus, setShowCreateCorpus] = useState(false);
  const [newCorpusName, setNewCorpusName] = useState("");
  const [newCorpusDesc, setNewCorpusDesc] = useState("");
  const [creatingCorpus, setCreatingCorpus] = useState(false);
  const [deletingCorpusId, setDeletingCorpusId] = useState<string | null>(null);

  // Corpus detail state
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState("hybrid");
  const [rawChunksOnly, setRawChunksOnly] = useState(false);
  const [searchResults, setSearchResults] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Episodic Memory state ──
  const [pelicanQuery, setPelicanQuery] = useState("");
  const [pelicanResults, setPelicanResults] = useState<string | null>(null);
  const [searchingPelican, setSearchingPelican] = useState(false);

  // ── Context Composer state ──
  const [composerMindspaceId, setComposerMindspaceId] = useState("default");
  const [enableHistory, setEnableHistory] = useState(true);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [enableCorpus, setEnableCorpus] = useState(false);
  const [corpusQueryText, setCorpusQueryText] = useState("");
  const [enablePelican, setEnablePelican] = useState(false);
  const [pelicanQueryText, setPelicanQueryText] = useState("");
  const [composedContext, setComposedContext] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  // ── Mindspaces state ──
  const [mindspaces, setMindspaces] = useState<Mindspace[]>([]);
  const [loadingMindspaces, setLoadingMindspaces] = useState(false);
  const [showCreateMindspace, setShowCreateMindspace] = useState(false);
  const [newMsName, setNewMsName] = useState("");
  const [newMsDesc, setNewMsDesc] = useState("");
  const [newMsType, setNewMsType] = useState("PRIVATE");
  const [newMsCorpusIds, setNewMsCorpusIds] = useState<string[]>([]);
  const [creatingMindspace, setCreatingMindspace] = useState(false);

  // ── Status message ──
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // ── Gateway helper ──
  const getGateway = useCallback(async () => {
    const agent = await createAgent(authClient ?? undefined);
    return createGatewayActor(agent);
  }, [authClient]);

  // ── Load corpora ──
  const loadCorpora = useCallback(async () => {
    setLoadingCorpora(true);
    try {
      const gw = await getGateway();
      const result = await gw.listCorpora();
      const data = tryParse(unwrap(result));
      if (Array.isArray(data)) {
        setCorpora(data as Corpus[]);
      } else {
        setCorpora([]);
      }
    } catch (e) {
      setMessage({ text: `Failed to load corpora: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setLoadingCorpora(false);
    }
  }, [getGateway]);

  // ── Load mindspaces ──
  const loadMindspaces = useCallback(async () => {
    setLoadingMindspaces(true);
    try {
      const gw = await getGateway();
      const result = await gw.listMindspaces();
      const data = tryParse(unwrap(result));
      if (Array.isArray(data)) {
        setMindspaces(data as Mindspace[]);
      } else {
        setMindspaces([]);
      }
    } catch (e) {
      setMessage({ text: `Failed to load mindspaces: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setLoadingMindspaces(false);
    }
  }, [getGateway]);

  // ── On tab change, load relevant data ──
  useEffect(() => {
    if (!isAuthenticated) return;
    if (activeTab === "knowledge") loadCorpora();
    if (activeTab === "mindspaces" || activeTab === "composer") {
      loadMindspaces();
      if (activeTab === "composer") loadCorpora();
    }
  }, [activeTab, isAuthenticated, loadCorpora, loadMindspaces]);

  // ── Cleanup poll timer ──
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // ── Create corpus ──
  const handleCreateCorpus = useCallback(async () => {
    if (!newCorpusName.trim()) return;
    setCreatingCorpus(true);
    try {
      const gw = await getGateway();
      const result = await gw.createCorpus(newCorpusName.trim(), newCorpusDesc.trim());
      unwrap(result);
      setNewCorpusName("");
      setNewCorpusDesc("");
      setShowCreateCorpus(false);
      setMessage({ text: "Knowledge base created", type: "success" });
      loadCorpora();
    } catch (e) {
      setMessage({ text: `Failed: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setCreatingCorpus(false);
    }
  }, [newCorpusName, newCorpusDesc, getGateway, loadCorpora]);

  // ── Delete corpus ──
  const handleDeleteCorpus = useCallback(async (corpusId: string) => {
    if (!window.confirm("Delete this knowledge base? This cannot be undone.")) return;
    setDeletingCorpusId(corpusId);
    try {
      const gw = await getGateway();
      const result = await gw.deleteCorpus(corpusId);
      unwrap(result);
      if (selectedCorpus?.id === corpusId) setSelectedCorpus(null);
      setMessage({ text: "Knowledge base deleted", type: "success" });
      loadCorpora();
    } catch (e) {
      setMessage({ text: `Failed: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setDeletingCorpusId(null);
    }
  }, [getGateway, loadCorpora, selectedCorpus]);

  // ── Upload file ──
  const handleFileUpload = useCallback(async (file: File) => {
    if (!selectedCorpus) return;
    setUploading(true);
    setUploadProgress("Getting upload URL...");
    try {
      const gw = await getGateway();

      // 1. Get presigned URL
      const presignResult = await gw.presignUpload(
        file.name,
        file.type || "application/octet-stream",
        BigInt(file.size),
        [selectedCorpus.id],
      );
      const presignData = tryParse(unwrap(presignResult)) as { uploadUrl: string; artifactId: string };

      // 2. Upload to S3
      setUploadProgress("Uploading file...");
      await fetch(presignData.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });

      // 3. Trigger ingestion
      setUploadProgress("Triggering ingestion...");
      const addResult = await gw.addArtifactToCorpus(selectedCorpus.id, presignData.artifactId);
      unwrap(addResult);

      // 4. Add to artifacts list and poll
      const newArtifact: Artifact = { id: presignData.artifactId, name: file.name, status: "processing" };
      setArtifacts(prev => [...prev, newArtifact]);
      setUploadProgress("Processing...");

      // Poll for status
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(async () => {
        try {
          const statusResult = await gw.getIngestionStatus(selectedCorpus.id, presignData.artifactId);
          const statusData = tryParse(unwrap(statusResult)) as { status: string };
          const status = (statusData.status || "processing").toLowerCase() as Artifact["status"];
          setArtifacts(prev =>
            prev.map(a => a.id === presignData.artifactId ? { ...a, status } : a)
          );
          if (status === "processed" || status === "failed") {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setUploadProgress("");
            setUploading(false);
            setMessage({ text: status === "processed" ? "File processed successfully" : "File processing failed", type: status === "processed" ? "success" : "error" });
          }
        } catch {
          // Continue polling
        }
      }, 3000);
    } catch (e) {
      setMessage({ text: `Upload failed: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
      setUploading(false);
      setUploadProgress("");
    }
  }, [selectedCorpus, getGateway]);

  // ── Search corpus ──
  const handleSearchCorpus = useCallback(async () => {
    if (!selectedCorpus || !searchQuery.trim()) return;
    setSearching(true);
    setSearchResults(null);
    try {
      const gw = await getGateway();
      const result = await gw.queryCorpus(selectedCorpus.id, searchQuery.trim(), searchMode, rawChunksOnly);
      setSearchResults(unwrap(result));
    } catch (e) {
      setMessage({ text: `Search failed: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setSearching(false);
    }
  }, [selectedCorpus, searchQuery, searchMode, rawChunksOnly, getGateway]);

  // ── Search episodic memory ──
  const handleSearchPelican = useCallback(async () => {
    if (!pelicanQuery.trim()) return;
    setSearchingPelican(true);
    setPelicanResults(null);
    try {
      const gw = await getGateway();
      const result = await gw.prepareContext("default", BigInt(0), [], [pelicanQuery.trim()]);
      setPelicanResults(unwrap(result));
    } catch (e) {
      setMessage({ text: `Search failed: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setSearchingPelican(false);
    }
  }, [pelicanQuery, getGateway]);

  // ── Compose context ──
  const handleCompose = useCallback(async () => {
    setComposing(true);
    setComposedContext(null);
    try {
      const gw = await getGateway();
      const result = await gw.prepareContext(
        composerMindspaceId,
        BigInt(enableHistory ? historyLimit : 0),
        enableCorpus && corpusQueryText.trim() ? [corpusQueryText.trim()] : [],
        enablePelican && pelicanQueryText.trim() ? [pelicanQueryText.trim()] : [],
      );
      setComposedContext(unwrap(result));
    } catch (e) {
      setMessage({ text: `Failed: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setComposing(false);
    }
  }, [composerMindspaceId, enableHistory, historyLimit, enableCorpus, corpusQueryText, enablePelican, pelicanQueryText, getGateway]);

  // ── Create mindspace ──
  const handleCreateMindspace = useCallback(async () => {
    if (!newMsName.trim()) return;
    setCreatingMindspace(true);
    try {
      const gw = await getGateway();
      const result = await gw.createMindspace(newMsName.trim(), newMsDesc.trim(), newMsCorpusIds, newMsType);
      unwrap(result);
      setNewMsName("");
      setNewMsDesc("");
      setNewMsCorpusIds([]);
      setShowCreateMindspace(false);
      setMessage({ text: "Mindspace created", type: "success" });
      loadMindspaces();
    } catch (e) {
      setMessage({ text: `Failed: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setCreatingMindspace(false);
    }
  }, [newMsName, newMsDesc, newMsType, newMsCorpusIds, getGateway, loadMindspaces]);

  // ── Drop handler ──
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }, [handleFileUpload]);

  if (!isAuthenticated) {
    return (
      <div style={pageStyle}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
          Please log in to access Memory Manager.
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div style={pageStyle}>
      {/* Tab bar */}
      <div style={tabBarStyle}>
        <button style={tabStyle(activeTab === "knowledge")} onClick={() => setActiveTab("knowledge")}>
          Knowledge Bases
        </button>
        <button style={tabStyle(activeTab === "episodic")} onClick={() => setActiveTab("episodic")}>
          Episodic Memory
        </button>
        <button style={tabStyle(activeTab === "composer")} onClick={() => setActiveTab("composer")}>
          Context Composer
        </button>
        <button style={tabStyle(activeTab === "mindspaces")} onClick={() => setActiveTab("mindspaces")}>
          Mindspaces
        </button>
      </div>

      {/* Status message */}
      {message && (
        <div style={{
          padding: "0.5rem 1.5rem",
          backgroundColor: message.type === "success" ? "rgba(34, 197, 94, 0.1)" : "rgba(239, 68, 68, 0.1)",
          color: message.type === "success" ? "#22c55e" : "#ef4444",
          fontSize: "0.82rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <span>{message.text}</span>
          <button
            onClick={() => setMessage(null)}
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: "1rem" }}
          >
            x
          </button>
        </div>
      )}

      <div style={contentStyle}>
        {/* ────── Tab 1: Knowledge Bases ────── */}
        {activeTab === "knowledge" && (
          <div>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600 }}>Knowledge Bases</h2>
                <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                  Manage your knowledge bases with RAG semantic search.
                </p>
              </div>
              <button
                style={btnStyle(true)}
                onClick={() => setShowCreateCorpus(!showCreateCorpus)}
              >
                {showCreateCorpus ? "Cancel" : "+ Create Knowledge Base"}
              </button>
            </div>

            {/* Create form */}
            {showCreateCorpus && (
              <div style={{ ...cardStyle, marginBottom: "1.25rem" }}>
                <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.95rem" }}>New Knowledge Base</h3>
                <div style={{ marginBottom: "0.75rem" }}>
                  <label style={labelStyle}>Name</label>
                  <input
                    style={inputStyle}
                    value={newCorpusName}
                    onChange={(e) => setNewCorpusName(e.target.value)}
                    placeholder="e.g., Research Papers"
                  />
                </div>
                <div style={{ marginBottom: "0.75rem" }}>
                  <label style={labelStyle}>Description</label>
                  <input
                    style={inputStyle}
                    value={newCorpusDesc}
                    onChange={(e) => setNewCorpusDesc(e.target.value)}
                    placeholder="What kind of knowledge does this contain?"
                  />
                </div>
                <button
                  style={btnStyle(true, creatingCorpus || !newCorpusName.trim())}
                  onClick={handleCreateCorpus}
                  disabled={creatingCorpus || !newCorpusName.trim()}
                >
                  {creatingCorpus ? "Creating..." : "Create"}
                </button>
              </div>
            )}

            {/* Corpus list / detail */}
            {selectedCorpus ? (
              <div>
                {/* Back button + name */}
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
                  <button
                    style={btnStyle(false)}
                    onClick={() => { setSelectedCorpus(null); setArtifacts([]); setSearchResults(null); }}
                  >
                    Back
                  </button>
                  <h3 style={{ margin: 0, fontSize: "1.05rem" }}>{selectedCorpus.name}</h3>
                </div>
                {selectedCorpus.description && (
                  <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "1rem" }}>
                    {selectedCorpus.description}
                  </p>
                )}

                {/* Artifacts section */}
                <div style={{ ...cardStyle, marginBottom: "1.25rem" }}>
                  <h4 style={{ margin: "0 0 0.75rem", fontSize: "0.95rem" }}>Artifacts</h4>

                  {artifacts.length > 0 && (
                    <div style={{ marginBottom: "1rem" }}>
                      {artifacts.map(a => (
                        <div key={a.id} style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "0.5rem 0.75rem",
                          backgroundColor: "var(--bg-primary)",
                          borderRadius: 6,
                          marginBottom: "0.35rem",
                          fontSize: "0.85rem",
                        }}>
                          <span>{a.name}</span>
                          <span style={badgeStyle(a.status)}>
                            {a.status === "processing" && (
                              <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>
                                {a.status}
                              </span>
                            )}
                            {a.status !== "processing" && a.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Upload zone */}
                  <div
                    style={uploadZoneStyle(isDragOver)}
                    onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFileUpload(f);
                        e.target.value = "";
                      }}
                    />
                    {uploading ? (
                      <div>
                        <div style={{
                          height: 4,
                          backgroundColor: "var(--border)",
                          borderRadius: 2,
                          marginBottom: "0.5rem",
                          overflow: "hidden",
                        }}>
                          <div style={{
                            height: "100%",
                            width: "60%",
                            backgroundColor: "var(--accent)",
                            borderRadius: 2,
                            animation: "pulse 1.5s ease-in-out infinite",
                          }} />
                        </div>
                        <span>{uploadProgress}</span>
                      </div>
                    ) : (
                      <div>
                        <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>+</div>
                        <div>Drop a file here or click to upload</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Search section */}
                <div style={cardStyle}>
                  <h4 style={{ margin: "0 0 0.75rem", fontSize: "0.95rem" }}>Search Knowledge Base</h4>
                  <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
                    <input
                      style={{ ...inputStyle, flex: 1 }}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Enter your search query..."
                      onKeyDown={(e) => { if (e.key === "Enter") handleSearchCorpus(); }}
                    />
                    <select
                      style={{ ...inputStyle, width: "auto", minWidth: "120px" }}
                      value={searchMode}
                      onChange={(e) => setSearchMode(e.target.value)}
                    >
                      <option value="naive">Naive</option>
                      <option value="local">Local</option>
                      <option value="global">Global</option>
                      <option value="hybrid">Hybrid</option>
                    </select>
                    <button
                      style={btnStyle(true, searching || !searchQuery.trim())}
                      onClick={handleSearchCorpus}
                      disabled={searching || !searchQuery.trim()}
                    >
                      {searching ? "..." : "Search"}
                    </button>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", color: "var(--text-secondary)", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={rawChunksOnly}
                      onChange={(e) => setRawChunksOnly(e.target.checked)}
                    />
                    Raw chunks only
                  </label>

                  {searchResults && (
                    <div style={{
                      marginTop: "1rem",
                      padding: "1rem",
                      backgroundColor: "var(--bg-primary)",
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      fontSize: "0.85rem",
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      maxHeight: "400px",
                      overflow: "auto",
                    }}>
                      {searchResults}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* Corpus grid */
              <div>
                {loadingCorpora && corpora.length === 0 && (
                  <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Loading knowledge bases...</p>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "1rem" }}>
                  {corpora.map(c => (
                    <div
                      key={c.id}
                      style={{
                        ...cardStyle,
                        cursor: "pointer",
                        marginBottom: 0,
                      }}
                      onClick={() => setSelectedCorpus(c)}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = "none"; }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
                        <h4 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>{c.name}</h4>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteCorpus(c.id); }}
                          disabled={deletingCorpusId === c.id}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            fontSize: "0.85rem",
                            padding: "0 4px",
                            opacity: deletingCorpusId === c.id ? 0.3 : 0.6,
                          }}
                          title="Delete"
                        >
                          x
                        </button>
                      </div>
                      {c.description && (
                        <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
                          {c.description}
                        </p>
                      )}
                      <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.72rem", color: "var(--text-muted)" }}>
                        {c.artifactCount !== undefined && <span>{c.artifactCount} artifacts</span>}
                        {c.createdAt && <span>{c.createdAt}</span>}
                      </div>
                    </div>
                  ))}
                </div>

                {!loadingCorpora && corpora.length === 0 && (
                  <div style={{ textAlign: "center", padding: "3rem 0", color: "var(--text-muted)" }}>
                    <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>No knowledge bases yet</div>
                    <p style={{ fontSize: "0.85rem" }}>Create your first knowledge base to start uploading documents.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ────── Tab 2: Episodic Memory ────── */}
        {activeTab === "episodic" && (
          <div>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.2rem", fontWeight: 600 }}>Episodic Memory</h2>
            <p style={{ margin: "0 0 1.25rem", fontSize: "0.82rem", color: "var(--text-secondary)" }}>
              Searches across all your past conversations for relevant memories.
            </p>

            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem", maxWidth: "700px" }}>
              <input
                style={{ ...inputStyle, flex: 1, padding: "0.75rem 1rem", fontSize: "0.95rem" }}
                value={pelicanQuery}
                onChange={(e) => setPelicanQuery(e.target.value)}
                placeholder="What do you want to remember?"
                onKeyDown={(e) => { if (e.key === "Enter") handleSearchPelican(); }}
              />
              <button
                style={btnStyle(true, searchingPelican || !pelicanQuery.trim())}
                onClick={handleSearchPelican}
                disabled={searchingPelican || !pelicanQuery.trim()}
              >
                {searchingPelican ? "Searching..." : "Search Memory"}
              </button>
            </div>

            {pelicanResults && (
              <div>
                <h3 style={{ fontSize: "0.95rem", fontWeight: 600, marginBottom: "0.75rem" }}>Results</h3>
                {(() => {
                  const parsed = tryParse(pelicanResults);
                  if (Array.isArray(parsed)) {
                    return parsed.map((item: { content?: string; timestamp?: string; source?: string }, i: number) => (
                      <div key={i} style={{
                        ...cardStyle,
                        borderLeftColor: "var(--accent)",
                      }}>
                        {item.timestamp && (
                          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "0.35rem" }}>
                            {item.timestamp}
                          </div>
                        )}
                        <div style={{ fontSize: "0.85rem", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                          {item.content || String(item)}
                        </div>
                        {item.source && (
                          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
                            Source: {item.source}
                          </div>
                        )}
                      </div>
                    ));
                  }
                  return (
                    <div style={{
                      padding: "1rem",
                      backgroundColor: "var(--bg-secondary)",
                      borderRadius: 10,
                      border: "1px solid var(--border)",
                      fontSize: "0.85rem",
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                    }}>
                      {pelicanResults}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* ────── Tab 3: Context Composer ────── */}
        {activeTab === "composer" && (
          <div>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.2rem", fontWeight: 600 }}>Context Composer</h2>
            <p style={{ margin: "0 0 1.25rem", fontSize: "0.82rem", color: "var(--text-secondary)" }}>
              Compose chat history, knowledge base chunks, and episodic memories into unified context.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
              {/* Left: controls */}
              <div>
                {/* Mindspace selector */}
                <div style={{ marginBottom: "1rem" }}>
                  <label style={labelStyle}>Mindspace</label>
                  <select
                    style={inputStyle}
                    value={composerMindspaceId}
                    onChange={(e) => setComposerMindspaceId(e.target.value)}
                  >
                    <option value="default">default</option>
                    {mindspaces.map(ms => (
                      <option key={ms.id} value={ms.id}>{ms.name} ({ms.id})</option>
                    ))}
                  </select>
                </div>

                {/* Chat History toggle */}
                <div style={{ ...cardStyle, opacity: enableHistory ? 1 : 0.5 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", marginBottom: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={enableHistory}
                      onChange={(e) => setEnableHistory(e.target.checked)}
                    />
                    <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Chat History</span>
                  </label>
                  {enableHistory && (
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        <span>Messages: {historyLimit}</span>
                        <span>1 - 50</span>
                      </div>
                      <input
                        type="range"
                        min={1}
                        max={50}
                        value={historyLimit}
                        onChange={(e) => setHistoryLimit(parseInt(e.target.value, 10))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                    </div>
                  )}
                </div>

                {/* Knowledge Base toggle */}
                <div style={{ ...cardStyle, opacity: enableCorpus ? 1 : 0.5 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", marginBottom: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={enableCorpus}
                      onChange={(e) => setEnableCorpus(e.target.checked)}
                    />
                    <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Knowledge Base</span>
                  </label>
                  {enableCorpus && (
                    <input
                      style={inputStyle}
                      value={corpusQueryText}
                      onChange={(e) => setCorpusQueryText(e.target.value)}
                      placeholder="Query to search knowledge base..."
                    />
                  )}
                </div>

                {/* Episodic Memory toggle */}
                <div style={{ ...cardStyle, opacity: enablePelican ? 1 : 0.5 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", marginBottom: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={enablePelican}
                      onChange={(e) => setEnablePelican(e.target.checked)}
                    />
                    <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Episodic Memory</span>
                  </label>
                  {enablePelican && (
                    <input
                      style={inputStyle}
                      value={pelicanQueryText}
                      onChange={(e) => setPelicanQueryText(e.target.value)}
                      placeholder="Query to search episodic memory..."
                    />
                  )}
                </div>

                <button
                  style={{ ...btnStyle(true, composing), marginTop: "0.5rem", width: "100%" }}
                  onClick={handleCompose}
                  disabled={composing}
                >
                  {composing ? "Composing..." : "Compose Context"}
                </button>
              </div>

              {/* Right: result */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                  <h3 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>Composed Context</h3>
                  {composedContext && (
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontFamily: "monospace" }}>
                      ~{estimateTokens(composedContext).toLocaleString()} tokens
                    </span>
                  )}
                </div>

                {composedContext ? (
                  <div>
                    <div style={{
                      padding: "1rem",
                      backgroundColor: "var(--bg-secondary)",
                      borderRadius: 10,
                      border: "1px solid var(--border)",
                      fontSize: "0.82rem",
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      maxHeight: "500px",
                      overflow: "auto",
                      marginBottom: "0.75rem",
                    }}>
                      {composedContext}
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        style={btnStyle(false)}
                        onClick={() => {
                          navigator.clipboard.writeText(composedContext);
                          setMessage({ text: "Copied to clipboard", type: "success" });
                        }}
                      >
                        Copy to Clipboard
                      </button>
                      <button
                        style={btnStyle(true)}
                        onClick={() => {
                          navigator.clipboard.writeText(composedContext);
                          setMessage({ text: "Context copied - paste it as system prompt in Chat", type: "success" });
                        }}
                      >
                        Inject into Chat
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{
                    padding: "3rem",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: "0.85rem",
                    backgroundColor: "var(--bg-secondary)",
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                  }}>
                    Configure sources on the left and click "Compose Context" to see the result.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ────── Tab 4: Mindspaces ────── */}
        {activeTab === "mindspaces" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600 }}>Mindspaces</h2>
                <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                  Conversation containers that link corpus, participants, and history.
                </p>
              </div>
              <button
                style={btnStyle(true)}
                onClick={() => setShowCreateMindspace(!showCreateMindspace)}
              >
                {showCreateMindspace ? "Cancel" : "+ Create Mindspace"}
              </button>
            </div>

            {/* Create form */}
            {showCreateMindspace && (
              <div style={{ ...cardStyle, marginBottom: "1.25rem" }}>
                <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.95rem" }}>New Mindspace</h3>
                <div style={{ marginBottom: "0.75rem" }}>
                  <label style={labelStyle}>Name</label>
                  <input
                    style={inputStyle}
                    value={newMsName}
                    onChange={(e) => setNewMsName(e.target.value)}
                    placeholder="e.g., Work Research"
                  />
                </div>
                <div style={{ marginBottom: "0.75rem" }}>
                  <label style={labelStyle}>Description</label>
                  <input
                    style={inputStyle}
                    value={newMsDesc}
                    onChange={(e) => setNewMsDesc(e.target.value)}
                    placeholder="Purpose of this mindspace"
                  />
                </div>
                <div style={{ marginBottom: "0.75rem" }}>
                  <label style={labelStyle}>Type</label>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      style={{
                        ...btnStyle(newMsType === "PRIVATE"),
                        flex: 1,
                      }}
                      onClick={() => setNewMsType("PRIVATE")}
                    >
                      Private
                    </button>
                    <button
                      style={{
                        ...btnStyle(newMsType === "GROUP"),
                        flex: 1,
                      }}
                      onClick={() => setNewMsType("GROUP")}
                    >
                      Group
                    </button>
                  </div>
                </div>
                <div style={{ marginBottom: "0.75rem" }}>
                  <label style={labelStyle}>Linked Knowledge Bases</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                    {corpora.map(c => {
                      const selected = newMsCorpusIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          onClick={() => setNewMsCorpusIds(prev =>
                            selected ? prev.filter(id => id !== c.id) : [...prev, c.id]
                          )}
                          style={{
                            padding: "0.25rem 0.6rem",
                            borderRadius: "999px",
                            fontSize: "0.78rem",
                            border: selected ? "1px solid var(--accent)" : "1px dashed var(--border)",
                            backgroundColor: selected ? "var(--accent)" : "transparent",
                            color: selected ? "white" : "var(--text-secondary)",
                            cursor: "pointer",
                            transition: "all 0.15s",
                          }}
                        >
                          {c.name}
                        </button>
                      );
                    })}
                    {corpora.length === 0 && (
                      <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                        No knowledge bases available
                      </span>
                    )}
                  </div>
                </div>
                <button
                  style={btnStyle(true, creatingMindspace || !newMsName.trim())}
                  onClick={handleCreateMindspace}
                  disabled={creatingMindspace || !newMsName.trim()}
                >
                  {creatingMindspace ? "Creating..." : "Create Mindspace"}
                </button>
              </div>
            )}

            {/* Mindspace list */}
            {loadingMindspaces && mindspaces.length === 0 && (
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Loading mindspaces...</p>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "1rem" }}>
              {mindspaces.map(ms => (
                <div key={ms.id} style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
                    <h4 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>{ms.name}</h4>
                    <span style={badgeStyle(ms.type || "PRIVATE")}>{ms.type || "PRIVATE"}</span>
                  </div>
                  {ms.description && (
                    <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
                      {ms.description}
                    </p>
                  )}
                  {ms.corpusIds && ms.corpusIds.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                      {ms.corpusIds.map(cid => (
                        <span key={cid} style={{
                          fontSize: "0.7rem",
                          padding: "2px 6px",
                          borderRadius: "999px",
                          backgroundColor: "var(--bg-primary)",
                          color: "var(--accent)",
                          border: "1px solid var(--border)",
                        }}>
                          {corpora.find(c => c.id === cid)?.name || cid}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {!loadingMindspaces && mindspaces.length === 0 && (
              <div style={{ textAlign: "center", padding: "3rem 0", color: "var(--text-muted)" }}>
                <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>No mindspaces yet</div>
                <p style={{ fontSize: "0.85rem" }}>Create a mindspace to organize your conversations and knowledge.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pulse animation for processing status */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
