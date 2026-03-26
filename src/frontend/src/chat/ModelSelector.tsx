import type { Model } from "./ChatPage";

interface ModelSelectorProps {
  model: Model;
  onChange: (model: Model) => void;
}

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

function modelToKey(m: Model): string {
  if ("OnChain" in m) return `OnChain:${m.OnChain}`;
  return `External:${m.External}`;
}

function keyToModel(key: string): Model {
  const [type, name] = key.split(":");
  if (type === "OnChain") return { OnChain: name as any };
  return { External: name as any };
}

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
