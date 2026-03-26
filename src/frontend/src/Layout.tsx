import { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "./auth/useAuth";

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { principal, logout } = useAuth();
  const location = useLocation();

  const navItems = [
    { path: "/", label: "Chat", icon: "💬" },
    { path: "/wallet", label: "Wallet", icon: "💰" },
    { path: "/identity", label: "Identity", icon: "🪪" },
    { path: "/settings", label: "Settings", icon: "⚙️" },
  ];

  return (
    <div style={{ display: "flex", width: "100%", minHeight: "100vh" }}>
      {/* Sidebar */}
      <aside
        style={{
          width: "var(--sidebar-width)",
          backgroundColor: "var(--bg-secondary)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          padding: "1rem",
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div
          style={{
            fontSize: "1.4rem",
            fontWeight: 700,
            marginBottom: "2rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span style={{ fontSize: "1.6rem" }}>🦀</span>
          <span>OpenClaw</span>
          <span
            style={{
              fontSize: "0.65rem",
              backgroundColor: "var(--accent)",
              color: "white",
              padding: "2px 6px",
              borderRadius: "4px",
              fontWeight: 500,
            }}
          >
            ICP
          </span>
        </div>

        {/* New Chat Button */}
        <Link
          to="/"
          style={{
            display: "block",
            padding: "0.75rem 1rem",
            backgroundColor: "var(--accent)",
            color: "white",
            borderRadius: "8px",
            textAlign: "center",
            fontWeight: 600,
            marginBottom: "1.5rem",
            transition: "background-color 0.2s",
          }}
        >
          + New Chat
        </Link>

        {/* Navigation */}
        <nav style={{ flex: 1 }}>
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                padding: "0.65rem 0.75rem",
                borderRadius: "6px",
                color:
                  location.pathname === item.path
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                backgroundColor:
                  location.pathname === item.path
                    ? "var(--bg-tertiary)"
                    : "transparent",
                marginBottom: "0.25rem",
                transition: "all 0.15s",
                fontSize: "0.95rem",
              }}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>

        {/* User info */}
        <div
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: "1rem",
            fontSize: "0.8rem",
            color: "var(--text-muted)",
          }}
        >
          <div style={{ marginBottom: "0.5rem", wordBreak: "break-all" }}>
            {principal ? `${principal.slice(0, 12)}...${principal.slice(-5)}` : ""}
          </div>
          <button
            onClick={logout}
            style={{
              background: "none",
              border: "1px solid var(--border)",
              color: "var(--text-secondary)",
              padding: "0.4rem 0.75rem",
              borderRadius: "6px",
              fontSize: "0.8rem",
              width: "100%",
            }}
          >
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {children}
      </main>
    </div>
  );
}
