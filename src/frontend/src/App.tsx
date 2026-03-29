import { Routes, Route } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/useAuth";
import { ConversationProvider } from "./chat/ConversationContext";
import ChatPage from "./chat/ChatPage";
import SettingsPage from "./settings/SettingsPage";
import WalletPage from "./wallet/WalletPage";
import IdentityPage from "./identity/IdentityPage";
import CommsPage from "./comms/CommsPage";
import PersonaBuilder from "./persona/PersonaBuilder";
import GroupChatPage from "./groupchat/GroupChatPage";
import MemoryPage from "./memory/MemoryPage";
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
    <ConversationProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/identity" element={<IdentityPage />} />
          <Route path="/comms" element={<CommsPage />} />
          <Route path="/personas" element={<PersonaBuilder />} />
          <Route path="/group-chat" element={<GroupChatPage />} />
          <Route path="/group-chat/:id" element={<GroupChatPage />} />
          <Route path="/memory" element={<MemoryPage />} />
        </Routes>
      </Layout>
    </ConversationProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
