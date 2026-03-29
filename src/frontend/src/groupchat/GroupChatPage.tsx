/**
 * @file Group chat page allowing multiple personas and invited humans in a single conversation.
 *
 * Features:
 * - Create/configure group chats with 2-5 personas
 * - Three turn order modes: Round Robin, Facilitator, Free Form
 * - Multi-persona message display with distinct visual identity
 * - @mention support to target a specific persona
 * - Invite human users by Principal ID
 * - Sidebar with existing group chat list
 *
 * @module groupchat/GroupChatPage
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import {
  createGatewayActor,
  type CandidGroupChat,
  type CandidGroupMessage,
  type CandidTurnOrder,
  type CandidPersona,
} from "../api/gateway.did";
import { Principal } from "@icp-sdk/core/principal";

/** Persona border color palette for group chat messages. */
const PERSONA_COLORS = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6"];

/** UI-level message for the group chat message list. */
interface GroupChatMessage {
  role: "user" | "assistant";
  content: string;
  personaId?: string;
  personaName?: string;
  personaAvatar?: string;
  targetPersonaId?: string;
  senderPrincipal?: string;
}

/** Extract error string from Candid error variant. */
function formatError(err: Record<string, unknown>): string {
  const key = Object.keys(err)[0];
  const val = err[key];
  if (typeof val === "string") return `${key}: ${val}`;
  return key;
}

export default function GroupChatPage() {
  const { id: urlGroupId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { authClient } = useAuth();

  // Group chat list
  const [groupChats, setGroupChats] = useState<CandidGroupChat[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(true);

  // Active group chat state
  const [activeGroup, setActiveGroup] = useState<CandidGroupChat | null>(null);
  const [messages, setMessages] = useState<GroupChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const conversationIdRef = useRef<string | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<CandidGroupChat | null>(null);

  // Modal form
  const [modalName, setModalName] = useState("");
  const [availablePersonas, setAvailablePersonas] = useState<CandidPersona[]>([]);
  const [selectedPersonaIds, setSelectedPersonaIds] = useState<string[]>([]);
  const [turnOrder, setTurnOrder] = useState<"RoundRobin" | "Facilitator" | "FreeForm">("RoundRobin");
  const [facilitatorId, setFacilitatorId] = useState<string>("");
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Invite users state
  const [invitePrincipalInput, setInvitePrincipalInput] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);

  // Persona info map for rendering messages
  const [personaMap, setPersonaMap] = useState<Map<string, CandidPersona>>(new Map());

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load group chats and personas
  const loadGroupChats = useCallback(async () => {
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.listGroupChats();
      if ("ok" in result) {
        setGroupChats(result.ok as CandidGroupChat[]);
      }
    } catch {
      // silent
    } finally {
      setIsLoadingList(false);
    }
  }, [authClient]);

  const loadPersonas = useCallback(async () => {
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.listPersonas();
      if ("ok" in result) {
        const personas = result.ok as CandidPersona[];
        setAvailablePersonas(personas);
        const map = new Map<string, CandidPersona>();
        for (const p of personas) map.set(p.id, p);
        setPersonaMap(map);
      }
    } catch {
      // silent
    }
  }, [authClient]);

  useEffect(() => {
    loadGroupChats();
    loadPersonas();
  }, [loadGroupChats, loadPersonas]);

  // Load active group from URL
  useEffect(() => {
    if (urlGroupId && groupChats.length > 0) {
      const found = groupChats.find((g) => g.id === urlGroupId);
      if (found) {
        setActiveGroup(found);
        setMessages([]);
        conversationIdRef.current = null;
      }
    } else if (!urlGroupId) {
      setActiveGroup(null);
      setMessages([]);
      conversationIdRef.current = null;
    }
  }, [urlGroupId, groupChats]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSelectGroup = useCallback((group: CandidGroupChat) => {
    navigate(`/group-chat/${encodeURIComponent(group.id)}`);
  }, [navigate]);

  // Open create modal
  const handleNewGroup = useCallback(() => {
    setEditingGroup(null);
    setModalName("");
    setSelectedPersonaIds([]);
    setTurnOrder("RoundRobin");
    setFacilitatorId("");
    setInvitePrincipalInput("");
    setInviteMessage(null);
    setShowModal(true);
  }, []);

  // Open settings modal for existing group
  const handleOpenSettings = useCallback(() => {
    if (!activeGroup) return;
    setEditingGroup(activeGroup);
    setModalName(activeGroup.name);
    setSelectedPersonaIds([...activeGroup.personaIds]);
    if ("RoundRobin" in activeGroup.turnOrder) setTurnOrder("RoundRobin");
    else if ("FreeForm" in activeGroup.turnOrder) setTurnOrder("FreeForm");
    else if ("Facilitator" in activeGroup.turnOrder) {
      setTurnOrder("Facilitator");
      setFacilitatorId((activeGroup.turnOrder as { Facilitator: string }).Facilitator);
    }
    setInvitePrincipalInput("");
    setInviteMessage(null);
    setShowModal(true);
  }, [activeGroup]);

  const handleTogglePersona = useCallback((id: string) => {
    setSelectedPersonaIds((prev) => {
      if (prev.includes(id)) return prev.filter((p) => p !== id);
      if (prev.length >= 5) return prev;
      return [...prev, id];
    });
  }, []);

  const handleCreateOrSave = useCallback(async () => {
    if (!modalName.trim() || selectedPersonaIds.length < 2 || isCreatingGroup) return;
    setIsCreatingGroup(true);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      let candidTurnOrder: CandidTurnOrder;
      if (turnOrder === "RoundRobin") candidTurnOrder = { RoundRobin: null };
      else if (turnOrder === "FreeForm") candidTurnOrder = { FreeForm: null };
      else candidTurnOrder = { Facilitator: facilitatorId };

      const result = await gateway.createGroupChat(modalName.trim(), selectedPersonaIds, candidTurnOrder);
      if ("ok" in result) {
        const created = result.ok as CandidGroupChat;
        setShowModal(false);
        await loadGroupChats();
        navigate(`/group-chat/${encodeURIComponent(created.id)}`);
      }
    } catch {
      // silent
    } finally {
      setIsCreatingGroup(false);
    }
  }, [modalName, selectedPersonaIds, turnOrder, facilitatorId, isCreatingGroup, authClient, loadGroupChats, navigate]);

  const handleDeleteGroup = useCallback(async (id: string) => {
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      await gateway.deleteGroupChat(id);
      setDeleteConfirm(null);
      if (activeGroup?.id === id) {
        navigate("/group-chat");
      }
      await loadGroupChats();
    } catch {
      // silent
    }
  }, [authClient, activeGroup, navigate, loadGroupChats]);

  // Invite a user to the group chat
  const handleInviteUser = useCallback(async () => {
    if (!invitePrincipalInput.trim() || !editingGroup || isInviting) return;
    setIsInviting(true);
    setInviteMessage(null);
    try {
      const principal = Principal.fromText(invitePrincipalInput.trim());
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.inviteToGroupChat(editingGroup.id, principal);
      if ("ok" in result) {
        setInviteMessage("User invited successfully");
        setInvitePrincipalInput("");
        await loadGroupChats();
      } else {
        setInviteMessage(`Error: ${formatError((result as { err: Record<string, unknown> }).err)}`);
      }
    } catch (e) {
      setInviteMessage(`Error: ${e instanceof Error ? e.message : "Invalid Principal ID"}`);
    } finally {
      setIsInviting(false);
    }
  }, [invitePrincipalInput, editingGroup, isInviting, authClient, loadGroupChats]);

  // Send message to group
  const handleSend = useCallback(async (text: string, targetPersonaId?: string) => {
    if (!text.trim() || !activeGroup || isSending) return;
    const userMsg: GroupChatMessage = {
      role: "user",
      content: text,
      targetPersonaId,
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsSending(true);

    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.groupPrompt({
        groupId: activeGroup.id,
        conversationId: conversationIdRef.current ? [conversationIdRef.current] : [],
        message: text,
        mindspaceId: [],
        targetPersonaId: targetPersonaId ? [targetPersonaId] : [],
      });
      if ("ok" in result) {
        const resp = result.ok as { conversationId: string; responses: CandidGroupMessage[] };
        conversationIdRef.current = resp.conversationId;
        const newMessages: GroupChatMessage[] = resp.responses.map((r) => ({
          role: "assistant",
          content: r.content,
          personaId: r.personaId.length > 0 ? r.personaId[0] : undefined,
          personaName: r.personaName.length > 0 ? r.personaName[0] : undefined,
          personaAvatar: r.personaAvatar.length > 0 ? r.personaAvatar[0] : undefined,
          targetPersonaId: r.targetPersonaId.length > 0 ? r.targetPersonaId[0] : undefined,
          senderPrincipal: r.senderPrincipal.length > 0 && r.senderPrincipal[0] ? r.senderPrincipal[0].toString() : undefined,
        }));
        setMessages((prev) => [...prev, ...newMessages]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${formatError((result as { err: Record<string, unknown> }).err)}` },
        ]);
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${error instanceof Error ? error.message : "Unknown error"}` },
      ]);
    } finally {
      setIsSending(false);
    }
  }, [activeGroup, isSending, authClient]);

  // Get color for a persona in the group
  const getPersonaColor = useCallback((personaId?: string): string => {
    if (!personaId || !activeGroup) return PERSONA_COLORS[0];
    const idx = activeGroup.personaIds.indexOf(personaId);
    return PERSONA_COLORS[idx >= 0 ? idx % PERSONA_COLORS.length : 0];
  }, [activeGroup]);

  // Turn order display
  const getTurnOrderLabel = (group: CandidGroupChat): string => {
    if ("RoundRobin" in group.turnOrder) return "Round Robin";
    if ("FreeForm" in group.turnOrder) return "Free Form";
    if ("Facilitator" in group.turnOrder) return "Facilitator";
    return "Unknown";
  };

  const getTurnOrderIcon = (group: CandidGroupChat): string => {
    if ("RoundRobin" in group.turnOrder) return "\uD83D\uDD04";
    if ("FreeForm" in group.turnOrder) return "\uD83D\uDCAC";
    if ("Facilitator" in group.turnOrder) return "\uD83D\uDC51";
    return "?";
  };

  return (
    <div style={{ display: "flex", height: "100vh", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)", overflow: "hidden" }}>
      {/* Sidebar */}
      <div
        style={{
          width: "280px",
          minWidth: "240px",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--bg-secondary)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "1.25rem 1rem 1rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700 }}>Group Chats</h2>
          <button
            onClick={handleNewGroup}
            style={{
              backgroundColor: "var(--accent)",
              color: "white",
              border: "none",
              borderRadius: "8px",
              padding: "0.4rem 0.75rem",
              fontSize: "0.78rem",
              fontWeight: 600,
              cursor: "pointer",
              transition: "opacity 0.15s ease",
            }}
          >
            + New Group
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0.5rem" }}>
          {isLoadingList && (
            <div style={{ textAlign: "center", padding: "1.5rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>
              Loading...
            </div>
          )}
          {!isLoadingList && groupChats.length === 0 && (
            <div style={{ textAlign: "center", padding: "2rem 1rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>
              No group chats yet. Create one to get started!
            </div>
          )}
          {groupChats.map((group) => {
            const isActive = activeGroup?.id === group.id;
            return (
              <div
                key={group.id}
                onClick={() => handleSelectGroup(group)}
                style={{
                  padding: "0.65rem 0.75rem",
                  borderRadius: "8px",
                  cursor: "pointer",
                  backgroundColor: isActive ? "var(--bg-tertiary)" : "transparent",
                  border: isActive ? "1px solid var(--accent)" : "1px solid transparent",
                  marginBottom: "4px",
                  transition: "all 0.15s ease",
                  position: "relative",
                }}
              >
                <div style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.25rem" }}>{group.name}</div>
                <div style={{ display: "flex", gap: "0.2rem", alignItems: "center" }}>
                  {group.personaIds.slice(0, 5).map((pid, i) => {
                    const persona = personaMap.get(pid);
                    return (
                      <span
                        key={pid}
                        title={persona?.name ?? pid}
                        style={{
                          fontSize: "0.9rem",
                          width: "22px",
                          height: "22px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "50%",
                          backgroundColor: PERSONA_COLORS[i % PERSONA_COLORS.length] + "20",
                          border: `1.5px solid ${PERSONA_COLORS[i % PERSONA_COLORS.length]}`,
                        }}
                      >
                        {persona?.avatar || "\uD83C\uDFAD"}
                      </span>
                    );
                  })}
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginLeft: "0.25rem" }}>
                    {getTurnOrderIcon(group)}
                  </span>
                  {group.invitedUsers && group.invitedUsers.length > 0 && (
                    <span style={{ fontSize: "0.6rem", color: "var(--text-muted)", marginLeft: "0.15rem" }}>
                      +{group.invitedUsers.length} user{group.invitedUsers.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                {/* Delete button */}
                <button
                  onClick={(e) => { e.stopPropagation(); setDeleteConfirm(group.id); }}
                  style={{
                    position: "absolute",
                    top: "0.4rem",
                    right: "0.4rem",
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: "0.72rem",
                    padding: "2px 5px",
                    borderRadius: "4px",
                    lineHeight: 1,
                    opacity: 0.6,
                    transition: "opacity 0.15s",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; (e.currentTarget as HTMLButtonElement).style.color = "#ef4444"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.6"; (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)"; }}
                  title="Delete group"
                >
                  x
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {activeGroup ? (
          <>
            {/* Top Bar */}
            <div
              style={{
                padding: "0.75rem 1.5rem",
                borderBottom: "1px solid var(--border)",
                backgroundColor: "var(--bg-secondary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                <h2 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>{activeGroup.name}</h2>
                <div style={{ display: "flex", gap: "0.3rem" }}>
                  {activeGroup.personaIds.map((pid, i) => {
                    const persona = personaMap.get(pid);
                    return (
                      <span
                        key={pid}
                        title={persona?.name ?? pid}
                        style={{
                          fontSize: "1rem",
                          width: "28px",
                          height: "28px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "50%",
                          backgroundColor: PERSONA_COLORS[i % PERSONA_COLORS.length] + "20",
                          border: `2px solid ${PERSONA_COLORS[i % PERSONA_COLORS.length]}`,
                        }}
                      >
                        {persona?.avatar || "\uD83C\uDFAD"}
                      </span>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <span
                  style={{
                    fontSize: "0.75rem",
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    padding: "3px 8px",
                    borderRadius: "6px",
                    fontWeight: 500,
                  }}
                >
                  {getTurnOrderIcon(activeGroup)} {getTurnOrderLabel(activeGroup)}
                </span>
                <button
                  onClick={handleOpenSettings}
                  style={{
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    padding: "0.35rem 0.65rem",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    color: "var(--text-secondary)",
                    transition: "border-color 0.15s ease",
                  }}
                  title="Group settings"
                >
                  \u2699
                </button>
              </div>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.5rem" }}>
              {messages.length === 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    flexDirection: "column",
                    gap: "0.5rem",
                    color: "var(--text-muted)",
                  }}
                >
                  <div style={{ display: "flex", gap: "0.25rem", fontSize: "1.8rem" }}>
                    {activeGroup.personaIds.map((pid) => {
                      const persona = personaMap.get(pid);
                      return <span key={pid}>{persona?.avatar || "\uD83C\uDFAD"}</span>;
                    })}
                  </div>
                  <span style={{ fontSize: "0.9rem" }}>
                    Start a conversation with {activeGroup.personaIds.length} personas
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    Tip: Type @ to mention a specific persona
                  </span>
                </div>
              )}
              {messages.map((msg, i) => (
                <GroupMessageBubble
                  key={i}
                  message={msg}
                  color={getPersonaColor(msg.personaId)}
                  personaMap={personaMap}
                />
              ))}
              {isSending && (
                <div style={{ display: "flex", gap: "0.4rem", padding: "0.75rem 0", alignItems: "center" }}>
                  {activeGroup.personaIds.map((pid, i) => {
                    const persona = personaMap.get(pid);
                    return (
                      <span
                        key={pid}
                        style={{
                          fontSize: "0.9rem",
                          width: "26px",
                          height: "26px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "50%",
                          backgroundColor: PERSONA_COLORS[i % PERSONA_COLORS.length] + "20",
                          border: `1.5px solid ${PERSONA_COLORS[i % PERSONA_COLORS.length]}`,
                          animation: `groupPulse 1.2s ease-in-out infinite`,
                          animationDelay: `${i * 0.2}s`,
                        }}
                      >
                        {persona?.avatar || "\uD83C\uDFAD"}
                      </span>
                    );
                  })}
                  <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "0.5rem" }}>
                    Thinking...
                  </span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Bar */}
            <GroupInputBar
              onSend={handleSend}
              isLoading={isSending}
              personas={activeGroup.personaIds.map((pid) => personaMap.get(pid)).filter(Boolean) as CandidPersona[]}
            />
          </>
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
            <span style={{ fontSize: "2.5rem" }}>\uD83D\uDC65</span>
            <span style={{ fontSize: "0.95rem" }}>Select a group chat or create a new one</span>
            <button
              onClick={handleNewGroup}
              style={{
                backgroundColor: "var(--accent)",
                color: "white",
                border: "none",
                borderRadius: "8px",
                padding: "0.6rem 1.25rem",
                fontSize: "0.88rem",
                fontWeight: 600,
                cursor: "pointer",
                marginTop: "0.5rem",
              }}
            >
              + Create Group Chat
            </button>
          </div>
        )}
      </div>

      {/* Create/Configure Modal */}
      {showModal && (
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
          onClick={() => setShowModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderRadius: "12px",
              padding: "1.5rem",
              maxWidth: "560px",
              width: "90%",
              maxHeight: "85vh",
              overflowY: "auto",
              boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
            }}
          >
            <h3 style={{ margin: "0 0 1.25rem 0", fontSize: "1.1rem", fontWeight: 600 }}>
              {editingGroup ? "Group Settings" : "Create Group Chat"}
            </h3>

            {/* Name */}
            <div style={{ marginBottom: "1.25rem" }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: "0.35rem" }}>
                Group Name
              </label>
              <input
                value={modalName}
                onChange={(e) => setModalName(e.target.value.slice(0, 60))}
                placeholder="e.g. Creative Team, Tech Review Panel..."
                style={modalInputStyle}
              />
            </div>

            {/* Persona Selector */}
            <div style={{ marginBottom: "1.25rem" }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: "0.35rem" }}>
                Personas ({selectedPersonaIds.length}/5 selected, min 2)
              </label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                  gap: "0.5rem",
                  maxHeight: "250px",
                  overflowY: "auto",
                  padding: "0.25rem",
                }}
              >
                {availablePersonas.map((persona) => {
                  const isSelected = selectedPersonaIds.includes(persona.id);
                  const isDisabled = !isSelected && selectedPersonaIds.length >= 5;
                  return (
                    <div
                      key={persona.id}
                      onClick={() => !isDisabled && handleTogglePersona(persona.id)}
                      style={{
                        backgroundColor: isSelected ? "var(--bg-tertiary)" : "var(--bg-primary)",
                        border: isSelected ? "2px solid var(--accent)" : "1px solid var(--border)",
                        borderRadius: "8px",
                        padding: "0.65rem",
                        cursor: isDisabled ? "not-allowed" : "pointer",
                        opacity: isDisabled ? 0.5 : 1,
                        transition: "all 0.15s ease",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.25rem" }}>
                        <span style={{ fontSize: "1.1rem" }}>{persona.avatar || "\uD83C\uDFAD"}</span>
                        <span style={{ fontSize: "0.82rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {persona.name}
                        </span>
                      </div>
                      {persona.description && (
                        <div
                          style={{
                            fontSize: "0.68rem",
                            color: "var(--text-muted)",
                            lineHeight: 1.3,
                            overflow: "hidden",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                          }}
                        >
                          {persona.description}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Turn Order */}
            <div style={{ marginBottom: "1.25rem" }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: "0.5rem" }}>
                Turn Order
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {([
                  { value: "RoundRobin" as const, label: "Round Robin", desc: "Each persona responds in order", icon: "\uD83D\uDD04" },
                  { value: "Facilitator" as const, label: "Facilitator", desc: "One persona leads the discussion", icon: "\uD83D\uDC51" },
                  { value: "FreeForm" as const, label: "Free Form", desc: "All personas respond freely", icon: "\uD83D\uDCAC" },
                ]).map((option) => (
                  <label
                    key={option.value}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.6rem",
                      padding: "0.5rem 0.75rem",
                      borderRadius: "8px",
                      backgroundColor: turnOrder === option.value ? "var(--bg-tertiary)" : "transparent",
                      border: turnOrder === option.value ? "1px solid var(--accent)" : "1px solid var(--border)",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <input
                      type="radio"
                      checked={turnOrder === option.value}
                      onChange={() => setTurnOrder(option.value)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    <span style={{ fontSize: "0.95rem" }}>{option.icon}</span>
                    <div>
                      <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>{option.label}</div>
                      <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{option.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
              {turnOrder === "Facilitator" && selectedPersonaIds.length > 0 && (
                <div style={{ marginTop: "0.75rem" }}>
                  <label style={{ fontSize: "0.78rem", color: "var(--text-secondary)", display: "block", marginBottom: "0.25rem" }}>
                    Select facilitator:
                  </label>
                  <select
                    value={facilitatorId}
                    onChange={(e) => setFacilitatorId(e.target.value)}
                    style={{
                      ...modalInputStyle,
                      cursor: "pointer",
                    }}
                  >
                    <option value="">Choose a persona...</option>
                    {selectedPersonaIds.map((pid) => {
                      const persona = availablePersonas.find((p) => p.id === pid);
                      return (
                        <option key={pid} value={pid}>
                          {persona?.avatar} {persona?.name ?? pid}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
            </div>

            {/* Invite Users (only when editing existing group) */}
            {editingGroup && (
              <div style={{ marginBottom: "1.25rem" }}>
                <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: "0.5rem" }}>
                  Invite Users
                </label>
                <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "0.5rem", lineHeight: 1.4 }}>
                  Invite other humans by their Principal ID. Invited users can participate by visiting this group chat URL.
                </p>
                <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
                  <input
                    value={invitePrincipalInput}
                    onChange={(e) => setInvitePrincipalInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleInviteUser(); } }}
                    placeholder="Enter Principal ID..."
                    disabled={isInviting}
                    style={{ ...modalInputStyle, flex: 1 }}
                  />
                  <button
                    onClick={handleInviteUser}
                    disabled={!invitePrincipalInput.trim() || isInviting}
                    style={{
                      backgroundColor: invitePrincipalInput.trim() && !isInviting ? "var(--accent)" : "var(--bg-tertiary)",
                      color: invitePrincipalInput.trim() && !isInviting ? "white" : "var(--text-muted)",
                      border: "none",
                      borderRadius: "6px",
                      padding: "0.4rem 0.75rem",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      cursor: invitePrincipalInput.trim() && !isInviting ? "pointer" : "default",
                    }}
                  >
                    {isInviting ? "..." : "Invite"}
                  </button>
                </div>
                {inviteMessage && (
                  <p style={{
                    fontSize: "0.75rem",
                    color: inviteMessage.includes("success") ? "#22c55e" : "#ef4444",
                    marginBottom: "0.5rem",
                  }}>
                    {inviteMessage}
                  </p>
                )}
                {/* List of currently invited users */}
                {editingGroup.invitedUsers && editingGroup.invitedUsers.length > 0 && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: "0.35rem" }}>
                      Invited ({editingGroup.invitedUsers.length})
                    </div>
                    {editingGroup.invitedUsers.map((principal, idx) => (
                      <div
                        key={idx}
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--text-secondary)",
                          backgroundColor: "var(--bg-primary)",
                          padding: "0.3rem 0.5rem",
                          borderRadius: "4px",
                          marginBottom: "0.25rem",
                          fontFamily: "monospace",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {principal.toString()}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  padding: "0.5rem 1rem",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateOrSave}
                disabled={!modalName.trim() || selectedPersonaIds.length < 2 || isCreatingGroup || (turnOrder === "Facilitator" && !facilitatorId)}
                style={{
                  backgroundColor: (modalName.trim() && selectedPersonaIds.length >= 2 && !isCreatingGroup && (turnOrder !== "Facilitator" || facilitatorId))
                    ? "var(--accent)"
                    : "var(--bg-tertiary)",
                  color: (modalName.trim() && selectedPersonaIds.length >= 2 && !isCreatingGroup && (turnOrder !== "Facilitator" || facilitatorId))
                    ? "white"
                    : "var(--text-muted)",
                  border: "none",
                  borderRadius: "8px",
                  padding: "0.5rem 1.5rem",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  cursor: (modalName.trim() && selectedPersonaIds.length >= 2 && !isCreatingGroup) ? "pointer" : "default",
                }}
              >
                {isCreatingGroup ? "Creating..." : editingGroup ? "Save" : "Create Group"}
              </button>
            </div>
          </div>
        </div>
      )}

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
            zIndex: 1001,
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
            <h3 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem", fontWeight: 600 }}>
              Delete Group Chat?
            </h3>
            <p style={{ margin: "0 0 1.25rem 0", fontSize: "0.85rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
              This will permanently delete the group chat and all its messages.
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
                onClick={() => handleDeleteGroup(deleteConfirm)}
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

      {/* Pulse animation for typing indicators */}
      <style>{`
        @keyframes groupPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(0.9); }
        }
      `}</style>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

interface GroupMessageBubbleProps {
  message: GroupChatMessage;
  color: string;
  personaMap: Map<string, CandidPersona>;
}

function GroupMessageBubble({ message, color, personaMap }: GroupMessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
        <div
          style={{
            maxWidth: "70%",
            backgroundColor: "var(--accent)",
            color: "white",
            borderRadius: "12px 12px 4px 12px",
            padding: "0.65rem 1rem",
            fontSize: "0.88rem",
            lineHeight: 1.5,
          }}
        >
          {message.targetPersonaId && (
            <span style={{
              display: "inline-block",
              fontSize: "0.72rem",
              fontWeight: 600,
              backgroundColor: "rgba(255,255,255,0.2)",
              padding: "1px 6px",
              borderRadius: "4px",
              marginRight: "0.4rem",
              marginBottom: "0.2rem",
            }}>
              @{personaMap.get(message.targetPersonaId)?.name || message.targetPersonaId}
            </span>
          )}
          {message.content}
        </div>
      </div>
    );
  }

  // Message from a human user (not the owner)
  if (message.senderPrincipal) {
    return (
      <div style={{ display: "flex", gap: "0.6rem", marginBottom: "0.75rem", alignItems: "flex-start" }}>
        <div
          style={{
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            backgroundColor: "#8b5cf620",
            border: "2px solid #8b5cf6",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.85rem",
            flexShrink: 0,
          }}
        >
          \uD83D\uDC64
        </div>
        <div style={{ flex: 1, maxWidth: "75%" }}>
          <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "#8b5cf6", marginBottom: "0.2rem" }}>
            User: {message.senderPrincipal.slice(0, 12)}...
          </div>
          <div
            style={{
              backgroundColor: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderLeft: "3px solid #8b5cf6",
              borderRadius: "4px 12px 12px 12px",
              padding: "0.65rem 1rem",
              fontSize: "0.88rem",
              lineHeight: 1.5,
              color: "var(--text-primary)",
            }}
          >
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: "0.6rem", marginBottom: "0.75rem", alignItems: "flex-start" }}>
      <div
        style={{
          width: "32px",
          height: "32px",
          borderRadius: "50%",
          backgroundColor: color + "20",
          border: `2px solid ${color}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1rem",
          flexShrink: 0,
        }}
      >
        {message.personaAvatar || "\uD83C\uDFAD"}
      </div>
      <div style={{ flex: 1, maxWidth: "75%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.2rem" }}>
          {message.personaName && (
            <span style={{ fontSize: "0.75rem", fontWeight: 600, color }}>
              {message.personaName}
            </span>
          )}
          {message.targetPersonaId && (
            <span style={{
              fontSize: "0.62rem",
              fontWeight: 500,
              backgroundColor: color + "20",
              color,
              padding: "1px 5px",
              borderRadius: "4px",
            }}>
              @{personaMap.get(message.targetPersonaId)?.name || "mentioned"}
            </span>
          )}
        </div>
        <div
          style={{
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderLeft: `3px solid ${color}`,
            borderRadius: "4px 12px 12px 12px",
            padding: "0.65rem 1rem",
            fontSize: "0.88rem",
            lineHeight: 1.5,
            color: "var(--text-primary)",
          }}
        >
          {message.content}
        </div>
      </div>
    </div>
  );
}

interface GroupInputBarProps {
  onSend: (text: string, targetPersonaId?: string) => void;
  isLoading: boolean;
  personas: CandidPersona[];
}

function GroupInputBar({ onSend, isLoading, personas }: GroupInputBarProps) {
  const [text, setText] = useState("");
  const [targetPersonaId, setTargetPersonaId] = useState<string | undefined>(undefined);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleSend = useCallback(() => {
    if (text.trim() && !isLoading) {
      onSend(text.trim(), targetPersonaId);
      setText("");
      setTargetPersonaId(undefined);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
  }, [text, isLoading, onSend, targetPersonaId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (showMentionDropdown) {
          // Select first matching persona
          const filtered = personas.filter((p) =>
            p.name.toLowerCase().includes(mentionFilter.toLowerCase())
          );
          if (filtered.length > 0) {
            handleSelectMention(filtered[0]);
          }
          return;
        }
        handleSend();
      }
      if (e.key === "Escape" && showMentionDropdown) {
        setShowMentionDropdown(false);
      }
    },
    [handleSend, showMentionDropdown, mentionFilter, personas]
  );

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    // Detect @mention
    const lastAtIdx = val.lastIndexOf("@");
    if (lastAtIdx >= 0 && (lastAtIdx === 0 || val[lastAtIdx - 1] === " ")) {
      const afterAt = val.slice(lastAtIdx + 1);
      if (!afterAt.includes(" ") || afterAt.length === 0) {
        setShowMentionDropdown(true);
        setMentionFilter(afterAt);
        return;
      }
    }
    setShowMentionDropdown(false);
  }, []);

  const handleSelectMention = useCallback((persona: CandidPersona) => {
    const lastAtIdx = text.lastIndexOf("@");
    const before = text.slice(0, lastAtIdx);
    setText(`${before}@${persona.name} `);
    setTargetPersonaId(persona.id);
    setShowMentionDropdown(false);
    textareaRef.current?.focus();
  }, [text]);

  const handleClearTarget = useCallback(() => {
    setTargetPersonaId(undefined);
  }, []);

  const handleInput = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, []);

  const filteredPersonas = personas.filter((p) =>
    p.name.toLowerCase().includes(mentionFilter.toLowerCase())
  );

  return (
    <div
      style={{
        padding: "1rem 1.5rem",
        borderTop: "1px solid var(--border)",
        backgroundColor: "var(--bg-secondary)",
        position: "relative",
      }}
    >
      {/* @mention dropdown */}
      {showMentionDropdown && filteredPersonas.length > 0 && (
        <div
          ref={dropdownRef}
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: "1.5rem",
            width: "260px",
            backgroundColor: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            boxShadow: "0 -4px 16px rgba(0,0,0,0.3)",
            zIndex: 50,
            maxHeight: "200px",
            overflowY: "auto",
          }}
        >
          <div style={{ padding: "0.35rem 0.65rem", fontSize: "0.68rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Mention a persona
          </div>
          {filteredPersonas.map((persona) => (
            <button
              key={persona.id}
              onClick={() => handleSelectMention(persona)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                width: "100%",
                textAlign: "left",
                backgroundColor: "transparent",
                border: "none",
                color: "var(--text-primary)",
                padding: "0.45rem 0.65rem",
                cursor: "pointer",
                fontSize: "0.85rem",
                transition: "background-color 0.1s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--bg-secondary)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent"; }}
            >
              <span style={{ fontSize: "1.1rem" }}>{persona.avatar || "\uD83C\uDFAD"}</span>
              <span style={{ fontWeight: 500 }}>{persona.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Target badge */}
      {targetPersonaId && (
        <div style={{ marginBottom: "0.4rem", display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <span style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            backgroundColor: "var(--accent)" + "20",
            color: "var(--accent)",
            padding: "2px 8px",
            borderRadius: "999px",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3rem",
          }}>
            @{personas.find((p) => p.id === targetPersonaId)?.name ?? targetPersonaId}
            <button
              onClick={handleClearTarget}
              style={{
                background: "none", border: "none",
                color: "var(--accent)", cursor: "pointer",
                padding: "0 2px", fontSize: "0.78rem", lineHeight: 1,
              }}
            >
              x
            </button>
          </span>
          <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
            Only this persona will respond
          </span>
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "flex-end",
          maxWidth: "800px",
          margin: "0 auto",
        }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Message all personas... (@ to mention, Enter to send)"
          disabled={isLoading}
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            padding: "0.75rem 1rem",
            backgroundColor: "var(--bg-primary)",
            color: "var(--text-primary)",
            fontSize: "0.95rem",
            lineHeight: 1.5,
            outline: "none",
            minHeight: "44px",
            maxHeight: "200px",
            transition: "border-color 0.15s",
          }}
        />
        <button
          onClick={handleSend}
          disabled={!text.trim() || isLoading}
          style={{
            padding: "0.7rem 1.25rem",
            backgroundColor: text.trim() && !isLoading ? "var(--accent)" : "var(--bg-tertiary)",
            color: text.trim() && !isLoading ? "white" : "var(--text-muted)",
            border: "none",
            borderRadius: "12px",
            fontWeight: 600,
            fontSize: "0.9rem",
            transition: "all 0.15s",
            minHeight: "44px",
            cursor: text.trim() && !isLoading ? "pointer" : "default",
          }}
        >
          {isLoading ? "..." : "Send"}
        </button>
      </div>
      <p style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.68rem", marginTop: "0.4rem" }}>
        {targetPersonaId ? "Message will be sent to the mentioned persona only" : "Message will be sent to all personas in the group"}
      </p>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const modalInputStyle: React.CSSProperties = {
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
