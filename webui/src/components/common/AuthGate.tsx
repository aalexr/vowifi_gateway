import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { LockKeyhole } from "lucide-react";
import {
  AUTH_REQUIRED_EVENT,
  api,
  asApiError,
  type AuthStatus,
} from "../../api";

interface AuthContextValue {
  status: AuthStatus;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Login state for components below the gate (Settings session card, sidebar logout). */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside <AuthGate>");
  return ctx;
}

/**
 * Renders its children only for a logged-in client; otherwise the login form. Login is the
 * gateway host's Linux account (checked by the manager through PAM).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.authStatus());
      setError("");
    } catch (e) {
      setError(asApiError(e).message || "Gateway unreachable");
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      await refresh();
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    const onAuthRequired = () => refresh();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () =>
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, [refresh]);

  if (!status) {
    return (
      <AuthScreen>
        <p className="auth-note">{error || "Connecting…"}</p>
        {error && (
          <button className="btn btn-primary" onClick={refresh}>
            Retry
          </button>
        )}
      </AuthScreen>
    );
  }

  if (!status.authenticated) {
    return (
      <AuthScreen>
        <p className="auth-note">
          Log in with the gateway host's Linux account.
        </p>
        <LoginForm onLoggedIn={refresh} />
      </AuthScreen>
    );
  }

  return (
    <AuthContext.Provider value={{ status, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="card auth-card">
        <div className="auth-title">
          <LockKeyhole size={20} aria-hidden="true" />
          <h1>VoWiFi Gateway</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

function LoginForm({ onLoggedIn }: { onLoggedIn: () => Promise<void> }) {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(user.trim(), pw);
      await onLoggedIn();
    } catch (err) {
      setError(asApiError(err).message);
      setPw("");
      setBusy(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      <label htmlFor="auth-user">User name</label>
      <input
        id="auth-user"
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellcheck={false}
        autoFocus
        required
        value={user}
        onChange={(e) => setUser(e.currentTarget.value)}
      />
      <label htmlFor="auth-pw">Password</label>
      <input
        id="auth-pw"
        type="password"
        autoComplete="current-password"
        required
        value={pw}
        onChange={(e) => setPw(e.currentTarget.value)}
      />
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="btn btn-primary"
        type="submit"
        disabled={busy || !user.trim() || !pw}
      >
        {busy ? "Checking…" : "Log in"}
      </button>
    </form>
  );
}
