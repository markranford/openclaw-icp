/// OpenClaw ICP — Shared types used across canisters
module {

  // ── LLM Provider & Model Types ──────────────────────────────────

  public type Provider = {
    #OnChain;
    #Anthropic;
    #OpenAI;
  };

  public type OnChainModel = {
    #Llama3_1_8B;
    #Qwen3_32B;
    #Llama4Scout;
  };

  public type ExternalModel = {
    #Claude_Sonnet;
    #Claude_Haiku;
    #GPT4o;
    #GPT4oMini;
    #MagickMind_Brain;
  };

  public type Model = {
    #OnChain : OnChainModel;
    #External : ExternalModel;
  };

  // ── Chat Message Types ──────────────────────────────────────────

  public type Role = {
    #system_;
    #user;
    #assistant;
  };

  public type Message = {
    role : Role;
    content : Text;
  };

  // ── Conversation Types ──────────────────────────────────────────

  public type ConversationId = Text;

  public type Conversation = {
    id : ConversationId;
    owner : Principal;
    model : Model;
    messages : [Message];
    createdAt : Int;
    updatedAt : Int;
  };

  public type ConversationSummary = {
    id : ConversationId;
    model : Model;
    updatedAt : Int;
    messageCount : Nat;
  };

  // ── Request / Response Types ────────────────────────────────────

  public type PromptRequest = {
    conversationId : ?ConversationId;
    model : Model;
    message : Text;
    systemPrompt : ?Text;
    apiKey : ?Text; // Optional: frontend passes decrypted API key for external models
  };

  public type PromptResponse = {
    conversationId : ConversationId;
    reply : Text;
    model : Model;
    tokensUsed : ?Nat;
  };

  // ── Error Types ─────────────────────────────────────────────────

  public type OpenClawError = {
    #NotAuthenticated;
    #ConversationNotFound;
    #ProviderError : Text;
    #ApiKeyNotFound : Text;
    #CycleBudgetExceeded;
    #ResponseTooLarge;
    #Timeout;
    #AlreadyProcessing;
    #InvalidInput : Text;
  };

  // ── Email Types ─────────────────────────────────────────────────

  public type EmailProvider = {
    #Moltmail;
    #SendGrid;
  };

  public type EmailMessage = {
    to : Text;
    subject : Text;
    body : Text;
    isHtml : Bool;
    provider : EmailProvider;
  };

  public type EmailTemplate = {
    id : Text;
    name : Text;
    subject : Text;
    htmlBody : Text;
    createdAt : Int;
    updatedAt : Int;
  };

  // ── Wallet Types ────────────────────────────────────────────────

  public type TokenType = {
    #ICP;
    #ckUSDC;
    #ckBTC;
  };

  public type TransactionRecord = {
    id : Nat;
    tokenType : TokenType;
    amount : Nat;
    direction : { #Incoming; #Outgoing };
    counterparty : ?Principal;
    memo : ?Text;
    timestamp : Int;
  };

  // ── Identity Types ──────────────────────────────────────────────

  public type AgentProfile = {
    owner : Principal;
    displayName : Text;
    description : Text;
    capabilities : [Text];
    reputation : Nat;
    totalPrompts : Nat;
    createdAt : Int;
    updatedAt : Int;
  };
}
