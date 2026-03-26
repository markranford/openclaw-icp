import { Routes, Route } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/useAuth";
import ChatPage from "./chat/ChatPage";
import SettingsPage from "./settings/SettingsPage";
import WalletPage from "./wallet/WalletPage";
import IdentityPage from "./identity/IdentityPage";
import Layout from "./Layout";
import LoginPage from "./LoginPage";

function AppContent() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        width: "100vw",
        color: "var(--text-secondary)",
        fontSize: "1.1rem",
      }}>
        Loading OpenClaw...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/identity" element={<IdentityPage />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
