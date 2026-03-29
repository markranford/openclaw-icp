/**
 * @file Advanced persona traits panel with granular sliders, growth config,
 * Multi-LLM settings, and evolution history.
 *
 * Embedded into PersonaBuilder when a persona is selected and the "Advanced Traits"
 * tab is active. Supports Numeric (slider), Categorical (dropdown), and Multilabel
 * (checkboxes) trait types. Traits are grouped by category.
 *
 * @module persona/PersonaTraitsPanel
 */

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import {
  createGatewayActor,
  type CandidPersonaTrait,
  type CandidPersonaTraits,
  type CandidTraitSnapshot,
  type CandidGrowthConfig,
  type CandidGrowthType,
  type CandidMultiLlmConfig,
  type CandidTraitType,
  type CandidTraitLock,
} from "../api/gateway.did";

interface PersonaTraitsPanelProps {
  personaId: string;
  personaName: string;
  isBuiltIn: boolean;
}

/** Default trait definitions with the full MagickMind-aligned fields. */
const DEFAULT_TRAITS: {
  name: string;
  displayName: string;
  description: string;
  leftLabel: string;
  rightLabel: string;
  category: string;
}[] = [
  { name: "creativity", displayName: "Creativity", description: "How inventive and original the responses are", leftLabel: "Conventional", rightLabel: "Unconventional", category: "personality" },
  { name: "empathy", displayName: "Empathy Level", description: "Emotional awareness and sensitivity", leftLabel: "Objective", rightLabel: "Empathetic", category: "personality" },
  { name: "curiosity", displayName: "Curiosity", description: "Tendency to ask questions and explore ideas", leftLabel: "Accepting", rightLabel: "Inquisitive", category: "personality" },
  { name: "formality", displayName: "Formality", description: "Level of formal vs casual communication", leftLabel: "Casual", rightLabel: "Formal", category: "communication" },
  { name: "humor", displayName: "Humor", description: "Use of wit, jokes, and playful language", leftLabel: "Serious", rightLabel: "Playful", category: "communication" },
  { name: "detail", displayName: "Detail Level", description: "Depth and thoroughness of explanations", leftLabel: "Concise", rightLabel: "Thorough", category: "communication" },
  { name: "directness", displayName: "Directness", description: "How straightforward vs exploratory", leftLabel: "Exploratory", rightLabel: "Direct", category: "behavior" },
  { name: "technical", displayName: "Technical Depth", description: "Complexity of language and concepts used", leftLabel: "Simple", rightLabel: "Technical", category: "behavior" },
];

const LABEL_MAP: Record<string, { left: string; right: string }> = {};
for (const t of DEFAULT_TRAITS) {
  LABEL_MAP[t.name] = { left: t.leftLabel, right: t.rightLabel };
}

/** Category display configuration. */
const CATEGORY_CONFIG: Record<string, { label: string; color: string }> = {
  personality: { label: "Personality", color: "#6366f1" },
  communication: { label: "Communication", color: "#14b8a6" },
  behavior: { label: "Behavior", color: "#f59e0b" },
};

/** Growth type display configuration. */
const GROWTH_TYPES: { key: string; label: string; color: string; description: string }[] = [
  { key: "Fixed", label: "Fixed", color: "#6b7280", description: "No change over time" },
  { key: "Expanding", label: "Expanding", color: "#22c55e", description: "Grows and develops" },
  { key: "Corrupting", label: "Corrupting", color: "#ef4444", description: "Degrades over time" },
  { key: "Redeeming", label: "Redeeming", color: "#3b82f6", description: "Improves through interaction" },
  { key: "Transcending", label: "Transcending", color: "#a855f7", description: "Evolves beyond bounds" },
];

/** Local trait representation with number values for slider/UI interaction. */
interface LocalTrait {
  name: string;
  displayName: string;
  traitType: "Numeric" | "Categorical" | "Multilabel";
  value: number;
  description: string;
  categoricalValue: string;
  multilabelValue: string[];
  options: string[];
  minValue: number;
  maxValue: number;
  defaultValue: number;
  lock: "Hard" | "Soft";
  learningRate: number;
  supportsDyadic: boolean;
  category: string;
}

function getSliderColor(value: number): string {
  if (value > 60) return "#22c55e";
  if (value < 40) return "#f59e0b";
  return "#6366f1";
}

function formatTimestamp(ns: bigint): string {
  const ms = Number(ns) / 1_000_000;
  const date = new Date(ms);
  const now = Date.now();
  const diffSec = Math.floor((now - ms) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return date.toLocaleDateString();
}

/** Convert a CandidPersonaTrait to a LocalTrait. */
function candidToLocal(t: CandidPersonaTrait): LocalTrait {
  const traitType: "Numeric" | "Categorical" | "Multilabel" =
    "Numeric" in t.traitType ? "Numeric" :
    "Categorical" in t.traitType ? "Categorical" : "Multilabel";
  const lock: "Hard" | "Soft" = "Hard" in t.lock ? "Hard" : "Soft";
  return {
    name: t.name,
    displayName: t.displayName,
    traitType,
    value: t.numericValue.length > 0 ? Number(t.numericValue[0]) : Number(t.defaultValue),
    description: t.description,
    categoricalValue: t.categoricalValue.length > 0 ? (t.categoricalValue[0] ?? "") : "",
    multilabelValue: [...t.multilabelValue],
    options: [...t.options],
    minValue: Number(t.minValue),
    maxValue: Number(t.maxValue),
    defaultValue: Number(t.defaultValue),
    lock,
    learningRate: Number(t.learningRate),
    supportsDyadic: t.supportsDyadic,
    category: t.category,
  };
}

/** Convert a LocalTrait to a CandidPersonaTrait. */
function localToCandidate(t: LocalTrait): CandidPersonaTrait {
  const traitType: CandidTraitType =
    t.traitType === "Numeric" ? { Numeric: null } :
    t.traitType === "Categorical" ? { Categorical: null } : { Multilabel: null };
  const lock: CandidTraitLock = t.lock === "Hard" ? { Hard: null } : { Soft: null };
  return {
    name: t.name,
    displayName: t.displayName,
    traitType,
    description: t.description,
    numericValue: t.traitType === "Numeric" ? [BigInt(t.value)] : [],
    categoricalValue: t.traitType === "Categorical" && t.categoricalValue ? [t.categoricalValue] : [],
    multilabelValue: t.multilabelValue,
    options: t.options,
    minValue: BigInt(t.minValue),
    maxValue: BigInt(t.maxValue),
    defaultValue: BigInt(t.defaultValue),
    lock,
    learningRate: BigInt(t.learningRate),
    supportsDyadic: t.supportsDyadic,
    category: t.category,
  };
}

/** Get default trait set as LocalTraits. */
function getDefaultLocalTraits(): LocalTrait[] {
  return DEFAULT_TRAITS.map((t) => ({
    name: t.name,
    displayName: t.displayName,
    traitType: "Numeric" as const,
    value: 50,
    description: t.description,
    categoricalValue: "",
    multilabelValue: [],
    options: [],
    minValue: 0,
    maxValue: 100,
    defaultValue: 50,
    lock: "Soft" as const,
    learningRate: 50,
    supportsDyadic: false,
    category: t.category,
  }));
}

export default function PersonaTraitsPanel({ personaId, personaName, isBuiltIn }: PersonaTraitsPanelProps) {
  const { authClient } = useAuth();
  const [traits, setTraits] = useState<LocalTrait[]>([]);
  const [evolutionHistory, setEvolutionHistory] = useState<CandidTraitSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [showAddTrait, setShowAddTrait] = useState(false);
  const [newTraitName, setNewTraitName] = useState("");
  const [newTraitDisplayName, setNewTraitDisplayName] = useState("");
  const [newTraitDesc, setNewTraitDesc] = useState("");
  const [newTraitValue, setNewTraitValue] = useState(50);
  const [newTraitType, setNewTraitType] = useState<"Numeric" | "Categorical" | "Multilabel">("Numeric");
  const [newTraitCategory, setNewTraitCategory] = useState("personality");

  // Growth config state
  const [growthType, setGrowthType] = useState<string>("Fixed");
  const [domainRates, setDomainRates] = useState({ identity: 50, narrative: 50, behavior: 50 });
  const [triggers, setTriggers] = useState<CandidGrowthConfig["triggers"]>([]);
  const [boundaries, setBoundaries] = useState<CandidGrowthConfig["boundaries"]>([]);

  // Multi-LLM config state
  const [showMultiLlm, setShowMultiLlm] = useState(false);
  const [fastModelId, setFastModelId] = useState("gpt-4o-mini");
  const [smartModelIds, setSmartModelIds] = useState<string[]>([]);
  const [computePower, setComputePower] = useState(50);
  const [smartModelInput, setSmartModelInput] = useState("");

  // Load traits from backend
  const loadTraits = useCallback(async () => {
    setIsLoading(true);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const result = await gateway.getPersonaTraits(personaId);
      if ("ok" in result) {
        const data = result.ok as CandidPersonaTraits;
        setTraits(data.traits.map(candidToLocal));
        setEvolutionHistory(data.evolutionHistory);

        // Load growth config
        const gc = data.growthConfig;
        const gtKey = Object.keys(gc.growthType)[0];
        setGrowthType(gtKey);
        setDomainRates({
          identity: Number(gc.domainRates.identity),
          narrative: Number(gc.domainRates.narrative),
          behavior: Number(gc.domainRates.behavior),
        });
        setTriggers(gc.triggers);
        setBoundaries(gc.boundaries);

        // Load multi-LLM config
        if (data.multiLlmConfig.length > 0 && data.multiLlmConfig[0]) {
          const mlc = data.multiLlmConfig[0];
          setShowMultiLlm(true);
          setFastModelId(mlc.fastModelId);
          setSmartModelIds([...mlc.smartModelIds]);
          setComputePower(Number(mlc.computePower));
        }
      } else {
        // No traits saved yet - use defaults
        setTraits(getDefaultLocalTraits());
        setEvolutionHistory([]);
      }
    } catch {
      setTraits(getDefaultLocalTraits());
    } finally {
      setIsLoading(false);
    }
  }, [personaId, authClient]);

  useEffect(() => {
    loadTraits();
  }, [loadTraits]);

  const handleSliderChange = useCallback((index: number, value: number) => {
    setTraits((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], value };
      return next;
    });
  }, []);

  const handleCategoricalChange = useCallback((index: number, categoricalValue: string) => {
    setTraits((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], categoricalValue };
      return next;
    });
  }, []);

  const handleMultilabelToggle = useCallback((index: number, option: string) => {
    setTraits((prev) => {
      const next = [...prev];
      const current = next[index].multilabelValue;
      if (current.includes(option)) {
        next[index] = { ...next[index], multilabelValue: current.filter((v) => v !== option) };
      } else {
        next[index] = { ...next[index], multilabelValue: [...current, option] };
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gateway = createGatewayActor(agent);
      const candidTraits: CandidPersonaTrait[] = traits.map(localToCandidate);

      const growthTypeValue: CandidGrowthType = { [growthType]: null } as unknown as CandidGrowthType;

      const growthConfig: CandidGrowthConfig = {
        growthType: growthTypeValue,
        domainRates: {
          identity: BigInt(domainRates.identity),
          narrative: BigInt(domainRates.narrative),
          behavior: BigInt(domainRates.behavior),
        },
        triggers,
        goalStates: [],
        boundaries,
      };

      const multiLlmConfig: [] | [CandidMultiLlmConfig] = showMultiLlm
        ? [{ fastModelId, smartModelIds, computePower: BigInt(computePower) }]
        : [];

      const result = await gateway.savePersonaTraits(personaId, candidTraits, growthConfig, multiLlmConfig);
      if ("ok" in result) {
        const data = result.ok as CandidPersonaTraits;
        setEvolutionHistory(data.evolutionHistory);
        setSaveMessage("Traits saved successfully");
      } else {
        setSaveMessage("Failed to save traits");
      }
    } catch {
      setSaveMessage("Error saving traits");
    } finally {
      setIsSaving(false);
      setTimeout(() => setSaveMessage(null), 3000);
    }
  }, [traits, growthType, domainRates, triggers, boundaries, showMultiLlm, fastModelId, smartModelIds, computePower, personaId, isSaving, authClient]);

  const handleResetDefaults = useCallback(() => {
    setTraits(getDefaultLocalTraits());
    setGrowthType("Fixed");
    setDomainRates({ identity: 50, narrative: 50, behavior: 50 });
  }, []);

  const handleAddCustomTrait = useCallback(() => {
    const name = newTraitName.trim();
    const displayName = newTraitDisplayName.trim() || name;
    const desc = newTraitDesc.trim();
    if (!name || traits.length >= 20) return;
    if (traits.some((t) => t.name.toLowerCase() === name.toLowerCase())) return;
    setTraits((prev) => [...prev, {
      name,
      displayName,
      traitType: newTraitType,
      value: newTraitValue,
      description: desc || name,
      categoricalValue: "",
      multilabelValue: [],
      options: [],
      minValue: 0,
      maxValue: 100,
      defaultValue: 50,
      lock: "Soft",
      learningRate: 50,
      supportsDyadic: false,
      category: newTraitCategory,
    }]);
    setNewTraitName("");
    setNewTraitDisplayName("");
    setNewTraitDesc("");
    setNewTraitValue(50);
    setNewTraitType("Numeric");
    setNewTraitCategory("personality");
    setShowAddTrait(false);
  }, [newTraitName, newTraitDisplayName, newTraitDesc, newTraitValue, newTraitType, newTraitCategory, traits]);

  const handleRemoveTrait = useCallback((index: number) => {
    setTraits((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAddSmartModel = useCallback(() => {
    const model = smartModelInput.trim();
    if (!model || smartModelIds.includes(model)) return;
    setSmartModelIds((prev) => [...prev, model]);
    setSmartModelInput("");
  }, [smartModelInput, smartModelIds]);

  const handleRemoveSmartModel = useCallback((model: string) => {
    setSmartModelIds((prev) => prev.filter((m) => m !== model));
  }, []);

  if (isLoading) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        Loading traits...
      </div>
    );
  }

  // Compute evolution diff for the most recent snapshot
  let recentDiffs: { name: string; change: number }[] = [];
  if (evolutionHistory.length >= 2) {
    const latest = evolutionHistory[evolutionHistory.length - 1];
    const previous = evolutionHistory[evolutionHistory.length - 2];
    const prevMap = new Map(previous.traits.map((t) => [t.name, t.numericValue.length > 0 ? Number(t.numericValue[0]) : Number(t.defaultValue)]));
    recentDiffs = latest.traits
      .map((t) => ({
        name: t.name,
        change: (t.numericValue.length > 0 ? Number(t.numericValue[0]) : Number(t.defaultValue)) - (prevMap.get(t.name) ?? 0),
      }))
      .filter((d) => d.change !== 0);
  }

  // Group traits by category
  const traitsByCategory: Record<string, { trait: LocalTrait; index: number }[]> = {};
  traits.forEach((trait, index) => {
    const cat = trait.category || "other";
    if (!traitsByCategory[cat]) traitsByCategory[cat] = [];
    traitsByCategory[cat].push({ trait, index });
  });

  const categoryOrder = ["personality", "communication", "behavior", "other"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {/* Trait Sliders grouped by category */}
      {categoryOrder.map((cat) => {
        const items = traitsByCategory[cat];
        if (!items || items.length === 0) return null;
        const config = CATEGORY_CONFIG[cat] || { label: cat.charAt(0).toUpperCase() + cat.slice(1), color: "#6b7280" };
        return (
          <div key={cat}>
            <div style={{
              display: "flex", alignItems: "center", gap: "0.5rem",
              marginBottom: "0.75rem", paddingBottom: "0.35rem",
              borderBottom: `2px solid ${config.color}30`,
            }}>
              <div style={{
                width: "8px", height: "8px", borderRadius: "50%",
                backgroundColor: config.color,
              }} />
              <h3 style={{
                margin: 0, fontSize: "0.88rem", fontWeight: 600,
                color: config.color, textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}>
                {config.label}
              </h3>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {items.map(({ trait, index }) => {
                const labels = LABEL_MAP[trait.name];
                const color = getSliderColor(trait.value);
                const isDefault = DEFAULT_TRAITS.some((d) => d.name === trait.name);
                const isHardLocked = trait.lock === "Hard";

                return (
                  <div
                    key={trait.name}
                    style={{
                      backgroundColor: "var(--bg-tertiary)",
                      borderRadius: "10px",
                      padding: "0.85rem 1rem",
                      border: "1px solid var(--border)",
                      opacity: isHardLocked ? 0.7 : 1,
                      transition: "border-color 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
                          {isHardLocked ? "\uD83D\uDD12" : "\uD83D\uDD13"}
                        </span>
                        <span style={{ fontSize: "0.88rem", fontWeight: 600, color: "var(--text-primary)" }}>
                          {trait.displayName}
                        </span>
                        {trait.learningRate > 0 && (
                          <span style={{
                            fontSize: "0.62rem",
                            backgroundColor: "var(--bg-secondary)",
                            color: "var(--text-muted)",
                            padding: "1px 5px",
                            borderRadius: "4px",
                            fontWeight: 500,
                          }}>
                            LR:{trait.learningRate}
                          </span>
                        )}
                        {!isDefault && (
                          <button
                            onClick={() => handleRemoveTrait(index)}
                            style={{
                              background: "none", border: "none",
                              color: "var(--text-muted)", cursor: "pointer",
                              fontSize: "0.75rem", padding: "0 4px", lineHeight: 1,
                            }}
                            title="Remove custom trait"
                          >
                            x
                          </button>
                        )}
                      </div>
                      {trait.traitType === "Numeric" && (
                        <span
                          style={{
                            fontSize: "0.82rem", fontWeight: 700,
                            color, backgroundColor: `${color}18`,
                            padding: "2px 8px", borderRadius: "6px",
                            minWidth: "28px", textAlign: "center",
                          }}
                        >
                          {trait.value}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                      {trait.description}
                    </div>

                    {/* Numeric: slider */}
                    {trait.traitType === "Numeric" && (
                      <>
                        <div style={{ position: "relative" }}>
                          <input
                            type="range"
                            min={trait.minValue}
                            max={trait.maxValue}
                            value={trait.value}
                            disabled={isHardLocked}
                            onChange={(e) => handleSliderChange(index, parseInt(e.target.value, 10))}
                            style={{
                              width: "100%", height: "6px",
                              WebkitAppearance: "none",
                              appearance: "none" as never,
                              background: `linear-gradient(to right, ${color} 0%, ${color} ${((trait.value - trait.minValue) / (trait.maxValue - trait.minValue)) * 100}%, var(--border) ${((trait.value - trait.minValue) / (trait.maxValue - trait.minValue)) * 100}%, var(--border) 100%)`,
                              borderRadius: "3px", outline: "none",
                              cursor: isHardLocked ? "not-allowed" : "pointer",
                              accentColor: color,
                            }}
                          />
                        </div>
                        {labels && (
                          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.25rem" }}>
                            <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>{labels.left}</span>
                            <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>{labels.right}</span>
                          </div>
                        )}
                      </>
                    )}

                    {/* Categorical: dropdown */}
                    {trait.traitType === "Categorical" && trait.options.length > 0 && (
                      <select
                        value={trait.categoricalValue}
                        disabled={isHardLocked}
                        onChange={(e) => handleCategoricalChange(index, e.target.value)}
                        style={{
                          width: "100%", backgroundColor: "var(--bg-secondary)",
                          color: "var(--text-primary)", border: "1px solid var(--border)",
                          borderRadius: "6px", padding: "0.4rem 0.65rem",
                          fontSize: "0.82rem", outline: "none",
                          cursor: isHardLocked ? "not-allowed" : "pointer",
                        }}
                      >
                        <option value="">Select...</option>
                        {trait.options.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    )}

                    {/* Multilabel: checkboxes */}
                    {trait.traitType === "Multilabel" && trait.options.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                        {trait.options.map((opt) => {
                          const isChecked = trait.multilabelValue.includes(opt);
                          return (
                            <label
                              key={opt}
                              style={{
                                display: "flex", alignItems: "center", gap: "0.25rem",
                                fontSize: "0.78rem", color: "var(--text-secondary)",
                                cursor: isHardLocked ? "not-allowed" : "pointer",
                                backgroundColor: isChecked ? "var(--accent)" + "20" : "var(--bg-secondary)",
                                padding: "3px 8px", borderRadius: "6px",
                                border: isChecked ? "1px solid var(--accent)" : "1px solid var(--border)",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                disabled={isHardLocked}
                                onChange={() => handleMultilabelToggle(index, opt)}
                                style={{ accentColor: "var(--accent)", width: "14px", height: "14px" }}
                              />
                              {opt}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Add Custom Trait */}
      {traits.length < 20 && (
        <div>
          {!showAddTrait ? (
            <button
              onClick={() => setShowAddTrait(true)}
              style={{
                backgroundColor: "var(--bg-tertiary)",
                color: "var(--text-secondary)",
                border: "1px dashed var(--border)",
                borderRadius: "8px",
                padding: "0.6rem 1rem",
                fontSize: "0.82rem",
                cursor: "pointer",
                width: "100%",
                transition: "border-color 0.15s ease",
              }}
            >
              + Add Custom Trait ({traits.length}/20)
            </button>
          ) : (
            <div
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border)",
                borderRadius: "10px",
                padding: "1rem",
              }}
            >
              <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)", marginBottom: "0.75rem" }}>
                New Custom Trait
              </div>
              <input
                value={newTraitName}
                onChange={(e) => setNewTraitName(e.target.value.slice(0, 30).toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
                placeholder="Trait key (e.g. patience)"
                style={{ ...sliderInputStyle, marginBottom: "0.5rem" }}
              />
              <input
                value={newTraitDisplayName}
                onChange={(e) => setNewTraitDisplayName(e.target.value.slice(0, 50))}
                placeholder="Display name (e.g. Patience Level)"
                style={{ ...sliderInputStyle, marginBottom: "0.5rem" }}
              />
              <input
                value={newTraitDesc}
                onChange={(e) => setNewTraitDesc(e.target.value.slice(0, 100))}
                placeholder="Short description"
                style={{ ...sliderInputStyle, marginBottom: "0.5rem" }}
              />
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                <select
                  value={newTraitType}
                  onChange={(e) => setNewTraitType(e.target.value as "Numeric" | "Categorical" | "Multilabel")}
                  style={{ ...sliderInputStyle, flex: 1 }}
                >
                  <option value="Numeric">Numeric (slider)</option>
                  <option value="Categorical">Categorical (dropdown)</option>
                  <option value="Multilabel">Multilabel (checkboxes)</option>
                </select>
                <select
                  value={newTraitCategory}
                  onChange={(e) => setNewTraitCategory(e.target.value)}
                  style={{ ...sliderInputStyle, flex: 1 }}
                >
                  <option value="personality">Personality</option>
                  <option value="communication">Communication</option>
                  <option value="behavior">Behavior</option>
                </select>
              </div>
              {newTraitType === "Numeric" && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
                  <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    Initial: {newTraitValue}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={newTraitValue}
                    onChange={(e) => setNewTraitValue(parseInt(e.target.value, 10))}
                    style={{ flex: 1, accentColor: "var(--accent)" }}
                  />
                </div>
              )}
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  onClick={handleAddCustomTrait}
                  disabled={!newTraitName.trim()}
                  style={{
                    backgroundColor: newTraitName.trim() ? "var(--accent)" : "var(--bg-secondary)",
                    color: newTraitName.trim() ? "white" : "var(--text-muted)",
                    border: "none",
                    borderRadius: "6px",
                    padding: "0.4rem 1rem",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    cursor: newTraitName.trim() ? "pointer" : "default",
                  }}
                >
                  Add
                </button>
                <button
                  onClick={() => { setShowAddTrait(false); setNewTraitName(""); setNewTraitDisplayName(""); setNewTraitDesc(""); setNewTraitValue(50); }}
                  style={{
                    backgroundColor: "var(--bg-secondary)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    padding: "0.4rem 1rem",
                    fontSize: "0.82rem",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Growth Config Section */}
      <div
        style={{
          backgroundColor: "var(--bg-tertiary)",
          border: "1px solid var(--border)",
          borderRadius: "10px",
          padding: "1rem",
        }}
      >
        <h3 style={{ margin: "0 0 0.75rem 0", fontSize: "0.95rem", fontWeight: 600, color: "var(--text-primary)" }}>
          Growth Configuration
        </h3>
        <p style={{ margin: "0 0 0.75rem 0", fontSize: "0.75rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
          Controls how this persona's traits evolve over time through conversations.
        </p>

        {/* Growth Type selector */}
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
            Growth Type
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {GROWTH_TYPES.map((gt) => {
              const isActive = growthType === gt.key;
              return (
                <button
                  key={gt.key}
                  onClick={() => setGrowthType(gt.key)}
                  style={{
                    padding: "0.4rem 0.85rem",
                    borderRadius: "999px",
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    border: `1.5px solid ${isActive ? gt.color : "var(--border)"}`,
                    backgroundColor: isActive ? gt.color + "20" : "transparent",
                    color: isActive ? gt.color : "var(--text-secondary)",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                  title={gt.description}
                >
                  {gt.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
            {GROWTH_TYPES.find((gt) => gt.key === growthType)?.description ?? ""}
          </div>
        </div>

        {/* Domain Rates */}
        {growthType !== "Fixed" && (
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
              Domain Rates
            </div>
            {(["identity", "narrative", "behavior"] as const).map((domain) => (
              <div key={domain} style={{ marginBottom: "0.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.2rem" }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "capitalize" }}>
                    {domain}
                  </span>
                  <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-primary)" }}>
                    {domainRates[domain]}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={domainRates[domain]}
                  onChange={(e) => setDomainRates((prev) => ({ ...prev, [domain]: parseInt(e.target.value, 10) }))}
                  style={{
                    width: "100%", height: "4px",
                    accentColor: "var(--accent)",
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {/* Triggers list */}
        {triggers.length > 0 && (
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.35rem" }}>
              Triggers ({triggers.length})
            </div>
            {triggers.map((t, i) => (
              <div key={i} style={{
                fontSize: "0.72rem", color: "var(--text-muted)",
                backgroundColor: "var(--bg-secondary)", padding: "0.35rem 0.5rem",
                borderRadius: "4px", marginBottom: "0.25rem",
              }}>
                {t.condition} - affects {t.affectedTraits.join(", ")}
              </div>
            ))}
          </div>
        )}

        {/* Boundaries list */}
        {boundaries.length > 0 && (
          <div>
            <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.35rem" }}>
              Boundaries ({boundaries.length})
            </div>
            {boundaries.map((b, i) => (
              <div key={i} style={{
                fontSize: "0.72rem", color: "var(--text-muted)",
                backgroundColor: "var(--bg-secondary)", padding: "0.35rem 0.5rem",
                borderRadius: "4px", marginBottom: "0.25rem",
              }}>
                {b.traitName}: {Number(b.minValue)}-{Number(b.maxValue)} ({b.reason})
              </div>
            ))}
          </div>
        )}

        {/* Evolution History */}
        {growthType !== "Fixed" && evolutionHistory.length > 0 && (
          <div style={{ marginTop: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
              <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>
                Evolution History
              </span>
              <span
                style={{
                  fontSize: "0.68rem",
                  backgroundColor: "var(--accent)",
                  color: "white",
                  padding: "1px 6px",
                  borderRadius: "999px",
                  fontWeight: 600,
                }}
              >
                {evolutionHistory.length}
              </span>
            </div>

            {/* Recent changes highlight */}
            {recentDiffs.length > 0 && (
              <div
                style={{
                  backgroundColor: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  padding: "0.6rem 0.75rem",
                  marginBottom: "0.75rem",
                }}
              >
                <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.35rem" }}>
                  Latest Changes
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                  {recentDiffs.map((d) => (
                    <span
                      key={d.name}
                      style={{
                        fontSize: "0.72rem",
                        color: d.change > 0 ? "#22c55e" : "#f59e0b",
                        backgroundColor: d.change > 0 ? "#22c55e18" : "#f59e0b18",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontWeight: 500,
                        textTransform: "capitalize",
                      }}
                    >
                      {d.name} {d.change > 0 ? "+" : ""}{d.change}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Timeline */}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxHeight: "200px", overflowY: "auto" }}>
              {[...evolutionHistory].reverse().map((snapshot, i) => (
                <div
                  key={i}
                  style={{
                    backgroundColor: "var(--bg-secondary)",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    padding: "0.5rem 0.75rem",
                    borderLeft: "3px solid var(--accent)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                      {snapshot.trigger}
                    </span>
                    <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
                      {formatTimestamp(snapshot.timestamp)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Multi-LLM Config Section */}
      <div
        style={{
          backgroundColor: "var(--bg-tertiary)",
          border: "1px solid var(--border)",
          borderRadius: "10px",
          padding: "1rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600, color: "var(--text-primary)" }}>
            Multi-LLM Configuration
          </h3>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <div
              onClick={() => setShowMultiLlm(!showMultiLlm)}
              style={{
                width: "36px", height: "20px",
                backgroundColor: showMultiLlm ? "var(--accent)" : "var(--border)",
                borderRadius: "10px", position: "relative",
                transition: "background-color 0.15s ease", cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: "16px", height: "16px",
                  backgroundColor: "white", borderRadius: "50%",
                  position: "absolute", top: "2px",
                  left: showMultiLlm ? "18px" : "2px",
                  transition: "left 0.15s ease",
                }}
              />
            </div>
            <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
              {showMultiLlm ? "Enabled" : "Disabled"}
            </span>
          </label>
        </div>
        <p style={{ margin: "0 0 0.75rem 0", fontSize: "0.75rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
          Configure which LLM models are used for Fast and Smart Brain responses.
          Only applies to MagickMind personas.
        </p>

        {showMultiLlm && (
          <>
            {/* Fast Model */}
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: "0.35rem" }}>
                Fast Brain Model
              </label>
              <input
                value={fastModelId}
                onChange={(e) => setFastModelId(e.target.value)}
                placeholder="e.g. gpt-4o-mini"
                style={sliderInputStyle}
              />
            </div>

            {/* Smart Models */}
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: "0.35rem" }}>
                Smart Brain Models
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.5rem" }}>
                {smartModelIds.map((model) => (
                  <span
                    key={model}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "0.3rem",
                      backgroundColor: "var(--accent)", color: "white",
                      padding: "0.2rem 0.6rem", borderRadius: "999px",
                      fontSize: "0.75rem", fontWeight: 500,
                    }}
                  >
                    {model}
                    <button
                      onClick={() => handleRemoveSmartModel(model)}
                      style={{
                        background: "none", border: "none",
                        color: "rgba(255,255,255,0.8)", cursor: "pointer",
                        padding: "0 2px", fontSize: "0.8rem", lineHeight: 1,
                      }}
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
                <input
                  value={smartModelInput}
                  onChange={(e) => setSmartModelInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddSmartModel(); } }}
                  placeholder="Add model ID..."
                  style={{ ...sliderInputStyle, flex: 1 }}
                />
                <button
                  onClick={handleAddSmartModel}
                  disabled={!smartModelInput.trim()}
                  style={{
                    backgroundColor: smartModelInput.trim() ? "var(--accent)" : "var(--bg-secondary)",
                    color: smartModelInput.trim() ? "white" : "var(--text-muted)",
                    border: "none", borderRadius: "6px",
                    padding: "0.4rem 0.75rem", fontSize: "0.78rem",
                    cursor: smartModelInput.trim() ? "pointer" : "default",
                  }}
                >
                  Add
                </button>
              </div>
              {/* Suggested models */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                {["gpt-4o", "claude-sonnet-4", "claude-haiku-4.5", "openrouter/meta-llama/llama-4-maverick"].map((model) => {
                  if (smartModelIds.includes(model)) return null;
                  return (
                    <button
                      key={model}
                      onClick={() => setSmartModelIds((prev) => [...prev, model])}
                      style={{
                        fontSize: "0.68rem", padding: "2px 8px",
                        borderRadius: "999px", border: "1px dashed var(--border)",
                        backgroundColor: "transparent", color: "var(--text-muted)",
                        cursor: "pointer", transition: "all 0.15s",
                      }}
                    >
                      + {model}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Compute Power */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                <label style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                  Compute Power
                </label>
                <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-primary)" }}>
                  {computePower}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={computePower}
                onChange={(e) => setComputePower(parseInt(e.target.value, 10))}
                style={{
                  width: "100%", height: "6px",
                  accentColor: "var(--accent)",
                }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.2rem" }}>
                <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>Speed</span>
                <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>Depth</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", paddingBottom: "1rem" }}>
        <button
          onClick={handleSave}
          disabled={isSaving}
          style={{
            backgroundColor: isSaving ? "var(--bg-tertiary)" : "var(--accent)",
            color: isSaving ? "var(--text-muted)" : "white",
            border: "none",
            borderRadius: "8px",
            padding: "0.6rem 1.5rem",
            fontSize: "0.88rem",
            fontWeight: 600,
            cursor: isSaving ? "default" : "pointer",
            transition: "all 0.15s ease",
          }}
        >
          {isSaving ? "Saving..." : "Save Traits"}
        </button>
        <button
          onClick={handleResetDefaults}
          style={{
            backgroundColor: "var(--bg-tertiary)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            padding: "0.6rem 1.25rem",
            fontSize: "0.82rem",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
        >
          Reset to Defaults
        </button>
        {saveMessage && (
          <span
            style={{
              fontSize: "0.82rem",
              color: saveMessage.includes("success") ? "#22c55e" : "#ef4444",
              alignSelf: "center",
            }}
          >
            {saveMessage}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Shared styles ───────────────────────────────────────────────────

const sliderInputStyle: React.CSSProperties = {
  width: "100%",
  backgroundColor: "var(--bg-secondary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  padding: "0.45rem 0.65rem",
  fontSize: "0.82rem",
  outline: "none",
  boxSizing: "border-box",
};
