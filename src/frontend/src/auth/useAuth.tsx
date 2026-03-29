/**
 * @file Authentication context and hook for the OpenClaw frontend.
 *
 * Provides a React context ({@link AuthContext}) and hook ({@link useAuth})
 * that manage the user's authentication state throughout the app. The module
 * supports two authentication modes:
 *
 * ## Production mode (mainnet)
 *
 * Uses **Internet Identity** via `@icp-sdk/auth/client`. The `login()` callback
 * opens the II popup, and on success stores a delegation identity in the
 * {@link AuthClient}. The delegation is valid for 8 hours.
 *
 * ## Development mode (localhost)
 *
 * Uses a locally-generated **Ed25519 keypair** stored in `localStorage` under
 * the key `"openclaw_dev_identity"`. This avoids the need for an Internet
 * Identity canister during development and ensures the principal stays stable
 * across page reloads (important because canister state is principal-keyed).
 *
 * The `login()` callback in dev mode simply loads the stored identity without
 * any popup or network call.
 *
 * ## Usage
 *
 * Wrap the app tree with `<AuthProvider>`, then call `useAuth()` in any child
 * component to access authentication state and actions:
 *
 * ```tsx
 * const { isAuthenticated, principal, login, logout } = useAuth();
 * ```
 *
 * @module auth/useAuth
 */

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

/**
 * The well-known canister ID for the Internet Identity service.
 * This is the same on both mainnet and local replicas (the NNS canister).
 */
const II_CANISTER_ID = "rdmx6-jaaaa-aaaaa-aaadq-cai";

/**
 * Whether the app is running in local development mode.
 * Checks for `localhost` or `*.localhost` hostnames (the pattern `dfx` uses).
 */
const isLocal =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" ||
    window.location.hostname.endsWith(".localhost"));

/**
 * Shape of the authentication context value provided to consumers.
 *
 * @property isAuthenticated - `true` after a successful login.
 * @property isLoading - `true` while the initial auth check is in progress.
 * @property principal - The authenticated user's textual principal, or `null`.
 * @property authClient - The underlying {@link AuthClient} instance (production mode).
 * @property login - Trigger the login flow (II popup in production, instant in dev).
 * @property logout - Clear the session and reset state.
 */
interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  principal: string | null;
  authClient: AuthClient | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * React context that distributes authentication state.
 * Consumers should use the {@link useAuth} hook rather than accessing this directly.
 */
const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  isLoading: true,
  principal: null,
  authClient: null,
  login: async () => {},
  logout: async () => {},
});

/**
 * Retrieve or generate a persistent Ed25519 identity for local development.
 *
 * On first call, generates a new keypair and stores it as JSON in
 * `localStorage["openclaw_dev_identity"]`. On subsequent calls, deserializes
 * the stored keypair so the principal remains stable across sessions.
 *
 * This is critical because all canister state (conversations, balances,
 * profiles) is keyed by principal. A new identity on every reload would make
 * previously stored data inaccessible.
 *
 * @returns A deterministic {@link Ed25519KeyIdentity} for the current browser.
 */
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

/**
 * Authentication provider component.
 *
 * Wraps the React tree and provides auth state via {@link AuthContext}.
 * On mount, it creates an {@link AuthClient} and checks for an existing
 * delegation (e.g. from a previous session that hasn't expired).
 *
 * @param children - The React subtree that needs access to auth state.
 */
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

/**
 * Hook to access the authentication context.
 *
 * Must be called inside an {@link AuthProvider}. Returns the current auth
 * state and login/logout actions.
 *
 * @returns The {@link AuthContextType} value from the nearest provider.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { isAuthenticated, principal, login, logout } = useAuth();
 *   if (!isAuthenticated) return <button onClick={login}>Login</button>;
 *   return <span>Logged in as {principal}</span>;
 * }
 * ```
 */
export function useAuth() {
  return useContext(AuthContext);
}
