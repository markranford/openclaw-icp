/**
 * @file Full-screen login page displayed to unauthenticated users.
 *
 * Shows the OpenClaw branding, a brief description of the platform's
 * capabilities (on-chain LLMs, vetKD encryption, ICRC tokens, agent identity),
 * and a single "Login with Internet Identity" button.
 *
 * In development mode, clicking the button triggers the dev identity flow
 * (instant, no popup). In production, it opens the Internet Identity
 * authentication popup via the {@link useAuth} hook.
 *
 * @module LoginPage
 */

import { useAuth } from "./auth/useAuth";

/**
 * Landing / login page component.
 *
 * Centered vertically and horizontally in the viewport. After successful
 * login, the parent router renders the main app layout instead of this page.
 */
export default function LoginPage() {
  const { login } = useAuth();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        width: "100vw",
        gap: "2rem",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "4rem", marginBottom: "1rem" }}>🦀</div>
        <h1 style={{ fontSize: "2.5rem", fontWeight: 800, marginBottom: "0.5rem" }}>
          OpenClaw
        </h1>
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: "1.1rem",
            maxWidth: "400px",
          }}
        >
          ICP-native AI agent platform. On-chain LLMs, encrypted credentials,
          decentralized payments, and agent identity.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <button
          onClick={login}
          style={{
            padding: "0.85rem 2.5rem",
            backgroundColor: "var(--accent)",
            color: "white",
            border: "none",
            borderRadius: "10px",
            fontSize: "1.05rem",
            fontWeight: 600,
            transition: "background-color 0.2s",
          }}
        >
          Login with Internet Identity
        </button>

        <p
          style={{
            color: "var(--text-muted)",
            fontSize: "0.8rem",
            textAlign: "center",
          }}
        >
          Passkey or biometric login — no passwords needed
        </p>
      </div>

      <div
        style={{
          marginTop: "3rem",
          display: "flex",
          gap: "2rem",
          color: "var(--text-muted)",
          fontSize: "0.85rem",
        }}
      >
        <span>On-chain LLMs</span>
        <span>vetKD Encryption</span>
        <span>ICRC Tokens</span>
        <span>Agent Identity</span>
      </div>
    </div>
  );
}
