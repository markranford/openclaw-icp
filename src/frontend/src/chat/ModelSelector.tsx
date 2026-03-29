/**
 * @file Dropdown selector for choosing an LLM model in the chat view.
 *
 * Models are organized into three categories displayed as `<optgroup>` sections:
 *
 * 1. **On-Chain (Free)** — Models that run inference directly on the Internet
 *    Computer (e.g. Llama, Qwen). No API key required; costs are paid in cycles.
 * 2. **External (API Key Required)** — Cloud-hosted models (Claude, GPT) that
 *    the gateway canister proxies via HTTPS outcalls. Requires an API key
 *    stored in KeyVault.
 * 3. **MagickMind** — Multi-LLM orchestration with memory and personality.
 *    Uses an external API key.
 *
 * ## Serialization
 *
 * The HTML `<select>` element requires string values, but the app's `Model`
 * type is a discriminated union (`{ OnChain: string } | { External: string }`).
 * Two helper functions handle the conversion:
 * - {@link modelToKey} — Serializes `Model` to `"OnChain:Llama3_1_8B"` format.
 * - {@link keyToModel} — Deserializes the string back to a `Model` object.
 *
 * @module chat/ModelSelector
 */

import type { Model } from "./ChatPage";

/**
 * Props for the {@link ModelSelector} component.
 *
 * @property model - The currently selected model.
 * @property onChange - Callback when the user picks a different model.
 */
interface ModelSelectorProps {
  model: Model;
  onChange: (model: Model) => void;
}

/**
 * Static registry of all available models with display labels and categories.
 * To add a new model, append an entry here and ensure the corresponding variant
 * exists in the gateway canister's Candid interface.
 */
const MODEL_OPTIONS: { label: string; value: Model; category: string }[] = [
  // On-chain (free, no API key needed)
  { label: "Llama 3.1 8B", value: { OnChain: "Llama3_1_8B" }, category: "On-Chain (Free)" },
  { label: "Qwen 3 32B", value: { OnChain: "Qwen3_32B" }, category: "On-Chain (Free)" },
  { label: "Llama 4 Scout", value: { OnChain: "Llama4Scout" }, category: "On-Chain (Free)" },
  // External (requires API key)
  { label: "Claude Sonnet", value: { External: "Claude_Sonnet" }, category: "External (API Key)" },
  { label: "Claude Haiku", value: { External: "Claude_Haiku" }, category: "External (API Key)" },
  { label: "GPT-4o", value: { External: "GPT4o" }, category: "External (API Key)" },
  { label: "GPT-4o Mini", value: { External: "GPT4oMini" }, category: "External (API Key)" },
  // MagickMind (multi-LLM brains + memory + personality)
  { label: "MagickMind Brain", value: { External: "MagickMind_Brain" }, category: "MagickMind" },
];

/**
 * Serialize a {@link Model} discriminated union into a string key for the `<select>` value.
 *
 * @example
 * modelToKey({ OnChain: "Llama3_1_8B" }) // "OnChain:Llama3_1_8B"
 * modelToKey({ External: "Claude_Sonnet" }) // "External:Claude_Sonnet"
 */
function modelToKey(m: Model): string {
  if ("OnChain" in m) return `OnChain:${m.OnChain}`;
  return `External:${m.External}`;
}

/**
 * Deserialize a string key (from the `<select>` value) back into a {@link Model} object.
 *
 * @example
 * keyToModel("OnChain:Llama3_1_8B") // { OnChain: "Llama3_1_8B" }
 */
function keyToModel(key: string): Model {
  const [type, name] = key.split(":");
  if (type === "OnChain") return { OnChain: name as any };
  return { External: name as any };
}

/**
 * Dropdown `<select>` element for choosing an LLM model.
 * Models are grouped by category using `<optgroup>`.
 */
export default function ModelSelector({ model, onChange }: ModelSelectorProps) {
  const currentKey = modelToKey(model);

  return (
    <select
      value={currentKey}
      onChange={(e) => onChange(keyToModel(e.target.value))}
      style={{
        backgroundColor: "var(--bg-tertiary)",
        color: "var(--text-primary)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        padding: "0.4rem 0.75rem",
        fontSize: "0.85rem",
        outline: "none",
        cursor: "pointer",
      }}
    >
      {/* Group by category */}
      <optgroup label="On-Chain (Free)">
        {MODEL_OPTIONS.filter((o) => o.category.startsWith("On-Chain")).map((opt) => (
          <option key={modelToKey(opt.value)} value={modelToKey(opt.value)}>
            {opt.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="External (API Key Required)">
        {MODEL_OPTIONS.filter((o) => o.category === "External (API Key)").map((opt) => (
          <option key={modelToKey(opt.value)} value={modelToKey(opt.value)}>
            {opt.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="MagickMind (Multi-LLM + Memory)">
        {MODEL_OPTIONS.filter((o) => o.category === "MagickMind").map((opt) => (
          <option key={modelToKey(opt.value)} value={modelToKey(opt.value)}>
            {opt.label}
          </option>
        ))}
      </optgroup>
    </select>
  );
}
