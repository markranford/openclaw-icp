/**
 * @file Small balance indicator shown in the chat header when an external
 * (paid) model is selected. Displays the user's ICP balance and the
 * per-request fee for the currently selected model.
 *
 * The component fetches the balance from the Wallet canister and the
 * per-model fee from the Gateway canister on mount and when the model
 * changes. Both queries are lightweight (no consensus needed).
 */

import { useState, useEffect } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import { createWalletActor } from "../api/wallet.did";
import { createGatewayActor } from "../api/gateway.did";
import type { Model } from "./ChatPage";

/** Default fallback fee (0.0001 ICP in e8s) if gateway query fails. */
const DEFAULT_FEE_E8S = 10_000n;

/** Format e8s as a human-readable ICP string (up to 4 decimal places). */
function formatIcp(e8s: bigint): string {
  const whole = e8s / 100_000_000n;
  const frac = e8s % 100_000_000n;
  // Show up to 4 decimal places, trimming trailing zeros
  const fracStr = frac.toString().padStart(8, "0").slice(0, 4).replace(/0+$/, "");
  if (fracStr === "") return `${whole}`;
  return `${whole}.${fracStr}`;
}

/** Extract the model key string from the UI Model type. */
function modelKey(model: Model): string | null {
  if ("External" in model) return model.External;
  return null;
}

interface BalanceIndicatorProps {
  model: Model;
}

export default function BalanceIndicator({ model }: BalanceIndicatorProps) {
  const { authClient } = useAuth();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [fee, setFee] = useState<bigint | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      try {
        const agent = await createAgent(authClient ?? undefined);
        const wallet = createWalletActor(agent);
        const gateway = createGatewayActor(agent);

        // Fetch balance and model fees in parallel
        const [balResult, feesResult] = await Promise.all([
          wallet.getTokenBalance({ ICP: null }),
          gateway.getModelFees(),
        ]);

        if (cancelled) return;

        // Parse balance
        if ("ok" in balResult) {
          setBalance(balResult.ok);
        }

        // Find fee for current model
        const key = modelKey(model);
        if (key && Array.isArray(feesResult)) {
          const entry = feesResult.find(
            ([k]: [string, bigint]) => k === key,
          );
          setFee(entry ? entry[1] : DEFAULT_FEE_E8S);
        } else {
          setFee(DEFAULT_FEE_E8S);
        }
      } catch {
        // Silently ignore — the indicator will just not show data
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, [authClient, model]);

  // Don't render anything if we have no data yet
  if (balance === null && fee === null) return null;

  const isLow = balance !== null && fee !== null && balance < fee;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        fontSize: "0.75rem",
        color: isLow ? "var(--error, #ef4444)" : "var(--text-muted, #888)",
        padding: "0.25rem 0.5rem",
        borderRadius: "4px",
        backgroundColor: "var(--bg-tertiary, rgba(0,0,0,0.05))",
        whiteSpace: "nowrap",
      }}
    >
      {balance !== null && (
        <span title="Your ICP balance in the wallet">
          {formatIcp(balance)} ICP
        </span>
      )}
      {balance !== null && fee !== null && (
        <span style={{ opacity: 0.5 }}>|</span>
      )}
      {fee !== null && (
        <span title="Fee per request for the selected model">
          {formatIcp(fee)} / req
        </span>
      )}
    </div>
  );
}
