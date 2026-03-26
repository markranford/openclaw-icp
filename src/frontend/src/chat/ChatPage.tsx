import { useState, useCallback, useRef } from "react";
import MessageList from "./MessageList";
import InputBar from "./InputBar";
import ModelSelector from "./ModelSelector";
import { useAuth } from "../auth/useAuth";
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

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [model, setModel] = useState<Model>({ OnChain: "Llama3_1_8B" });
  const [isLoading, setIsLoading] = useState(false);
  const { authClient, isAuthenticated } = useAuth();

  // Track the current conversation ID so follow-up messages stay in the same thread
  const conversationIdRef = useRef<string | null>(null);

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isLoading) return;

      // Add user message
      const userMessage: ChatMessage = { role: "user", content: text };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      try {
        if (!isAuthenticated) {
          throw new Error("Please log in before sending messages.");
        }

        // Build an authenticated agent and actor (dev mode uses local identity)
        const agent = await createAgent(authClient ?? undefined);
        const gateway = createGatewayActor(agent);

        // Build the Candid request
        const req: CandidPromptRequest = {
          message: text,
          model: toCandidModel(model),
          conversationId: conversationIdRef.current
            ? [conversationIdRef.current]
            : [],
          systemPrompt: [],
          apiKey: [], // TODO: pass vetKD-decrypted key for external models on mainnet
        };

        const result = await gateway.prompt(req);

        if ("ok" in result) {
          const { reply, conversationId } = result.ok;
          conversationIdRef.current = conversationId;

          const assistantMessage: ChatMessage = {
            role: "assistant",
            content: reply,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        } else {
          throw new Error(formatError(result.err as unknown as Record<string, unknown>));
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
    [model, isLoading, authClient, isAuthenticated]
  );

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
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>
          {messages.length === 0 ? "New Chat" : "Chat"}
        </h2>
        <ModelSelector model={model} onChange={setModel} />
      </div>

      {/* Messages */}
      <MessageList messages={messages} isLoading={isLoading} />

      {/* Input */}
      <InputBar onSend={handleSend} isLoading={isLoading} />
    </div>
  );
}
