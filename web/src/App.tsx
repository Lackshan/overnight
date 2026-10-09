import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, clearReports, loadReport, setDevPlan, setToken, supabase } from "./api";
import AuthModal from "./AuthModal";
import MapView, { type LayerKey } from "./MapView";
import Panel from "./Panel";
import Search from "./Search";
import type { LiveSnapshot, PlanId, Report, Session } from "./types";

type Target = { postcode: string; lat?: number; lon?: number; area?: string };

const LONDON = { lat: 51.5072, lon: -0.1276 };

const LAYERS: { key: LayerKey; label: string; feature: string; color: string }[] = [
  { key: "aircraft", label: "Live aircraft", feature: "map.aircraft", color: "#7F77DD" },
  { key: "overflights", label: "Night flight paths", feature: "map.overflights", color: "#534AB7" },
  { key: "crime", label: "Crime", feature: "map.crime", color: "#D85A30" },
  { key: "air", label: "Air", feature: "map.air", color: "#1D9E75" },
  { key: "transport", label: "Stations", feature: "map.transport", color: "#185FA5" },
];

function postcodeFromPath() {
  const m = location.pathname.match(/^\/p\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function useDarkMode() {
  const q = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(q.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return dark;
}

export default function App() {
  const dark = useDarkMode();
  const [session, setSession] = useState<Session | null>(null);
  const [target, setTarget] = useState<Target | null>(() => {
    const pc = postcodeFromPath();
    return pc ? { postcode: pc } : null;
  });
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>({ aircraft: true, overflights: true, crime: false, air: true, transport: true });
  const [auth, setAuth] = useState<{ reason: string; thenUpgrade: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const upgradeAfterSignIn = useRef(false);

  const plan = session?.plan ?? "anonymous";

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const refreshSession = useCallback(async () => {
    try {
      const s = await api.session();
      setSession(s);
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && supabase) await supabase.auth.signOut();
      return null;
    }
  }, []);

  // Restore the Supabase session, then load what this user can see.
  useEffect(() => {
    let unsub = () => {};
    (async () => {
      if (supabase) {
        const { data } = await supabase.auth.getSession();
        setToken(data.session?.access_token ?? null);
        const { data: sub } = supabase.auth.onAuthStateChange(async (event, s) => {
          setToken(s?.access_token ?? null);
          if (event === "TOKEN_REFRESHED") return;
          clearReports();
          const fresh = await refreshSession();
          if (event === "SIGNED_IN" && upgradeAfterSignIn.current && fresh?.plan !== "pro") {
            upgradeAfterSignIn.current = false;
            startCheckout();
          }
        });
        unsub = () => sub.subscription.unsubscribe();
      }
      await refreshSession();
      await handleCheckoutReturn();
    })();
    return () => unsub();
  }, []);

  async function handleCheckoutReturn() {
    const params = new URLSearchParams(location.search);
    const status = params.get("checkout");
    if (!status) return;
    history.replaceState(null, "", location.pathname);
    if (status === "cancelled") return flash("Checkout cancelled. You haven't been charged.");
    const id = params.get("session_id");
    if (!id) return;
    try {
      const s = await api.confirm(id);
      clearReports();
      setSession(s);
      flash("You're on Pro. Everything's unlocked.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Couldn't confirm your payment yet. Refresh in a moment.");
    }
  }

  // Load the report whenever the postcode or plan changes.
  useEffect(() => {
    if (!target || !session) return;
    let stale = false;
    setError(null);
    loadReport(target.postcode, plan)
      .then((r) => {
        if (stale) return;
        setReport(r);
        if (target.lat == null) setTarget({ ...target, lat: r.place.lat, lon: r.place.lon, area: [r.place.ward, r.place.district].filter(Boolean).join(", ") });
      })
      .catch((e) => {
        if (stale) return;
        setReport(null);
        setError(e instanceof ApiError && e.status === 429 ? `${e.message} ${e.body.unlocks_on === "free" ? "Sign up free for more." : "Go Pro for unlimited lookups."}` : e.message);
      });
    return () => {
      stale = true;
    };
  }, [target?.postcode, plan, session]);

  // Poll live data every 2 seconds for wherever the map is focused. The map
  // draws aircraft a few seconds behind, so it always has the next position.
  const focus = report?.place ?? (target?.lat != null ? { lat: target.lat, lon: target.lon! } : LONDON);
  const lines = report?.lines ?? [];
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const poll = () =>
      api
        .live(focus.lat, focus.lon, lines)
        .then((r) => alive && setLive(r.snapshot))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [focus.lat, focus.lon, lines.join(","), plan, session]);

  // Back/forward between postcodes.
  useEffect(() => {
    const onPop = () => {
      const pc = postcodeFromPath();
      setReport(null);
      setTarget(pc ? { postcode: pc } : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const select = (t: Target) => {
    const pc = t.postcode.replace(/\s/g, "").toUpperCase();
    if (pc === report?.place.postcode.replace(/\s/g, "")) return;
    setReport(null);
    setTarget(t);
    history.pushState(null, "", `/p/${pc}`);
  };

  async function startCheckout() {
    try {
      const { url } = await api.checkout(location.pathname);
      location.href = url;
    } catch (e) {
      flash(e instanceof Error ? e.message : "Couldn't start checkout.");
    }
  }

  const unlock = (feature: string) => {
    const next = session?.features[feature]?.unlocks_on;
    const signedIn = !!session?.email;
    if (!signedIn) {
      upgradeAfterSignIn.current = next === "pro";
      setAuth({
        reason: next === "pro" ? "Create a free account first, then you'll go straight to checkout." : `Sign up free to see ${session?.features[feature]?.label.toLowerCase()}.`,
        thenUpgrade: next === "pro",
      });
      return;
    }
    if (next === "pro") startCheckout();
  };

  const signOut = async () => {
    setMenu(false);
    await supabase?.auth.signOut();
  };

  const manageBilling = async () => {
    setMenu(false);
    try {
      const { url } = await api.portal(location.pathname);
      location.href = url;
    } catch (e) {
      flash(e instanceof Error ? e.message : "Couldn't open billing.");
    }
  };

  const aircraftAllowed = session?.features["map.aircraft"]?.allowed ?? false;

  return (
    <div className="app">
      <MapView
        target={target?.lat != null ? { lat: target.lat, lon: target.lon! } : null}
        report={report}
        live={live && aircraftAllowed ? { aircraft: live.aircraft ?? [], now: live.now } : null}
        visible={visible}
        dark={dark}
      />

      <div className="top-left">
        <Search value={report?.place.postcode ?? ""} onSelect={select} onPreview={(pc) => session && loadReport(pc, plan).catch(() => {})} />
        <div className="live-pill">
          <span className="pulse" aria-hidden="true" />
          Live · <Clock /> · <span className="num">{live?.aircraft_nearby ?? "–"}</span> aircraft nearby
        </div>
      </div>

      <div className="top-right">
        {session?.email ? (
          <div className="account">
            <button className="avatar" onClick={() => setMenu(!menu)} aria-label="Account menu" aria-expanded={menu}>
              {session.email[0].toUpperCase()}
            </button>
            {menu && (
              <div className="menu">
                <p className="small">{session.email}</p>
                <p className="small muted">{session.plans[session.plan]?.name} plan</p>
                {session.plan === "pro" ? (
                  <button onClick={manageBilling}>Manage billing</button>
                ) : (
                  <button className="primary" onClick={() => (setMenu(false), startCheckout())}>
                    Go Pro · {session.plans.pro?.price_label}
                  </button>
                )}
                <button onClick={signOut}>Sign out</button>
              </div>
            )}
          </div>
        ) : (
          supabase && (
            <button onClick={() => setAuth({ reason: "See night flight paths, details and what's happening nearby.", thenUpgrade: false })}>Sign in</button>
          )
        )}
      </div>

      <div className="layers">
        {LAYERS.map((l) => {
          const allowed = session?.features[l.feature]?.allowed ?? true;
          return (
            <button
              key={l.key}
              className={`chip ${visible[l.key] && allowed ? "on" : ""}`}
              onClick={() => (allowed ? setVisible({ ...visible, [l.key]: !visible[l.key] }) : unlock(l.feature))}
              aria-pressed={visible[l.key] && allowed}
            >
              <span className="dot" style={{ background: l.color }} />
              {l.label}
              {!allowed && <span className="muted"> · locked</span>}
            </button>
          );
        })}
      </div>

      <Panel
        session={session}
        report={report}
        error={error}
        heading={target}
        live={live}
        onUnlock={unlock}
        onPick={(pc) => select({ postcode: pc })}
      />

      {session?.dev_mode && (
        <label className="dev">
          View as
          <select
            value={plan}
            onChange={(e) => {
              setDevPlan(e.target.value);
              clearReports();
              refreshSession();
            }}
          >
            {(["anonymous", "free", "pro"] as PlanId[]).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}

      {auth && (
        <AuthModal
          reason={auth.reason}
          onClose={() => {
            setAuth(null);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(t);
  }, []);
  return <span className="num">{now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>;
}
