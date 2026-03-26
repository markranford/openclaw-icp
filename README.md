# OpenClaw ICP

**The first fully decentralized AI agent platform, built natively on the Internet Computer.**

OpenClaw ICP reimagines what an AI agent platform can be when every component — from LLM inference to credential storage to payments — runs on a public blockchain with no centralized servers, no single points of failure, and no trust assumptions.

---

## What Is This?

OpenClaw ICP is an open-source AI agent platform that sits entirely on the [Internet Computer Protocol (ICP)](https://internetcomputer.org). Users interact with multiple LLM providers through a single interface, with their API keys encrypted on-chain using threshold cryptography, their conversations persisted in canister smart contracts, and their payments handled through native ICP tokens.

Unlike traditional AI agent frameworks that run on your laptop and route everything through a central WebSocket gateway, OpenClaw ICP runs on a decentralized subnet of 13+ nodes. There is no server to hack, no gateway to hijack, and no marketplace where malicious skills can steal your credentials.

---

## What Makes It Unique

### Fully On-Chain Architecture

Every component runs as a **canister smart contract** on ICP:

- **No servers.** The backend is 4 Motoko canisters deployed to a globally distributed subnet. There is no EC2 instance, no Docker container, no VPS to maintain.
- **No WebSocket gateway.** Communication happens through ICP's consensus-verified inter-canister calls, not through an unauthenticated WebSocket that anyone can hijack.
- **No centralized credential store.** API keys are encrypted client-side using vetKD (verifiable encrypted threshold key derivation) before being stored on-chain. Not even the subnet nodes can read your secrets.
- **No skill marketplace supply chain.** LLM routing is handled by auditable Motoko code in the Gateway canister, not by downloading untrusted third-party plugins.

### Security by Architecture, Not by Policy

The original OpenClaw framework has documented vulnerabilities:

| Vulnerability | OpenClaw | OpenClaw ICP |
|--------------|----------|--------------|
| **341 malicious skills** in ClawHub marketplace stealing credentials and installing malware | Skills marketplace with no code review | No plugin marketplace. LLM routing is in auditable canister code. |
| **CVE-2026-25253** — one-click RCE via WebSocket hijacking (CVSS 8.8, 40K+ exposed instances) | Centralized WebSocket gateway with no origin validation | No WebSocket. Canister calls are authenticated by ICP consensus. |
| **Credential theft** from `~/.clawdbot/.env` via malicious skills | Plaintext credentials on local filesystem | vetKD-encrypted on-chain storage. Keys encrypted client-side with AES-256-GCM before touching the blockchain. |
| **Single point of failure** — gateway crash takes down everything | Single-process Node.js daemon | 13-node subnet consensus. Canister survives individual node failures. |

### Multi-Provider LLM Routing

A single prompt request can be routed to any of three provider categories:

```
User prompt
    |
    +---> On-Chain (Free)      : Llama 3.1 8B, Qwen 3 32B, Llama 4 Scout
    |                            Direct canister-to-canister call via mo:llm
    |
    +---> External (API Key)   : Claude Sonnet, Claude Haiku, GPT-4o, GPT-4o Mini
    |                            HTTPS outcalls with transform functions for consensus
    |
    +---> MagickMind (Brain)   : Multi-LLM synthesis with memory & personality
                                 REST API via HTTPS outcalls
```

On-chain models are **free** — no API key, no payment, no rate limits. They run on ICP's DeAI infrastructure and are available to any canister.

---

## High-Level Architecture

```
                    Internet Identity (Passkey Auth)
                              |
    [React Frontend] -------> [Gateway Canister] ------> DFINITY LLM (on-chain)
         (asset)                   |    |
                                   |    +--------------> Anthropic API (HTTPS outcall)
                                   |    +--------------> OpenAI API   (HTTPS outcall)
                                   |    +--------------> MagickMind   (HTTPS outcall)
                                   |
                             [KeyVault Canister]         vetKD-encrypted credentials
                                   |
                             [Wallet Canister]           ICP + ckBTC + ckUSDC
                                   |
                             [Identity Canister]         Agent profiles + reputation
```

### The Five Canisters

| Canister | Purpose | Status |
|----------|---------|--------|
| **Gateway** | Core orchestrator: auth, conversation management, LLM routing via `mo:llm` and HTTPS outcalls, reentrancy protection | Implemented |
| **KeyVault** | vetKD key derivation endpoints + encrypted credential storage. Only the Gateway canister can retrieve stored keys. | Implemented |
| **Wallet** | Per-user token balances (ICP, ckBTC, ckUSDC) with transaction history and pay-per-request billing | Stub (Phase 3) |
| **Identity** | Agent profile registry with reputation tracking and prompt counters | Stub (Phase 4) |
| **Frontend** | React + TypeScript SPA served from an ICP asset canister | Implemented |

---

## What OpenClaw ICP Provides Beyond OpenClaw

### Everything OpenClaw Does

- Multi-model chat with conversation history
- System prompts and conversation threading
- Multiple LLM provider support (Anthropic, OpenAI)
- Credential management for API keys
- Extensible agent framework

### What OpenClaw ICP Adds

| Capability | Description |
|-----------|-------------|
| **On-chain LLM inference** | Free Llama/Qwen models running directly on ICP. No API key needed. |
| **Threshold-encrypted credentials** | API keys encrypted with vetKD before on-chain storage. Node operators cannot read them. |
| **Decentralized payments** | Native ICP, ckBTC, and ckUSDC token support for pay-per-request billing. |
| **Agent identity** | On-chain profiles with reputation scores, tracked via ICRC-7 NFT credentials. |
| **MagickMind integration** | Multi-LLM brain synthesis with persistent memory and personality engines. |
| **No single point of failure** | Runs on a 13-node subnet with BFT consensus. Survives node failures. |
| **Tamper-proof conversations** | Chat history persisted in canister stable memory. Cannot be altered without consensus. |
| **Reverse gas model** | Users never pay gas. The app developer funds compute via cycles. |
| **Censorship resistance** | Deployed to a decentralized subnet. No single entity can shut it down. |
| **Open governance path** | Can be handed to an SNS DAO for community-controlled governance. |

---

## The ICP Advantage

The Internet Computer Protocol provides unique capabilities that make this architecture possible:

### Free On-Chain LLM Inference

ICP's DeAI infrastructure runs Llama 3.1 8B, Qwen 3 32B, and Llama 4 Scout directly on subnet nodes. Any canister can call these models with a single inter-canister call — no API key, no HTTP request, no payment. The `mo:llm` Motoko library makes this a three-line integration:

```motoko
let response = await LLM.chat(#Llama3_1_8B)
  .withMessages(chatMessages)
  .send();
```

### HTTPS Outcalls with Consensus

When a canister needs to call an external API (Anthropic, OpenAI, MagickMind), all 13 subnet nodes execute the same HTTP request independently. A transform function strips non-deterministic headers so nodes reach consensus on the response. This means external API calls are verified by the entire subnet — no single node can fabricate a response.

### vetKD (Verifiable Encrypted Threshold Keys)

ICP's threshold key infrastructure enables a pattern impossible on other blockchains: **client-side encryption where the key is derived from the blockchain itself**. The flow:

1. Frontend generates an ephemeral transport keypair
2. KeyVault canister calls `vetkd_derive_key` — the subnet's threshold nodes cooperate to derive a key specific to (canister, context, user principal)
3. The derived key is encrypted under the transport public key and returned
4. Frontend decrypts with the transport secret, derives an AES-256-GCM key
5. API keys are encrypted locally and stored on-chain as ciphertext

No single node ever sees the raw key. No node operator can decrypt your credentials. The key is deterministic — the same user always derives the same key, so encrypted data can be decrypted across sessions.

### Reverse Gas Model

On Ethereum, users pay gas for every transaction. On ICP, **the application pays**. Users interact with OpenClaw ICP without ever holding ICP tokens or paying fees. The developer loads the canisters with cycles (1 trillion cycles = ~$1.30), and the canisters burn cycles as they process requests. This removes the biggest barrier to Web3 adoption: requiring users to hold cryptocurrency before they can use an app.

### Canister Smart Contracts

Unlike Ethereum smart contracts (which are stateless execution units that read/write to a global state trie), ICP canisters are **stateful actors with their own persistent memory**. Each canister holds up to 4 GB of heap memory and 400 GB of stable memory. Conversations, API keys, wallet balances, and agent profiles all live inside the canisters — no external database needed.

### Subnet Consensus

Every update call (prompt, key storage, profile creation) is processed by all 13 nodes on the subnet and must reach BFT consensus before the state change is committed. This means:

- No single node can fabricate responses
- State changes are tamper-proof
- The system tolerates up to 4 malicious nodes without compromise

---

## The MagickMind Advantage

[MagickMind](https://magickmind.ai) is integrated as a first-class provider alongside Anthropic and OpenAI, but it offers capabilities that single-model providers cannot:

### Multi-LLM Brains

MagickMind synthesizes perspectives from multiple LLMs simultaneously into unified responses that surpass any single model. Instead of choosing between Claude or GPT, MagickMind harnesses both (and more) to produce higher-quality outputs.

### Persistent Memory Engine

Unlike stateless API calls to Claude or OpenAI where each request starts fresh, MagickMind maintains **episodic and semantic memory** across sessions. Conversations and patterns are automatically retained, creating agents that learn and improve over time.

### Personality Engine

MagickMind allows defining personality traits with specific boundaries. Agents grow and learn from interactions while maintaining their core identity — enabling specialized assistants (legal advisor, coding mentor, creative writer) that stay in character across conversations.

### Mindspaces

MagickMind organizes work into **mindspaces** — isolated conversation contexts that maintain their own history, memory, and knowledge base. Each mindspace can have its own persona, documents, and behavioral rules.

### Knowledge Grounding

Automatic document and data connection without complex RAG setup. Knowledge grounding reduces AI hallucinations by anchoring responses to your specific documents and data.

### OpenAI-Compatible API

MagickMind's API is OpenAI-compatible, making integration straightforward. OpenClaw ICP routes to MagickMind via the same HTTPS outcall pattern used for other providers:

```
POST https://api.magickmind.ai/v1/magickmind/chat
{
  "api_key": "...",
  "message": "...",
  "chat_id": "...",
  "sender_id": "<user-principal>",
  "mindspace_id": "default"
}
```

MagickMind is currently **free during beta** — no credit card required.

---

## Detailed Code Walkthrough

### Backend: Motoko Canisters

#### Gateway Canister (`src/gateway/main.mo`)

The Gateway is the central orchestrator. It receives prompt requests from the frontend, authenticates the caller, manages conversations, and routes to the appropriate LLM provider.

**Key design decisions:**

- **Actor class with deployer capture**: `persistent actor class Gateway(deployer : Principal)` — the deployer's principal is captured at construction time and used as the immutable admin. No first-caller-wins race condition.
- **Reentrancy guard with `finally`**: The `CallerGuard` prevents a user from sending a second prompt while their first is still processing (which could corrupt conversation state across `await` points). The guard is released in a `finally` block to prevent permanent lockout on callback traps.
- **Storage limits**: Max 100 conversations per user, 200 messages per conversation. Prevents heap exhaustion attacks.
- **Transform function**: Defined as `shared query` on the actor (not in a module) because ICP requires transform functions to be actor methods. Strips all response headers for HTTPS outcall consensus.

#### Types Module (`src/gateway/Types.mo`)

Canonical type definitions shared across all canisters:

- **Model variants**: `#OnChain(#Llama3_1_8B | #Qwen3_32B | #Llama4Scout)` and `#External(#Claude_Sonnet | #Claude_Haiku | #GPT4o | #GPT4oMini | #MagickMind_Brain)`
- **Role uses `#system_`**: Motoko reserves `system` as a keyword, so the variant is `#system_`. The frontend Candid bindings must use `system_` (not `system`) to match.
- **Error variants**: Rich typed errors (`#NotAuthenticated`, `#ProviderError(Text)`, `#ApiKeyNotFound(Text)`, etc.) instead of string errors.

#### LLM Router (`src/gateway/LlmRouter.mo`)

Routes prompts based on the model variant:

- **On-chain routing**: Calls `LLM.chat(model).withMessages(chatMessages).send()` via the `mo:llm` library. This makes a direct inter-canister call to the DFINITY LLM canister (`w36hm-eqaaa-aaaal-qr76a-cai`).
- **External routing**: Delegates to `HttpOutcalls.callAnthropic()`, `callOpenAI()`, or `callMagickMind()` based on the provider. Passes idempotency keys for request deduplication.
- **Provider key mapping**: `providerKeyId()` maps model variants to KeyVault key IDs (`"anthropic_api_key"`, `"openai_api_key"`, `"magickmind_api_key"`).

#### HTTPS Outcalls (`src/gateway/HttpOutcalls.mo`)

Builds and executes HTTPS POST requests to external LLM APIs:

- **JSON construction**: Manual string building (no JSON library needed). The `escapeJson()` function handles special characters using `Char.toNat32()` comparisons since Motoko doesn't support escape sequences in char literals.
- **Response parsing**: `extractJsonStringAfter()` splits on a key pattern (e.g., `"text":"`) and extracts the value up to the next unescaped closing quote. Simple but sufficient for the structured JSON responses from LLM APIs.
- **Cycle management**: Uses `Call.httpRequest()` from `mo:ic` which auto-computes and attaches the required cycles (~1.1B per call).
- **Idempotency**: Every POST includes an `Idempotency-Key` header since all 13 subnet nodes execute the same request independently.
- **`max_response_bytes`**: Set to 100KB (not the 2MB default) to reduce cycle costs by ~20x.

#### Auth Module (`src/gateway/Auth.mo`)

- **`requireAuth(caller)`**: Rejects the anonymous principal. Called at the top of every shared function.
- **`CallerGuard`**: A mutable map of principals currently being processed. `acquire()` fails if the principal is already in the map; `release()` removes it. Must always be called in a `finally` block.

#### KeyVault Canister (`src/keyvault/main.mo`)

Encrypted credential storage with vetKD integration:

- **`getVetkeyVerificationKey()`**: Returns the canister's vetKD public key (derived for context `"openclaw_keyvault_v1"`). Anyone can call this — it's a public key used for client-side verification.
- **`getEncryptedVetkey(transportPublicKey)`**: Derives a vetKey specific to the caller's principal, encrypted under the transport public key. Attaches 10B cycles for `test_key_1`.
- **`getEncryptedVetkeyForUser()`**: Same as above but callable only by the Gateway canister, for any user principal. Enables server-side key derivation.
- **Storage limits**: Max 20 keys per user, 4KB max per encrypted blob.

#### Wallet Canister (`src/wallet/main.mo`)

Per-user token balance tracking (stub for Phase 3):

- **Triple token support**: ICP, ckBTC, ckUSDC balances tracked in e8s (smallest unit).
- **`deductForRequest()`**: Gateway-only function to deduct tokens for external LLM calls. Enforces sufficient balance before deduction.
- **Transaction history**: Append-only log per user with timestamps and counterparty tracking.

#### Identity Canister (`src/identity/main.mo`)

Agent profile registry (stub for Phase 4):

- **`upsertProfile()`**: Create or update agent profile with display name, description, and capabilities array.
- **`incrementPromptCount()`**: Gateway-only function to track usage. Gated by `gatewayPrincipal` check.
- **Reputation tracking**: `reputation` and `totalPrompts` fields for future scoring systems.

### Frontend: React + TypeScript

#### Authentication (`src/frontend/src/auth/useAuth.tsx`)

Dual-mode authentication:

- **Production (mainnet)**: Internet Identity via `@icp-sdk/auth/client`. Passkey/biometric login with 8-hour session delegation.
- **Development (local)**: Ed25519 identity generated and persisted in `localStorage`. Instant login with no II popup. The `isLocal()` check detects `localhost` or `.localhost` hostnames.

#### Agent Factory (`src/frontend/src/api/agent.ts`)

Creates authenticated `HttpAgent` instances:

- **Dev mode**: Reads the Ed25519 identity from `localStorage` and creates an agent with it. Calls `fetchRootKey()` for the local replica.
- **Production**: Uses the AuthClient identity from Internet Identity.
- **Canister IDs**: Injected via `VITE_*` environment variables at build time.

#### vetKD Client (`src/frontend/src/api/vetkeys.ts`)

Client-side encryption using ICP's threshold key infrastructure:

1. **`deriveAesKey(agent)`**: Full vetKD flow — generate transport keypair, request encrypted vetKey from KeyVault, decrypt with transport secret, derive AES-256-GCM key via `toDerivedKeyMaterial()`.
2. **`encryptWithVetKey(plaintext, aesKey)`**: AES-GCM encrypt with random 12-byte IV prepended to ciphertext.
3. **`decryptWithVetKey(encryptedData, aesKey)`**: Extract IV, decrypt with AES-GCM.

**Critical implementation detail**: The `input` passed to `decryptAndVerify()` must be the caller's principal bytes (`identity.getPrincipal().toUint8Array()`) — this must match exactly what the canister uses as `Principal.toBlob(msg.caller)` in `vetkd_derive_key`.

#### Candid Bindings (`src/frontend/src/api/gateway.did.ts`, `keyvault.did.ts`)

Hand-written IDL factories and TypeScript type mirrors for the Gateway and KeyVault canisters. These define the Candid encoding/decoding for all canister calls.

**Important**: The `Role` variant uses `system_` (with trailing underscore) in both the IDL and TypeScript types, matching Motoko's convention of avoiding the `system` reserved keyword.

#### Chat Interface (`src/frontend/src/chat/`)

- **`ChatPage.tsx`**: Orchestrates the prompt flow — builds `CandidPromptRequest`, calls `gateway.prompt()`, displays the response. Tracks conversation ID across messages.
- **`ModelSelector.tsx`**: Grouped dropdown with three categories (On-Chain Free, External API Key, MagickMind).
- **`MessageList.tsx`**: Role-based bubble styling with auto-scroll and loading indicator.
- **`InputBar.tsx`**: Auto-expanding textarea with Enter-to-send and Shift+Enter for newlines.

#### Settings Page (`src/frontend/src/settings/SettingsPage.tsx`)

API key management with vetKD encryption:

- On mount: checks `hasKey()` for each provider and attempts vetKD key derivation
- Save: encrypts with AES-256-GCM if vetKD is available, falls back to plaintext for local dev
- Dynamic security indicator: shows "vetKD encryption active" on mainnet, "Local dev mode" locally
- Three providers: Anthropic (Claude), OpenAI (GPT), MagickMind

### Configuration

| File | Purpose |
|------|---------|
| `dfx.json` | Canister definitions with init arg files for deployer principal |
| `mops.toml` | Motoko dependencies: `base@0.16.0`, `llm@2.1.0`, `ic@3.2.0` |
| `package.json` | Node workspace with frontend build scripts |
| `init_args/*.txt` | Deployer principal passed to actor class constructors |
| `.claude/launch.json` | Dev server configuration for local development |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) v22+
- [WSL (Ubuntu)](https://learn.microsoft.com/en-us/windows/wsl/) on Windows
- [dfx](https://internetcomputer.org/docs/building-apps/getting-started/install) v0.31+
- [mops](https://mops.one) (Motoko package manager)

### Local Development

```bash
# Clone the repo
git clone https://github.com/markranford/openclaw-icp.git
cd openclaw-icp

# Install dependencies
mops install
cd src/frontend && npm install && cd ../..

# Start local replica (in tmux for persistence)
tmux new-session -d -s dfx "dfx start --clean"

# Deploy all canisters
dfx deploy

# Wire Gateway <-> KeyVault authorization
dfx canister call keyvault setGateway '(principal "<gateway-canister-id>")'
dfx canister call gateway setKeyVault '(principal "<keyvault-canister-id>")'

# Start frontend dev server
cd src/frontend && npm run dev
```

### Mainnet Deployment

```bash
# Get cycles (requires ICP tokens)
dfx cycles convert --amount 5

# Deploy to mainnet
dfx deploy --network ic

# Wire canisters on mainnet
dfx canister call keyvault setGateway '(principal "<gateway-id>")' --network ic
dfx canister call gateway setKeyVault '(principal "<keyvault-id>")' --network ic
```

---

## Roadmap

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Project skeleton, on-chain LLM chat, conversation CRUD | Done |
| 2 | External LLM routing (Anthropic, OpenAI, MagickMind), vetKD encryption, Settings page | Done |
| 3 | Wallet (ICRC-1/2 tokens, pay-per-request billing, DEX integration) | Planned |
| 4 | Identity (ICRC-7 NFT credentials, reputation, Kinic vector memory) | Planned |
| 5 | Email (moltmail decentralized + SendGrid traditional) | Planned |
| 6 | DEX integration (KongSwap, ICPSwap) | Planned |
| 7 | Ecosystem (OpenChat notifications, ELNA marketplace, CycleOps monitoring) | Planned |
| 8 | SNS DAO governance + mainnet production launch | Planned |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart contracts | Motoko (ICP-native) |
| Frontend | React 18 + TypeScript + Vite |
| Auth | Internet Identity (passkeys) |
| Encryption | vetKD + AES-256-GCM |
| On-chain LLM | `mo:llm` (Llama 3.1 8B, Qwen 3 32B, Llama 4 Scout) |
| External LLM | HTTPS outcalls (Anthropic, OpenAI, MagickMind) |
| Tokens | ICRC-1/2 (ICP, ckBTC, ckUSDC) |
| Package manager | mops (Motoko), npm (frontend) |
| Deployment | dfx CLI |

---

## License

MIT

---

Built on the [Internet Computer](https://internetcomputer.org) by the OpenClaw community.
