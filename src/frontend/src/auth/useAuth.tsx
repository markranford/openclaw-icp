import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import { AuthClient } from "@icp-sdk/auth/client";
import { Ed25519KeyIdentity } from "@dfinity/identity";

// Internet Identity canister ID (same on mainnet and local)
const II_CANISTER_ID = "rdmx6-jaaaa-aaaaa-aaadq-cai";

const isLocal =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" ||
    window.location.hostname.endsWith(".localhost"));

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  principal: string | null;
  authClient: AuthClient | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  isLoading: true,
  principal: null,
  authClient: null,
  login: async () => {},
  logout: async () => {},
});

// Persist a dev identity in localStorage so the principal stays stable
function getOrCreateDevIdentity(): Ed25519KeyIdentity {
  const KEY = "openclaw_dev_identity";
  const stored = localStorage.getItem(KEY);
  if (stored) {
    try {
      return Ed25519KeyIdentity.fromJSON(stored);
    } catch {
      // corrupted — regenerate
    }
  }
  const id = Ed25519KeyIdentity.generate();
  localStorage.setItem(KEY, JSON.stringify(id.toJSON()));
  return id;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [principal, setPrincipal] = useState<string | null>(null);

  // Initialize auth client on mount
  useEffect(() => {
    AuthClient.create().then(async (client: AuthClient) => {
      setAuthClient(client);
      const authed = await client.isAuthenticated();
      if (authed) {
        const identity = client.getIdentity();
        setPrincipal(identity.getPrincipal().toText());
        setIsAuthenticated(true);
      }
      setIsLoading(false);
    });
  }, []);

  const login = useCallback(async () => {
    if (isLocal) {
      // Dev mode: use a local Ed25519 identity (no II popup needed)
      const devIdentity = getOrCreateDevIdentity();
      setPrincipal(devIdentity.getPrincipal().toText());
      setIsAuthenticated(true);
      return;
    }

    // Production: use Internet Identity
    if (!authClient) return;
    await authClient.login({
      identityProvider: "https://identity.ic0.app",
      maxTimeToLive: BigInt(8 * 60 * 60 * 1_000_000_000), // 8 hours
      onSuccess: () => {
        const identity = authClient.getIdentity();
        setPrincipal(identity.getPrincipal().toText());
        setIsAuthenticated(true);
      },
      onError: (error: unknown) => {
        console.error("Login failed:", error);
      },
    });
  }, [authClient]);

  const logout = useCallback(async () => {
    if (isLocal) {
      setIsAuthenticated(false);
      setPrincipal(null);
      return;
    }
    if (!authClient) return;
    await authClient.logout();
    setIsAuthenticated(false);
    setPrincipal(null);
  }, [authClient]);

  return (
    <AuthContext.Provider
      value={{ isAuthenticated, isLoading, principal, authClient, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
