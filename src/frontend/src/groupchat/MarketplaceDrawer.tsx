/**
 * @file Persona Marketplace drawer — browse, hire, rate, and manage persona earnings.
 * Slides in from the right side of the Group Chat page.
 */
import { useState, useEffect } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import {
  createGatewayActor,
  type CandidMarketplaceListing,
  type CandidPersonaHire,
  type CandidMarketplaceCategory,
  type CandidMarketplaceOpResult,
} from "../api/gateway.did";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onHired: () => void;
}

const CATEGORIES = ["All", "Code", "Research", "Creative", "Business", "Coaching"];

function catToVariant(cat: string): CandidMarketplaceCategory {
  if (cat === "Code") return { Code: null };
  if (cat === "Research") return { Research: null };
  if (cat === "Creative") return { Creative: null };
  if (cat === "Business") return { Business: null };
  if (cat === "Coaching") return { Coaching: null };
  return { All: null };
}

function unwrapOp(res: CandidMarketplaceOpResult): { ok: boolean; msg: string } {
  if ("Ok" in res) return { ok: true, msg: res.Ok };
  return { ok: false, msg: res.Err };
}

const formatPrice = (e8s: bigint) => {
  const n = Number(e8s);
  if (n === 0) return "Free";
  return (n / 1e8).toFixed(4) + " ICP";
};

export default function MarketplaceDrawer({ isOpen, onClose, onHired }: Props) {
  const { authClient } = useAuth();
  const [listings, setListings] = useState<CandidMarketplaceListing[]>([]);
  const [myHires, setMyHires] = useState<CandidPersonaHire[]>([]);
  const [category, setCategory] = useState("All");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hiringId, setHiringId] = useState<string | null>(null);
  const [tab, setTab] = useState<"browse" | "hired" | "earnings">("browse");
  const [earnings, setEarnings] = useState<Record<string, string>>({});

  const getActor = async () => {
    if (!authClient) throw new Error("Not authenticated");
    const agent = await createAgent(authClient);
    return createGatewayActor(agent);
  };

  const loadListings = async () => {
    setLoading(true);
    setError("");
    try {
      const gw = await getActor();
      const res = await gw.browseMarketplace(category, "MostHired", BigInt(0), BigInt(50));
      setListings(res);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const loadHires = async () => {
    try {
      const gw = await getActor();
      setMyHires(await gw.listMyHires());
    } catch {}
  };

  useEffect(() => {
    if (isOpen) { loadListings(); loadHires(); }
  }, [isOpen, category]);

  const handleHire = async (personaId: string, type: "PerMessage" | "Daily") => {
    setHiringId(personaId);
    setError("");
    try {
      const gw = await getActor();
      const pt = type === "Daily" ? { Daily: null } : { PerMessage: null };
      const res = unwrapOp(await gw.hirePersona(personaId, pt));
      if (res.ok) { await loadHires(); onHired(); }
      else setError(res.msg);
    } catch (e: any) { setError(e.message); }
    setHiringId(null);
  };

  const handleEndHire = async (personaId: string) => {
    try {
      const gw = await getActor();
      await gw.endHire(personaId);
      await loadHires();
    } catch (e: any) { setError(e.message); }
  };

  const handleRate = async (personaId: string, rating: number) => {
    try {
      const gw = await getActor();
      const res = unwrapOp(await gw.ratePersona(personaId, BigInt(rating)));
      if (!res.ok) setError(res.msg);
      else await loadListings();
    } catch (e: any) { setError(e.message); }
  };

  const handleCheckEarnings = async (personaId: string) => {
    try {
      const gw = await getActor();
      const res = unwrapOp(await gw.getPersonaEarnings(personaId));
      if (res.ok) setEarnings(prev => ({ ...prev, [personaId]: res.msg }));
    } catch {}
  };

  const handleWithdraw = async (personaId: string) => {
    const amt = earnings[personaId];
    if (!amt || amt === "0") return;
    try {
      const gw = await getActor();
      const res = unwrapOp(await gw.withdrawPersonaEarnings(personaId, BigInt(amt)));
      if (res.ok) { alert(res.msg); handleCheckEarnings(personaId); }
      else setError(res.msg);
    } catch (e: any) { setError(e.message); }
  };

  const handleMintNft = async (personaId: string) => {
    try {
      const gw = await getActor();
      const res = unwrapOp(await gw.mintPersonaNft(personaId));
      if (res.ok) alert(res.msg);
      else setError(res.msg);
    } catch (e: any) { setError(e.message); }
  };

  if (!isOpen) return null;

  const s = {
    overlay: { position: "fixed" as const, top: 0, right: 0, bottom: 0, width: "420px", background: "#0d1117", borderLeft: "1px solid #ffffff15", zIndex: 1000, display: "flex", flexDirection: "column" as const, boxShadow: "-4px 0 20px #00000080" },
    header: { padding: "16px 20px", borderBottom: "1px solid #ffffff10", display: "flex", justifyContent: "space-between", alignItems: "center" },
    body: { flex: 1, overflow: "auto", padding: "16px 20px" },
    tabs: { display: "flex", gap: "4px", marginBottom: "16px", background: "#16213e", borderRadius: "10px", padding: "3px" },
    tab: (a: boolean) => ({ padding: "8px 14px", borderRadius: "8px", border: "none", cursor: "pointer", fontWeight: 600, fontSize: "12px", background: a ? "#00d2ff22" : "transparent", color: a ? "#00d2ff" : "#888" } as React.CSSProperties),
    card: { background: "#16213e", borderRadius: "10px", padding: "14px", marginBottom: "10px", border: "1px solid #ffffff10" },
    btn: (c = "#00d2ff") => ({ padding: "6px 12px", borderRadius: "6px", border: "none", cursor: "pointer", fontWeight: 600, fontSize: "12px", background: c, color: "#fff" } as React.CSSProperties),
    badge: (c: string) => ({ display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "10px", fontWeight: 700, background: c + "22", color: c, marginRight: "4px" } as React.CSSProperties),
    catBtn: (a: boolean) => ({ padding: "4px 10px", borderRadius: "12px", border: a ? "1px solid #00d2ff" : "1px solid #ffffff15", cursor: "pointer", fontSize: "11px", background: a ? "#00d2ff15" : "transparent", color: a ? "#00d2ff" : "#888" } as React.CSSProperties),
    price: { fontSize: "13px", fontWeight: 700, color: "#22c55e" } as React.CSSProperties,
  };

  const isHired = (pid: string) => myHires.some(h => h.personaId === pid);

  const renderStars = (sum: bigint, count: bigint) => {
    const avg = Number(count) > 0 ? Number(sum) / Number(count) : 0;
    return (
      <span style={{ fontSize: "12px", color: "#fbbf24" }}>
        {"★".repeat(Math.round(avg))}{"☆".repeat(5 - Math.round(avg))}
        <span style={{ color: "#666", marginLeft: "4px" }}>({Number(count)})</span>
      </span>
    );
  };

  return (
    <div style={s.overlay}>
      <div style={s.header}>
        <h3 style={{ margin: 0, fontSize: "16px", background: "linear-gradient(90deg, #00d2ff, #7b2ff7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Persona Marketplace</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", fontSize: "18px", cursor: "pointer" }}>x</button>
      </div>

      <div style={s.body}>
        <div style={s.tabs}>
          {(["browse", "hired", "earnings"] as const).map(t => (
            <button key={t} style={s.tab(tab === t)} onClick={() => setTab(t)}>
              {t === "browse" ? "Browse" : t === "hired" ? `Hired (${myHires.length})` : "My Earnings"}
            </button>
          ))}
        </div>

        {error && <div style={{ ...s.card, borderColor: "#ff4444", color: "#ff6b6b", fontSize: "12px" }}>{error} <button onClick={() => setError("")} style={{ float: "right", background: "none", border: "none", color: "#ff6b6b", cursor: "pointer" }}>x</button></div>}

        {/* BROWSE */}
        {tab === "browse" && (
          <>
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginBottom: "12px" }}>
              {CATEGORIES.map(c => <button key={c} style={s.catBtn(category === c)} onClick={() => setCategory(c)}>{c}</button>)}
            </div>
            {loading ? <div style={{ textAlign: "center", padding: "40px", color: "#555" }}>Loading...</div>
            : listings.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px", color: "#555" }}>
                <div style={{ fontSize: "36px", marginBottom: "8px" }}>🏪</div>
                <div>No personas published yet.</div>
                <div style={{ fontSize: "12px", color: "#444", marginTop: "4px" }}>Publish yours in the Persona Builder!</div>
              </div>
            ) : listings.map(l => {
              const p = l.published;
              const hired = isHired(p.personaId);
              return (
                <div key={p.personaId} style={{ ...s.card, borderColor: hired ? "#22c55e" : "#ffffff10" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <div>
                      <strong style={{ color: "#e0e0e0" }}>{p.personaName}</strong>
                      {hired && <span style={s.badge("#22c55e")}>HIRED</span>}
                    </div>
                    <span style={s.badge("#7b2ff7")}>{Object.keys(p.category)[0]}</span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#888", marginBottom: "8px" }}>{p.personaDescription.slice(0, 120)}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <div>
                      <span style={s.price}>{formatPrice(p.pricePerMessage)}/msg</span>
                      {Number(p.pricePerDay) > 0 && <span style={{ ...s.price, marginLeft: "8px", color: "#00d2ff" }}>{formatPrice(p.pricePerDay)}/day</span>}
                    </div>
                    <span style={{ fontSize: "11px", color: "#666" }}>{Number(p.hireCount)} hires</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    {renderStars(p.ratingSum, p.ratingCount)}
                    <span style={{ fontSize: "11px", color: "#555" }}>{Number(l.traitCount)} traits</span>
                  </div>
                  {!hired ? (
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button style={s.btn()} onClick={() => handleHire(p.personaId, "PerMessage")} disabled={hiringId === p.personaId}>{hiringId === p.personaId ? "..." : "Hire (Per Msg)"}</button>
                      {Number(p.pricePerDay) > 0 && <button style={s.btn("#7b2ff7")} onClick={() => handleHire(p.personaId, "Daily")} disabled={hiringId === p.personaId}>Hire (Daily)</button>}
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <button style={s.btn("#ff4444")} onClick={() => handleEndHire(p.personaId)}>End Hire</button>
                      {[1,2,3,4,5].map(r => <span key={r} onClick={() => handleRate(p.personaId, r)} style={{ cursor: "pointer", color: "#fbbf24", fontSize: "14px" }}>★</span>)}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* HIRED */}
        {tab === "hired" && (
          myHires.length === 0 ? <div style={{ textAlign: "center", padding: "40px", color: "#555" }}>No active hires</div>
          : myHires.map(h => (
            <div key={h.personaId} style={s.card}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <strong style={{ color: "#e0e0e0" }}>{h.personaId.slice(0, 20)}...</strong>
                <span style={s.badge("PerMessage" in h.paymentType ? "#22c55e" : "#00d2ff")}>
                  {"PerMessage" in h.paymentType ? "Per Message" : "Daily"}
                </span>
              </div>
              <div style={{ fontSize: "12px", color: "#888" }}>
                Messages: {Number(h.messagesUsed)} | Paid: {formatPrice(h.totalPaid)}
              </div>
              <div style={{ marginTop: "8px", display: "flex", gap: "6px" }}>
                <button style={s.btn("#ff4444")} onClick={() => handleEndHire(h.personaId)}>End</button>
                {[1,2,3,4,5].map(r => <span key={r} onClick={() => handleRate(h.personaId, r)} style={{ cursor: "pointer", color: "#fbbf24", fontSize: "14px" }}>★</span>)}
              </div>
            </div>
          ))
        )}

        {/* EARNINGS */}
        {tab === "earnings" && (
          <>
            <div style={{ fontSize: "12px", color: "#888", marginBottom: "12px" }}>Earnings from your published personas.</div>
            <button style={{ ...s.btn(), width: "100%", marginBottom: "12px" }} onClick={async () => {
              try {
                const gw = await getActor();
                const all = await gw.browseMarketplace("All", "Newest", BigInt(0), BigInt(100));
                for (const l of all) handleCheckEarnings(l.published.personaId);
              } catch {}
            }}>Refresh Earnings</button>
            {Object.entries(earnings).map(([pid, amt]) => (
              <div key={pid} style={s.card}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <strong style={{ color: "#e0e0e0" }}>{pid.slice(0, 20)}...</strong>
                  <span style={s.price}>{(Number(amt) / 1e8).toFixed(4)} ICP</span>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button style={s.btn("#22c55e")} onClick={() => handleWithdraw(pid)}>Withdraw</button>
                  <button style={s.btn("#c084fc")} onClick={() => handleMintNft(pid)}>Mint NFT</button>
                </div>
              </div>
            ))}
            {Object.keys(earnings).length === 0 && <div style={{ textAlign: "center", padding: "20px", color: "#555" }}>No earnings data. Click Refresh above.</div>}
          </>
        )}
      </div>
    </div>
  );
}
