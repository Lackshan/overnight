import { useEffect, useState } from "react";
import { supabase } from "./api";

interface Props {
  reason: string;
  onClose: () => void;
}

export default function AuthModal({ reason, onClose }: Props) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email)) return setError("Enter a valid email address.");
    if (password.length < 8) return setError("Use at least 8 characters for your password.");
    if (!supabase) return setError("Sign-in isn't set up on this server yet.");
    setBusy(true);
    const { data, error } =
      mode === "signup" ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    if (mode === "signup" && !data.session) return setInfo("Check your email to confirm your account, then sign in.");
    onClose(); // the auth listener in App takes it from here
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit} noValidate>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2>{mode === "signup" ? "Create your free account" : "Welcome back"}</h2>
        <p className="muted small">{reason}</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => (setEmail(e.target.value), setError(null))} placeholder="name@example.com" autoFocus />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => (setPassword(e.target.value), setError(null))}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </label>
        {error && <p className="error small">{error}</p>}
        {info && <p className="info small">{info}</p>}
        <button className="primary wide" disabled={busy}>
          {busy ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>
        <p className="small muted center">
          {mode === "signup" ? "Already have an account? " : "New here? "}
          <button type="button" className="link" onClick={() => (setMode(mode === "signup" ? "signin" : "signup"), setError(null), setInfo(null))}>
            {mode === "signup" ? "Sign in" : "Create an account"}
          </button>
        </p>
      </form>
    </div>
  );
}
