import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import { createGatewayActor, type CandidModel, type CandidConversationSummary } from "../api/gateway.did";

export interface ConversationSummary {
  id: string;
  model: CandidModel;
  messageCount: bigint;
  updatedAt: bigint;
  title: string;
  preview: string;
  mindspaceId?: string;
}

interface ConversationContextType {
  conversations: ConversationSummary[];
  isLoadingConversations: boolean;
  conversationError: string | null;
  refreshConversations: () => Promise<void>;
}

const ConversationContext = createContext<ConversationContextType>({
  conversations: [],
  isLoadingConversations: false,
  conversationError: null,
  refreshConversations: async () => {},
});

export function ConversationProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const { authClient, isAuthenticated } = useAuth();

  const refreshConversations = useCallback(async () => {
    if (!isAuthenticated) return;

    setIsLoadingConversations(true);
    setConversationError(null);

    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.listConversations();

      if ("ok" in result) {
        const raw = result.ok as unknown as CandidConversationSummary[];
        const summaries: ConversationSummary[] = raw
          .map((c) => ({
            id: c.id,
            model: c.model,
            messageCount: c.messageCount,
            updatedAt: c.updatedAt,
            title: c.title,
            preview: c.preview,
            mindspaceId: c.mindspaceId && c.mindspaceId.length > 0 ? c.mindspaceId[0] : undefined,
          }))
          .sort((a, b) => {
            // Sort by updatedAt descending (newest first)
            const aTime = Number(a.updatedAt);
            const bTime = Number(b.updatedAt);
            return bTime - aTime;
          });
        setConversations(summaries);
      } else {
        const errKey = Object.keys(result.err)[0];
        setConversationError(errKey || "Failed to load conversations");
      }
    } catch (error) {
      setConversationError(
        error instanceof Error ? error.message : "Failed to load conversations"
      );
    } finally {
      setIsLoadingConversations(false);
    }
  }, [authClient, isAuthenticated]);

  // Load conversations on mount when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      refreshConversations();
    }
  }, [isAuthenticated, refreshConversations]);

  return (
    <ConversationContext.Provider
      value={{
        conversations,
        isLoadingConversations,
        conversationError,
        refreshConversations,
      }}
    >
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversations() {
  return useContext(ConversationContext);
}
