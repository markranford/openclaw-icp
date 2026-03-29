import { useState, useCallback, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import MessageList from "./MessageList";
import InputBar from "./InputBar";
import ModelSelector from "./ModelSelector";
import SystemPromptSelector from "./SystemPromptSelector";
import PersonaSelector from "./PersonaSelector";
import BalanceIndicator from "./BalanceIndicator";
import MindspaceSwitcher from "./MindspaceSwitcher";
import ComputePowerSlider from "./ComputePowerSlider";
import ChatModeSelector from "./ChatModeSelector";
import DualResponseView from "./DualResponseView";
import ModelCompareView from "./ModelCompareView";
import MemoryContextPanel from "./MemoryContextPanel";
import { useAuth } from "../auth/useAuth";
import { useConversations } from "./ConversationContext";
import { createAgent } from "../api/agent";
import {
  createGatewayActor,
  type CandidModel,
  type CandidPromptRequest,
} from "../api/gateway.did";

export type Model =
  | { OnChain: "Llama3_1_8B" | "Qwen3_32B" | "Llama4Scout" }
  | { External: "Claude_Sonnet" | "Claude_Haiku" | "GPT4o" | "GPT4oMini" | "MagickMind_Brain" };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Convert the UI Model type into the Candid variant representation. */
function toCandidModel(model: Model): CandidModel {
  if ("OnChain" in model) {
    return { OnChain: { [model.OnChain]: null } as Record<string, null> } as CandidModel;
  }
  return { External: { [model.External]: null } as Record<string, null> } as CandidModel;
}

/** Extract a human-readable error string from a Candid OpenClawError variant. */
function formatError(err: Record<string, unknown>): string {
  const key = Object.keys(err)[0];
  const val = err[key];
  // Variants with a text payload
  if (typeof val === "string") return `${key}: ${val}`;
  return key;
}

/** Map a Candid role variant to our string role. */
function fromCandidRole(role: Record<string, null>): "system" | "user" | "assistant" {
  if ("user" in role) return "user";
  if ("assistant" in role) return "assistant";
  return "system";
}

export default function ChatPage() {
  const { id: urlConversationId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [model, setModel] = useState<Model>({ OnChain: "Llama3_1_8B" });
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [isAnimatingResponse, setIsAnimatingResponse] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [systemPromptName, setSystemPromptName] = useState("");
  const [mindspaceId, setMindspaceId] = useState("default");
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [chatMode, setChatMode] = useState<"standard" | "dual" | "compare">("standard");
  const [computePower, setComputePower] = useState(50);
  const [compareModelIds, setCompareModelIds] = useState<string[]>(["gpt-4o", "claude-sonnet-4"]);
  const [dualResponse, setDualResponse] = useState<{ fast: string; smart: string | null } | null>(null);
  const [compareResponses, setCompareResponses] = useState<Array<{ modelId: string; reply: string }>>([]);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [memoryContext, setMemoryContext] = useState("");
  const { authClient, isAuthenticated } = useAuth();
  const { refreshConversations } = useConversations();

  // Track the current conversation ID so follow-up messages stay in the same thread
  const conversationIdRef = useRef<string | null>(null);
  // Track which conversation we last loaded to avoid re-fetching
  const loadedConversationRef = useRef<string | null>(null);

  // When URL changes: load existing conversation or reset for new chat
  useEffect(() => {
    if (urlConversationId) {
      // Navigated to /chat/:id — load the conversation if we haven't already
      if (loadedConversationRef.current === urlConversationId) return;

      conversationIdRef.current = urlConversationId;
      loadedConversationRef.current = urlConversationId;
      setIsLoadingConversation(true);

      (async () => {
        try {
          const agent = await createAgent(authClient ?? undefined);
          const gateway = createGatewayActor(agent);
          const result = await gateway.getConversation(urlConversationId);

          if ("ok" in result) {
            const conv = result.ok as {
              id: string;
              messages: Array<{ role: Record<string, null>; content: string }>;
              model: CandidModel;
              mindspaceId: [] | [string];
            };
            const loaded: ChatMessage[] = conv.messages.map((m) => ({
              role: fromCandidRole(m.role),
              content: m.content,
            }));
            setMessages(loaded);
            // Restore mindspace from conversation if present
            if (conv.mindspaceId && conv.mindspaceId.length > 0 && conv.mindspaceId[0]) {
              setMindspaceId(conv.mindspaceId[0]);
            }
          } else {
            const errMsg = formatError(
              (result as { err: Record<string, unknown> }).err
            );
            setMessages([
              {
                role: "assistant",
                content: `Failed to load conversation: ${errMsg}`,
              },
            ]);
          }
        } catch (error) {
          setMessages([
            {
              role: "assistant",
              content: `Error loading conversation: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ]);
        } finally {
          setIsLoadingConversation(false);
        }
      })();
    } else {
      // Navigated to / (new chat) — reset everything
      conversationIdRef.current = null;
      loadedConversationRef.current = null;
      setMessages([]);
      setSystemPrompt("");
      setSystemPromptName("");
      setMindspaceId("default");
      setSelectedPersonaId(null);
    }
  }, [urlConversationId, authClient]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isLoading) return;

      // Add user message
      const userMessage: ChatMessage = { role: "user", content: text };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      // Clear any previous dual/compare results
      setDualResponse(null);
      setCompareResponses([]);

      try {
        if (!isAuthenticated) {
          throw new Error("Please log in before sending messages.");
        }

        // Build an authenticated agent and actor (dev mode uses local identity)
        const agent = await createAgent(authClient ?? undefined);
        const gateway = createGatewayActor(agent);

        const isMagickMind = "External" in model && model.External === "MagickMind_Brain";

        // Compose effective system prompt with memory context
        const effectiveSystemPrompt = memoryContext
          ? (systemPrompt ? memoryContext + "\n\n" + systemPrompt : memoryContext)
          : systemPrompt;

        // ── Dual Brain mode ──────────────────────────────────────────
        if (chatMode === "dual" && isMagickMind) {
          const req: CandidPromptRequest = {
            message: text,
            model: toCandidModel(model),
            conversationId: conversationIdRef.current
              ? [conversationIdRef.current]
              : [],
            systemPrompt: effectiveSystemPrompt ? [effectiveSystemPrompt] : [],
            apiKey: [],
            mindspaceId: [mindspaceId],
          };

          const result = await gateway.dualPrompt(req);

          if ("ok" in result) {
            const { fastReply, smartReply, conversationId } = result.ok;
            setDualResponse({ fast: fastReply, smart: smartReply });

            const wasNewConversation = !conversationIdRef.current;
            conversationIdRef.current = conversationId;
            loadedConversationRef.current = conversationId;

            if (wasNewConversation) {
              navigate(`/chat/${encodeURIComponent(conversationId)}`, { replace: true });
            }
            refreshConversations();
          } else {
            throw new Error(formatError(result.err as unknown as Record<string, unknown>));
          }
        }
        // ── Compare mode ─────────────────────────────────────────────
        else if (chatMode === "compare" && isMagickMind) {
          const result = await gateway.compareModels({
            message: text,
            modelIds: compareModelIds,
            conversationId: conversationIdRef.current
              ? [conversationIdRef.current]
              : [],
            systemPrompt: effectiveSystemPrompt ? [effectiveSystemPrompt] : [],
            mindspaceId: [mindspaceId],
          });

          if ("ok" in result) {
            setCompareResponses(result.ok.responses);
            const wasNewConversation = !conversationIdRef.current;
            conversationIdRef.current = result.ok.conversationId;
            loadedConversationRef.current = result.ok.conversationId;

            if (wasNewConversation) {
              navigate(`/chat/${encodeURIComponent(result.ok.conversationId)}`, { replace: true });
            }
            refreshConversations();
          } else {
            throw new Error(formatError(result.err as unknown as Record<string, unknown>));
          }
        }
        // ── Standard mode ────────────────────────────────────────────
        else {
          const req: CandidPromptRequest = {
            message: text,
            model: toCandidModel(model),
            conversationId: conversationIdRef.current
              ? [conversationIdRef.current]
              : [],
            systemPrompt: effectiveSystemPrompt ? [effectiveSystemPrompt] : [],
            apiKey: [],
            mindspaceId: isMagickMind ? [mindspaceId] : [],
          };

          const result = await gateway.prompt(req);

          if ("ok" in result) {
            const { reply, conversationId, mindspaceId: responseMindspace } = result.ok;

            if (responseMindspace && responseMindspace.length > 0 && responseMindspace[0]) {
              setMindspaceId(responseMindspace[0]);
            }

            const wasNewConversation = !conversationIdRef.current;
            conversationIdRef.current = conversationId;
            loadedConversationRef.current = conversationId;

            const assistantMessage: ChatMessage = {
              role: "assistant",
              content: reply,
            };
            setMessages((prev) => [...prev, assistantMessage]);
            setIsAnimatingResponse(true);

            if (wasNewConversation) {
              navigate(`/chat/${encodeURIComponent(conversationId)}`, { replace: true });
            }
            refreshConversations();
          } else {
            throw new Error(formatError(result.err as unknown as Record<string, unknown>));
          }
        }
      } catch (error) {
        const errorMessage: ChatMessage = {
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsLoading(false);
      }
    },
    [model, isLoading, authClient, isAuthenticated, navigate, refreshConversations, systemPrompt, mindspaceId, chatMode, compareModelIds, memoryContext]
  );

  const handleAnimationComplete = useCallback(() => {
    setIsAnimatingResponse(false);
  }, []);

  const handleSystemPromptSelect = useCallback((prompt: string, name: string) => {
    setSystemPrompt(prompt);
    setSystemPromptName(name);
  }, []);

  const handlePersonaSelect = useCallback((personaId: string | null, compiledPrompt: string) => {
    setSelectedPersonaId(personaId);
    if (personaId) {
      setSystemPrompt(compiledPrompt);
      setSystemPromptName("Persona: " + personaId);
    } else {
      setSystemPrompt("");
      setSystemPromptName("");
    }
  }, []);

  const handleSelectReply = useCallback((reply: string) => {
    const msg: ChatMessage = { role: "assistant", content: reply };
    setMessages((prev) => [...prev, msg]);
    setDualResponse(null);
    setCompareResponses([]);
    setIsAnimatingResponse(true);
    refreshConversations();
  }, [refreshConversations]);

  const isMagickMindSelected = "External" in model && model.External === "MagickMind_Brain";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        backgroundColor: "var(--bg-primary)",
      }}
    >
      {/* Header with model selector */}
      <div
        style={{
          padding: "0.75rem 1.5rem",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: "var(--bg-secondary)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>
            {messages.length === 0 ? "New Chat" : "Chat"}
          </h2>
          <SystemPromptSelector
            systemPrompt={systemPrompt}
            systemPromptName={systemPromptName}
            onSelect={handleSystemPromptSelect}
            hasMessages={messages.length > 0}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {"External" in model && isAuthenticated && (
            <BalanceIndicator model={model} />
          )}
          {isMagickMindSelected && (
            <PersonaSelector
              selectedPersonaId={selectedPersonaId}
              onSelect={handlePersonaSelect}
            />
          )}
          {isMagickMindSelected && (
            <MindspaceSwitcher mindspaceId={mindspaceId} onChange={setMindspaceId} />
          )}
          {isMagickMindSelected && (
            <button
              onClick={() => setShowMemoryPanel(!showMemoryPanel)}
              title="Memory Context"
              style={{
                background: showMemoryPanel ? "var(--accent)" : "none",
                border: showMemoryPanel ? "none" : "1px solid var(--border)",
                color: showMemoryPanel ? "#fff" : "var(--text-secondary)",
                borderRadius: 6,
                padding: "0.35rem 0.5rem",
                cursor: "pointer",
                fontSize: "1rem",
                lineHeight: 1,
                transition: "all 0.15s ease",
              }}
            >
              {"\uD83E\uDDE0"}
            </button>
          )}
          {isMagickMindSelected && (
            <ChatModeSelector
              mode={chatMode}
              onModeChange={setChatMode}
              compareModels={compareModelIds}
              onCompareModelsChange={setCompareModelIds}
            />
          )}
          {isMagickMindSelected && (
            <ComputePowerSlider value={computePower} onChange={setComputePower} />
          )}
          <ModelSelector model={model} onChange={setModel} />
        </div>
      </div>

      {/* Main content area with optional memory panel */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Loading state for conversation fetch */}
          {isLoadingConversation ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-muted)",
                fontSize: "0.95rem",
              }}
            >
              Loading conversation...
            </div>
          ) : (
            <>
              {/* Messages */}
              <MessageList
                messages={messages}
                isLoading={isLoading}
                isAnimatingResponse={isAnimatingResponse}
                onAnimationComplete={handleAnimationComplete}
              />

              {/* Dual Brain response view */}
              {dualResponse && (
                <DualResponseView
                  fastReply={dualResponse.fast}
                  smartReply={dualResponse.smart}
                  isLoading={false}
                  onSelectReply={(which) =>
                    handleSelectReply(
                      which === "fast" ? dualResponse.fast : dualResponse.smart!
                    )
                  }
                />
              )}

              {/* Model compare response view */}
              {compareResponses.length > 0 && (
                <ModelCompareView
                  responses={compareResponses}
                  isLoading={isLoading}
                  onSelectBest={(modelId) => {
                    const resp = compareResponses.find((r) => r.modelId === modelId);
                    if (resp) handleSelectReply(resp.reply);
                  }}
                />
              )}

              {/* Input */}
              <InputBar onSend={handleSend} isLoading={isLoading} />
            </>
          )}
        </div>

        {/* Memory context panel */}
        {isMagickMindSelected && showMemoryPanel && (
          <MemoryContextPanel
            mindspaceId={mindspaceId}
            isOpen={showMemoryPanel}
            onToggle={() => setShowMemoryPanel(false)}
            onContextLoaded={setMemoryContext}
          />
        )}
      </div>
    </div>
  );
}
