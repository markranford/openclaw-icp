import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import {
  createWalletActor,
  type TokenTypeVariant,
  type TransactionRecord,
} from "../api/wallet.did";

const TOKENS: { id: string; label: string; variant: TokenTypeVariant; decimals: number; fee: string }[] = [
  { id: "ICP", label: "ICP", variant: { ICP: null }, decimals: 8, fee: "0.0001" },
  { id: "ckBTC", label: "ckBTC", variant: { ckBTC: null }, decimals: 8, fee: "0.0000001" },
  { id: "ckUSDC", label: "ckUSDC", variant: { ckUSDC: null }, decimals: 6, fee: "0.01" },
];

function formatAmount(amount: bigint, decimals: number): string {
  const str = amount.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, str.length - decimals) || "0";
  const frac = str.slice(str.length - decimals);
  // Trim trailing zeros but keep at least 2 decimal places
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed}`;
}

function txTypeLabel(txType: Record<string, null>): string {
  const key = Object.keys(txType)[0];
  switch (key) {
    case "Deposit": return "Deposit";
    case "Withdrawal": return "Withdraw";
    case "LlmFee": return "LLM Fee";
    case "Refund": return "Refund";
    default: return key;
  }
}

function tokenLabel(tokenType: Record<string, null>): string {
  return Object.keys(tokenType)[0];
}

export default function WalletPage() {
  const { isAuthenticated, authClient } = useAuth();
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Deposit state
  const [depositToken, setDepositToken] = useState("ICP");
  const [depositAddress, setDepositAddress] = useState("");

  // Withdraw state
  const [withdrawToken, setWithdrawToken] = useState("ICP");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawTo, setWithdrawTo] = useState("");

  const loadData = useCallback(async () => {
    try {
      const agent = await createAgent(authClient ?? undefined);
      const wallet = createWalletActor(agent);

      const [balResult, txResult] = await Promise.all([
        wallet.getAllBalances(),
        wallet.getTransactions(),
      ]);

      if ("ok" in balResult) {
        const bals: Record<string, bigint> = {};
        for (const [token, amount] of balResult.ok) {
          bals[token] = amount;
        }
        setBalances(bals);
      }

      if ("ok" in txResult) {
        setTransactions((txResult.ok as TransactionRecord[]).reverse()); // newest first
      }
    } catch (e) {
      console.error("Failed to load wallet data:", e);
    } finally {
      setLoading(false);
    }
  }, [authClient]);

  useEffect(() => {
    if (isAuthenticated) loadData();
  }, [isAuthenticated, loadData]);

  // Load deposit address when token changes
  useEffect(() => {
    if (!isAuthenticated) return;
    (async () => {
      try {
        const agent = await createAgent(authClient ?? undefined);
        const wallet = createWalletActor(agent);
        const token = TOKENS.find((t) => t.id === depositToken);
        if (!token) return;
        const result = await wallet.getDepositAddress(token.variant);
        if ("ok" in result) {
          // Format as principal + subaccount hex
          const sub = Array.from(result.ok.subaccount as Uint8Array)
            .map((b: number) => b.toString(16).padStart(2, "0"))
            .join("");
          setDepositAddress(`Principal: ${result.ok.owner}\nSubaccount: ${sub}`);
        }
      } catch (e) {
        setDepositAddress("Error loading deposit address");
      }
    })();
  }, [isAuthenticated, depositToken, authClient]);

  const handleNotifyDeposit = useCallback(async () => {
    setActionLoading(true);
    setMessage(null);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const wallet = createWalletActor(agent);
      const token = TOKENS.find((t) => t.id === depositToken);
      if (!token) return;

      const result = await wallet.notifyDeposit(token.variant);
      if ("ok" in result) {
        const amount = result.ok as bigint;
        if (amount === 0n) {
          setMessage({ text: "No new deposit detected", type: "error" });
        } else {
          setMessage({
            text: `Deposited ${formatAmount(amount, token.decimals)} ${token.label}`,
            type: "success",
          });
          await loadData();
        }
      } else {
        setMessage({ text: `Error: ${(result as { err: string }).err}`, type: "error" });
      }
    } catch (e) {
      setMessage({ text: `Error: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setActionLoading(false);
    }
  }, [authClient, depositToken, loadData]);

  const handleWithdraw = useCallback(async () => {
    if (!withdrawAmount || !withdrawTo) return;
    setActionLoading(true);
    setMessage(null);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const wallet = createWalletActor(agent);
      const token = TOKENS.find((t) => t.id === withdrawToken);
      if (!token) return;

      // Convert amount to smallest unit
      const amount = BigInt(
        Math.floor(parseFloat(withdrawAmount) * 10 ** token.decimals),
      );

      // Principal.fromText equivalent — pass as raw bytes
      // For now, pass the text and let the canister handle it
      const { Principal } = await import("@icp-sdk/core/principal");
      const toPrincipal = Principal.fromText(withdrawTo);

      const result = await wallet.withdraw(token.variant, amount, {
        owner: toPrincipal.toUint8Array(),
        subaccount: [],
      });

      if ("ok" in result) {
        setMessage({ text: `Withdrawal successful (block ${result.ok})`, type: "success" });
        setWithdrawAmount("");
        setWithdrawTo("");
        await loadData();
      } else {
        setMessage({ text: `Error: ${(result as { err: string }).err}`, type: "error" });
      }
    } catch (e) {
      setMessage({ text: `Error: ${e instanceof Error ? e.message : "Unknown"}`, type: "error" });
    } finally {
      setActionLoading(false);
    }
  }, [authClient, withdrawToken, withdrawAmount, withdrawTo, loadData]);

  if (!isAuthenticated) {
    return <div style={{ padding: "2rem", color: "var(--text-secondary)" }}>Please log in.</div>;
  }

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 720, margin: "0 auto", color: "var(--text-primary)" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>Wallet</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: "2rem" }}>
        Manage your token balances. Deposit tokens to pay for external LLM calls.
      </p>

      {loading ? (
        <p style={{ color: "var(--text-secondary)" }}>Loading balances...</p>
      ) : (
        <>
          {/* Balance Cards */}
          <div style={{ display: "flex", gap: "1rem", marginBottom: "2rem", flexWrap: "wrap" }}>
            {TOKENS.map((token) => (
              <div
                key={token.id}
                style={{
                  flex: "1 1 180px",
                  padding: "1rem",
                  backgroundColor: "var(--bg-secondary)",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>
                  {token.label}
                </div>
                <div style={{ fontSize: "1.5rem", fontWeight: 600 }}>
                  {formatAmount(balances[token.id] ?? 0n, token.decimals)}
                </div>
              </div>
            ))}
          </div>

          {/* Deposit Section */}
          <div style={{ marginBottom: "1.5rem", padding: "1.25rem", backgroundColor: "var(--bg-secondary)", borderRadius: 10, border: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: "1rem", fontWeight: 500, marginBottom: "0.75rem" }}>Deposit</h3>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
              <select
                value={depositToken}
                onChange={(e) => setDepositToken(e.target.value)}
                style={{ padding: "0.4rem", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border)", borderRadius: 6, fontSize: "0.85rem" }}
              >
                {TOKENS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <button
                onClick={handleNotifyDeposit}
                disabled={actionLoading}
                style={{ padding: "0.4rem 1rem", backgroundColor: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, fontSize: "0.85rem", cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.5 : 1 }}
              >
                {actionLoading ? "..." : "Notify Deposit"}
              </button>
            </div>
            <pre style={{ fontSize: "0.75rem", color: "var(--text-secondary)", backgroundColor: "var(--bg-primary)", padding: "0.5rem", borderRadius: 6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {depositAddress || "Loading deposit address..."}
            </pre>
            <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
              Transfer tokens to this address, then click "Notify Deposit" to credit your balance.
            </p>
          </div>

          {/* Withdraw Section */}
          <div style={{ marginBottom: "1.5rem", padding: "1.25rem", backgroundColor: "var(--bg-secondary)", borderRadius: 10, border: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: "1rem", fontWeight: 500, marginBottom: "0.75rem" }}>Withdraw</h3>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
              <select
                value={withdrawToken}
                onChange={(e) => setWithdrawToken(e.target.value)}
                style={{ padding: "0.4rem", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border)", borderRadius: 6, fontSize: "0.85rem" }}
              >
                {TOKENS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <input
                type="number"
                step="0.0001"
                min="0"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="Amount"
                style={{ flex: 1, minWidth: 100, padding: "0.4rem 0.75rem", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border)", borderRadius: 6, fontSize: "0.85rem" }}
              />
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                value={withdrawTo}
                onChange={(e) => setWithdrawTo(e.target.value)}
                placeholder="Destination principal"
                style={{ flex: 1, padding: "0.4rem 0.75rem", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border)", borderRadius: 6, fontSize: "0.85rem" }}
              />
              <button
                onClick={handleWithdraw}
                disabled={actionLoading || !withdrawAmount || !withdrawTo}
                style={{ padding: "0.4rem 1rem", backgroundColor: "#ef4444", color: "#fff", border: "none", borderRadius: 6, fontSize: "0.85rem", cursor: actionLoading ? "not-allowed" : "pointer", opacity: (actionLoading || !withdrawAmount || !withdrawTo) ? 0.5 : 1 }}
              >
                {actionLoading ? "..." : "Withdraw"}
              </button>
            </div>
            <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
              Fee: {TOKENS.find((t) => t.id === withdrawToken)?.fee ?? "?"} {withdrawToken}
            </p>
          </div>

          {/* Message */}
          {message && (
            <p style={{ marginBottom: "1rem", fontSize: "0.85rem", color: message.type === "success" ? "#22c55e" : "#ef4444" }}>
              {message.text}
            </p>
          )}

          {/* Transaction History */}
          <div style={{ padding: "1.25rem", backgroundColor: "var(--bg-secondary)", borderRadius: 10, border: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: "1rem", fontWeight: 500, marginBottom: "0.75rem" }}>Transaction History</h3>
            {transactions.length === 0 ? (
              <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No transactions yet.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      <th style={{ textAlign: "left", padding: "0.5rem", color: "var(--text-secondary)" }}>Type</th>
                      <th style={{ textAlign: "left", padding: "0.5rem", color: "var(--text-secondary)" }}>Token</th>
                      <th style={{ textAlign: "right", padding: "0.5rem", color: "var(--text-secondary)" }}>Amount</th>
                      <th style={{ textAlign: "left", padding: "0.5rem", color: "var(--text-secondary)" }}>Memo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.slice(0, 50).map((tx, i) => {
                      const token = tokenLabel(tx.tokenType as Record<string, null>);
                      const decimals = TOKENS.find((t) => t.id === token)?.decimals ?? 8;
                      return (
                        <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "0.5rem" }}>
                            {txTypeLabel(tx.txType as Record<string, null>)}
                          </td>
                          <td style={{ padding: "0.5rem" }}>{token}</td>
                          <td style={{ padding: "0.5rem", textAlign: "right" }}>
                            {formatAmount(tx.amount, decimals)}
                          </td>
                          <td style={{ padding: "0.5rem", color: "var(--text-secondary)" }}>
                            {tx.memo && tx.memo.length > 0 ? tx.memo[0] : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
