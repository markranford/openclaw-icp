import { ReactNode, useState, useMemo, useCallback, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./auth/useAuth";
import { useConversations, type ConversationSummary } from "./chat/ConversationContext";
import { createAgent } from "./api/agent";
import { createGatewayActor, type CandidConversationSummary } from "./api/gateway.did";

interface LayoutProps {
  children: ReactNode;
}

/** Format a nanosecond timestamp into a relative time string. */
function relativeTime(updatedAt: bigint): string {
  // Candid Int timestamps from ICP are in nanoseconds
  const ms = Number(updatedAt) / 1_000_000;
  const now = Date.now();
  const diffSec = Math.floor((now - ms) / 1000);

  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Get a short model label from a CandidModel variant. */
function modelLabel(model: Record<string, unknown>): string {
  if ("OnChain" in model) {
    const inner = model.OnChain as Record<string, null>;
    return Object.keys(inner)[0] ?? "On-chain";
  }
  if ("External" in model) {
    const inner = model.External as Record<string, null>;
    return Object.keys(inner)[0] ?? "External";
  }
  return "Unknown";
}

export default function Layout({ children }: LayoutProps) {
  const { principal, logout, authClient } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    conversations,
    isLoadingConversations,
    conversationError,
    refreshConversations,
  } = useConversations();

  // Search state
  const [searchText, setSearchText] = useState("");
  const [deepSearchResults, setDeepSearchResults] = useState<ConversationSummary[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Client-side filter by title/preview
  const filteredConversations = useMemo(() => {
    if (!searchText.trim()) return conversations;
    const lower = searchText.toLowerCase();
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(lower) ||
        c.preview.toLowerCase().includes(lower)
    );
  }, [conversations, searchText]);

  // Deep search via backend when 3+ characters
  const triggerDeepSearch = useCallback(
    async (query: string) => {
      if (query.length < 3) {
        setDeepSearchResults(null);
        return;
      }
      setIsSearching(true);
      try {
        const agent = await createAgent(authClient ?? undefined);
        const gateway = createGatewayActor(agent);
        const result = await gateway.searchConversations(query);
        if ("ok" in result) {
          setDeepSearchResults(
            (result.ok as unknown as ConversationSummary[]).sort(
              (a, b) => Number(b.updatedAt) - Number(a.updatedAt)
            )
          );
        }
      } catch {
        // Silently fall back to client-side only
      } finally {
        setIsSearching(false);
      }
    },
    [authClient]
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchText(value);
      setDeepSearchResults(null);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      if (value.length >= 3) {
        searchTimeoutRef.current = setTimeout(() => triggerDeepSearch(value), 400);
      }
    },
    [triggerDeepSearch]
  );

  // Use deep search results when available, otherwise client-side filtered
  const displayConversations = deepSearchResults ?? filteredConversations;

  const navItems = [
    { path: "/", label: "Chat", icon: "💬" },
    { path: "/wallet", label: "Wallet", icon: "💰" },
    { path: "/identity", label: "Identity", icon: "🪪" },
    { path: "/personas", label: "Personas", icon: "🎭" },
    { path: "/group-chat", label: "Group Chat", icon: "👥" },
    { path: "/memory", label: "Memory", icon: "\uD83E\uDDE0" },
    { path: "/comms", label: "Comms", icon: "📧" },
    { path: "/settings", label: "Settings", icon: "⚙️" },
  ];

  const isChatActive =
    location.pathname === "/" || location.pathname.startsWith("/chat/");

  // Extract active conversation ID from URL
  const activeConversationId = location.pathname.startsWith("/chat/")
    ? decodeURIComponent(location.pathname.replace("/chat/", ""))
    : null;

  return (
    <div style={{ display: "flex", width: "100%", minHeight: "100vh" }}>
      {/* Sidebar */}
      <aside
        style={{
          width: "var(--sidebar-width)",
          backgroundColor: "var(--bg-secondary)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          padding: "1rem",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {/* Logo */}
        <div
          style={{
            fontSize: "1.4rem",
            fontWeight: 700,
            marginBottom: "2rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span style={{ fontSize: "1.6rem" }}>🦀</span>
          <span>OpenClaw</span>
          <span
            style={{
              fontSize: "0.65rem",
              backgroundColor: "var(--accent)",
              color: "white",
              padding: "2px 6px",
              borderRadius: "4px",
              fontWeight: 500,
            }}
          >
            ICP
          </span>
        </div>

        {/* New Chat Button */}
        <Link
          to="/"
          style={{
            display: "block",
            padding: "0.75rem 1rem",
            backgroundColor: "var(--accent)",
            color: "white",
            borderRadius: "8px",
            textAlign: "center",
            fontWeight: 600,
            marginBottom: "1.5rem",
            transition: "background-color 0.2s",
          }}
        >
          + New Chat
        </Link>

        {/* Navigation */}
        <nav style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {navItems.map((item) => {
            const isChat = item.path === "/";
            const isGroupChat = item.path === "/group-chat";
            const isActive = isChat
              ? isChatActive
              : isGroupChat
              ? location.pathname === "/group-chat" || location.pathname.startsWith("/group-chat/")
              : location.pathname === item.path;

            return (
              <div key={item.path}>
                <Link
                  to={item.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    padding: "0.65rem 0.75rem",
                    borderRadius: "6px",
                    color: isActive
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                    backgroundColor: isActive
                      ? "var(--bg-tertiary)"
                      : "transparent",
                    marginBottom: "0.25rem",
                    transition: "all 0.15s",
                    fontSize: "0.95rem",
                  }}
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </Link>

                {/* Conversation list under the Chat nav item */}
                {isChat && isChatActive && (
                  <div
                    style={{
                      marginLeft: "0.5rem",
                      marginBottom: "0.5rem",
                      maxHeight: "calc(100vh - 400px)",
                      overflowY: "auto",
                      overflowX: "hidden",
                    }}
                  >
                    {/* Search input */}
                    <div style={{ padding: "0.25rem 0.25rem 0.5rem 0.25rem" }}>
                      <input
                        type="text"
                        placeholder="Search conversations..."
                        value={searchText}
                        onChange={(e) => handleSearchChange(e.target.value)}
                        style={{
                          width: "100%",
                          padding: "0.35rem 0.5rem",
                          fontSize: "0.78rem",
                          border: "1px solid var(--border)",
                          borderRadius: "5px",
                          backgroundColor: "var(--bg-primary)",
                          color: "var(--text-primary)",
                          outline: "none",
                          boxSizing: "border-box",
                        }}
                      />
                      {isSearching && (
                        <div
                          style={{
                            fontSize: "0.7rem",
                            color: "var(--text-muted)",
                            padding: "0.2rem 0",
                          }}
                        >
                          Searching...
                        </div>
                      )}
                    </div>

                    {isLoadingConversations && conversations.length === 0 && (
                      <div
                        style={{
                          padding: "0.5rem 0.75rem",
                          fontSize: "0.8rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        Loading...
                      </div>
                    )}

                    {conversationError && (
                      <div
                        style={{
                          padding: "0.5rem 0.75rem",
                          fontSize: "0.78rem",
                          color: "var(--error)",
                        }}
                      >
                        <div>{conversationError}</div>
                        <button
                          onClick={() => refreshConversations()}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--accent)",
                            fontSize: "0.78rem",
                            padding: "0.2rem 0",
                            cursor: "pointer",
                          }}
                        >
                          Retry
                        </button>
                      </div>
                    )}

                    {!conversationError &&
                      displayConversations.map((conv) => {
                        const isConvActive = activeConversationId === conv.id;
                        return (
                          <button
                            key={conv.id}
                            onClick={() => navigate(`/chat/${encodeURIComponent(conv.id)}`)}
                            style={{
                              display: "block",
                              width: "100%",
                              textAlign: "left",
                              background: isConvActive
                                ? "var(--bg-tertiary)"
                                : "transparent",
                              border: "none",
                              borderRadius: "5px",
                              padding: "0.45rem 0.65rem",
                              marginBottom: "2px",
                              cursor: "pointer",
                              transition: "background-color 0.15s",
                              color: isConvActive
                                ? "var(--text-primary)"
                                : "var(--text-secondary)",
                            }}
                            onMouseEnter={(e) => {
                              if (!isConvActive) {
                                (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                                  "var(--bg-tertiary)";
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isConvActive) {
                                (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                                  "transparent";
                              }
                            }}
                          >
                            {/* Title: first user message */}
                            <div
                              style={{
                                fontSize: "0.82rem",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                lineHeight: 1.3,
                                fontWeight: 500,
                              }}
                            >
                              {conv.title || modelLabel(conv.model as unknown as Record<string, unknown>)}
                            </div>
                            {/* Preview: last assistant message */}
                            {conv.preview && (
                              <div
                                style={{
                                  fontSize: "0.72rem",
                                  color: "var(--text-muted)",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  lineHeight: 1.3,
                                  marginTop: "1px",
                                }}
                              >
                                {conv.preview}
                              </div>
                            )}
                            <div
                              style={{
                                fontSize: "0.68rem",
                                color: "var(--text-muted)",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "0.4rem",
                                marginTop: "2px",
                              }}
                            >
                              <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                                <span
                                  style={{
                                    backgroundColor: "var(--bg-primary)",
                                    padding: "1px 4px",
                                    borderRadius: "3px",
                                    fontSize: "0.65rem",
                                  }}
                                >
                                  {modelLabel(conv.model as unknown as Record<string, unknown>)}
                                </span>
                                {conv.mindspaceId && conv.mindspaceId !== "default" && (
                                  <span
                                    style={{
                                      backgroundColor: "var(--bg-primary)",
                                      padding: "1px 4px",
                                      borderRadius: "3px",
                                      fontSize: "0.6rem",
                                      color: "var(--accent)",
                                      maxWidth: "60px",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                    title={`Mindspace: ${conv.mindspaceId}`}
                                  >
                                    🧠{conv.mindspaceId}
                                  </span>
                                )}
                              </span>
                              <span>{relativeTime(conv.updatedAt)}</span>
                            </div>
                          </button>
                        );
                      })}

                    {!conversationError &&
                      !isLoadingConversations &&
                      displayConversations.length === 0 && (
                        <div
                          style={{
                            padding: "0.5rem 0.75rem",
                            fontSize: "0.8rem",
                            color: "var(--text-muted)",
                          }}
                        >
                          {searchText ? "No matching conversations" : "No conversations yet"}
                        </div>
                      )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* User info */}
        <div
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: "1rem",
            fontSize: "0.8rem",
            color: "var(--text-muted)",
          }}
        >
          <div style={{ marginBottom: "0.5rem", wordBreak: "break-all" }}>
            {principal ? `${principal.slice(0, 12)}...${principal.slice(-5)}` : ""}
          </div>
          <button
            onClick={logout}
            style={{
              background: "none",
              border: "1px solid var(--border)",
              color: "var(--text-secondary)",
              padding: "0.4rem 0.75rem",
              borderRadius: "6px",
              fontSize: "0.8rem",
              width: "100%",
            }}
          >
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {children}
      </main>
    </div>
  );
}
