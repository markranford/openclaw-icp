import { IDL } from "@icp-sdk/core/candid";
import { Actor, HttpAgent, type ActorSubclass } from "@icp-sdk/core/agent";
import { GATEWAY_CANISTER_ID } from "./agent";

// ── Candid types ────────────────────────────────────────────────────

const Role = IDL.Variant({
  system_: IDL.Null,
  user: IDL.Null,
  assistant: IDL.Null,
});

const ExternalModel = IDL.Variant({
  Claude_Sonnet: IDL.Null,
  Claude_Haiku: IDL.Null,
  GPT4o: IDL.Null,
  GPT4oMini: IDL.Null,
  MagickMind_Brain: IDL.Null,
});

const OnChainModel = IDL.Variant({
  Llama3_1_8B: IDL.Null,
  Llama4Scout: IDL.Null,
  Qwen3_32B: IDL.Null,
});

const Model = IDL.Variant({
  External: ExternalModel,
  OnChain: OnChainModel,
});

const ConversationId = IDL.Text;

const Message = IDL.Record({
  role: Role,
  content: IDL.Text,
});

const Conversation = IDL.Record({
  id: ConversationId,
  owner: IDL.Principal,
  model: Model,
  messages: IDL.Vec(Message),
  createdAt: IDL.Int,
  updatedAt: IDL.Int,
});

const ConversationSummary = IDL.Record({
  id: ConversationId,
  model: Model,
  messageCount: IDL.Nat,
  updatedAt: IDL.Int,
});

const PromptRequest = IDL.Record({
  message: IDL.Text,
  model: Model,
  conversationId: IDL.Opt(ConversationId),
  systemPrompt: IDL.Opt(IDL.Text),
  apiKey: IDL.Opt(IDL.Text),
});

const PromptResponse = IDL.Record({
  reply: IDL.Text,
  conversationId: ConversationId,
  model: Model,
  tokensUsed: IDL.Opt(IDL.Nat),
});

const OpenClawError = IDL.Variant({
  NotAuthenticated: IDL.Null,
  ConversationNotFound: IDL.Null,
  AlreadyProcessing: IDL.Null,
  CycleBudgetExceeded: IDL.Null,
  ResponseTooLarge: IDL.Null,
  Timeout: IDL.Null,
  InvalidInput: IDL.Text,
  ApiKeyNotFound: IDL.Text,
  ProviderError: IDL.Text,
});

const Result = IDL.Variant({ ok: PromptResponse, err: OpenClawError });
const Result_1 = IDL.Variant({
  ok: IDL.Vec(ConversationSummary),
  err: OpenClawError,
});
const Result_2 = IDL.Variant({ ok: Conversation, err: OpenClawError });
const Result_3 = IDL.Variant({ ok: IDL.Null, err: OpenClawError });

// ── IDL factory ─────────────────────────────────────────────────────

export const idlFactory: IDL.InterfaceFactory = ({ IDL: _IDL }) => {
  return IDL.Service({
    prompt: IDL.Func([PromptRequest], [Result], []),
    getConversation: IDL.Func([ConversationId], [Result_2], ["query"]),
    listConversations: IDL.Func([], [Result_1], ["query"]),
    deleteConversation: IDL.Func([ConversationId], [Result_3], []),
    health: IDL.Func([], [IDL.Text], ["query"]),
  });
};

// ── TypeScript types (mirrors the Candid types) ─────────────────────

export type CandidRole = { system_: null } | { user: null } | { assistant: null };

export type CandidExternalModel =
  | { Claude_Sonnet: null }
  | { Claude_Haiku: null }
  | { GPT4o: null }
  | { GPT4oMini: null }
  | { MagickMind_Brain: null };

export type CandidOnChainModel =
  | { Llama3_1_8B: null }
  | { Llama4Scout: null }
  | { Qwen3_32B: null };

export type CandidModel =
  | { External: CandidExternalModel }
  | { OnChain: CandidOnChainModel };

export interface CandidPromptRequest {
  message: string;
  model: CandidModel;
  conversationId: [] | [string];
  systemPrompt: [] | [string];
  apiKey: [] | [string];
}

export interface CandidPromptResponse {
  reply: string;
  conversationId: string;
  model: CandidModel;
  tokensUsed: [] | [bigint];
}

export type CandidOpenClawError =
  | { NotAuthenticated: null }
  | { ConversationNotFound: null }
  | { AlreadyProcessing: null }
  | { CycleBudgetExceeded: null }
  | { ResponseTooLarge: null }
  | { Timeout: null }
  | { InvalidInput: string }
  | { ApiKeyNotFound: string }
  | { ProviderError: string };

export type CandidResult<T> = { ok: T } | { err: CandidOpenClawError };

export interface GatewayService {
  prompt: (req: CandidPromptRequest) => Promise<CandidResult<CandidPromptResponse>>;
  getConversation: (id: string) => Promise<CandidResult<unknown>>;
  listConversations: () => Promise<CandidResult<unknown[]>>;
  deleteConversation: (id: string) => Promise<CandidResult<null>>;
  health: () => Promise<string>;
}

// ── Actor helper ────────────────────────────────────────────────────

export function createGatewayActor(
  agent: HttpAgent,
  canisterId?: string,
): ActorSubclass<GatewayService> {
  return Actor.createActor<GatewayService>(idlFactory, {
    agent,
    canisterId: canisterId ?? GATEWAY_CANISTER_ID,
  });
}
