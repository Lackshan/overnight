import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, clearReports, loadReport, setDevPlan, setToken, supabase } from "./api";
import AuthModal from "./AuthModal";
import { COMPARE_LETTERS, compareColor, formatPostcode, loadCompare, samePostcode, saveCompare, type CompareItem } from "./compare";
import CompareView from "./CompareView";
import FlightSlider from "./FlightSlider";
import { optionKey } from "./nightBadges";
import { addLocal, localRecents, removeLocal, syncOnSignIn, type RecentSearch } from "./recent";
import MapView, { type LayerKey, type MapHandle } from "./MapView";
import Panel from "./Panel";
import Search from "./Search";
import type { FlightPaths, LiveSnapshot, PlanId, Report, Session } from "./types";

type Target = { postcode: string; lat?: number; lon?: number; area?: string };

const LONDON = { lat: 51.5072, lon: -0.1276 };

const LAYERS: { key: LayerKey; label: string; feature: string; color: string }[] = [
  { key: "aircraft", label: "Live aircraft", feature: "map.aircraft", color: "#7F77DD" },
  { key: "overflights", label: "Flight paths", feature: "map.overflights", color: "#534AB7" },
  { key: "crime", label: "Crime", feature: "map.crime", color: "#D85A30" },
  { key: "air", label: "Air", feature: "map.air", color: "#1D9E75" },
  { key: "transport", label: "Transport", feature: "map.transport", color: "#185FA5" },
  { key: "health", label: "Health", feature: "map.health", color: "#007F3B" },
];

const isComparePath = () => location.pathname.startsWith("/compare");

// /compare?pc=E16AN,SW111AA, falling back to the list saved in this browser.
function compareFromURL(): string[] {
  const pc = new URLSearchParams(location.search).get("pc");
  return pc ? pc.split(",").map((p) => p.trim()).filter(Boolean).map(formatPostcode).slice(0, 4) : loadCompare();
}

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
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>({ aircraft: true, overflights: true, crime: false, air: true, transport: true, health: true });
  const [auth, setAuth] = useState<{ reason: string; thenUpgrade: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const upgradeAfterSignIn = useRef(false);
  // The visible map area; read by the live poll without restarting it.
  const bounds = useRef<[number, number, number, number] | undefined>(undefined);
  const mapRef = useRef<MapHandle>(null);
  const [flightPaths, setFlightPaths] = useState<FlightPaths | null>(null);
  const [nightHighlight, setNightHighlight] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const [compareList, setCompareList] = useState<string[]>(() => (isComparePath() ? compareFromURL() : loadCompare()));
  const [compareOpen, setCompareOpen] = useState(isComparePath);
  const [compareItems, setCompareItems] = useState<CompareItem[]>([]);

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
      flash("Thanks for supporting Overnight. You can now compare postcodes: use + Compare on any report.");
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
        recordRecent(r);
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
        .live(focus.lat, focus.lon, lines, bounds.current)
        .then((r) => alive && setLive(r.snapshot))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [focus.lat, focus.lon, lines.join(","), plan, session]);

  // Recent searches: the account's when signed in (merging any made as a
  // guest), otherwise this browser's.
  const signedIn = !!session?.email;
  const recentLimit = session?.limits["recent.searches"] || 10;
  useEffect(() => {
    if (!session) return;
    if (signedIn) syncOnSignIn().then(setRecents).catch(() => setRecents([]));
    else setRecents(localRecents(recentLimit));
  }, [signedIn, recentLimit, !!session]);

  const recordRecent = (r: Report) => {
    const entry: RecentSearch = {
      postcode: r.place.postcode,
      area: [r.place.ward, r.place.district].filter(Boolean).join(", "),
      lat: r.place.lat,
      lon: r.place.lon,
      night_score: r.night?.score,
      at: new Date().toISOString(),
    };
    if (signedIn) api.addRecent(entry).then((res) => setRecents(res.recent)).catch(() => {});
    else setRecents(addLocal(entry, recentLimit));
  };

  const removeRecent = (postcode: string | null) => {
    if (signedIn) api.removeRecent(postcode).then((res) => setRecents(res.recent)).catch(() => {});
    else setRecents(removeLocal(postcode));
  };

  // Flight paths are the same for everyone; load them once the plan allows it.
  const pathsAllowed = session?.features["map.overflights"]?.allowed ?? false;
  useEffect(() => {
    if (!pathsAllowed) return setFlightPaths(null);
    api.flightPaths().then(setFlightPaths).catch(() => {});
  }, [pathsAllowed]);

  // Keep the comparison list saved, and in the address bar while it's open.
  useEffect(() => {
    saveCompare(compareList);
    if (compareOpen) history.replaceState(null, "", compareList.length ? `/compare?pc=${compareList.map((p) => p.replace(/\s/g, "")).join(",")}` : "/compare");
  }, [compareList.join(","), compareOpen]);

  const compareMax = session?.limits["compare.postcodes"] || 4;
  const canCompare = session?.features["compare"]?.allowed ?? false;
  const addToCompare = (raw: string) => {
    if (!canCompare) return unlock("compare");
    const pc = formatPostcode(raw);
    setCompareList((list) => (list.some((p) => samePostcode(p, pc)) || list.length >= compareMax ? list : [...list, pc]));
  };
  const openCompare = () => {
    setCompareOpen(true);
    history.pushState(null, "", "/compare");
  };
  const closeCompare = () => {
    setCompareOpen(false);
    setCompareItems([]);
    history.pushState(null, "", report ? `/p/${report.place.postcode.replace(/\s/g, "")}` : "/");
  };

  // Back/forward between postcodes and the comparison.
  useEffect(() => {
    const onPop = () => {
      if (isComparePath()) {
        setCompareOpen(true);
        setCompareList(compareFromURL());
        return;
      }
      setCompareOpen(false);
      setCompareItems([]);
      const pc = postcodeFromPath();
      setReport(null);
      setTarget(pc ? { postcode: pc } : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const select = (t: Target) => {
    const pc = t.postcode.replace(/\s/g, "").toUpperCase();
    setCompareOpen(false);
    setCompareItems([]);
    if (pc === report?.place.postcode.replace(/\s/g, "")) return history.pushState(null, "", `/p/${pc}`);
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
        reason: next === "pro" ? "Create a free account first, then you'll go straight to the optional one-off payment." : `Sign up free to see ${session?.features[feature]?.label.toLowerCase()}.`,
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

  const aircraftAllowed = session?.features["map.aircraft"]?.allowed ?? false;

  return (
    <div className={compareOpen ? "app comparing" : "app"}>
      <MapView
        ref={mapRef}
        flightPaths={flightPaths}
        nightHighlight={nightHighlight}
        comparePins={compareOpen ? compareItems.filter((it) => it.place).map((it) => ({ lat: it.place!.lat, lon: it.place!.lon, label: COMPARE_LETTERS[compareItems.indexOf(it)], color: compareColor(compareItems.indexOf(it)), postcode: it.place!.postcode })) : []}
        target={target?.lat != null ? { lat: target.lat, lon: target.lon! } : null}
        report={report}
        live={live && aircraftAllowed ? { aircraft: live.aircraft ?? [], now: live.now } : null}
        visible={visible}
        dark={dark}
        onBounds={(b) => (bounds.current = b)}
      />

      <div className="top-left">
        <Search
          value={report?.place.postcode ?? ""}
          recents={recents}
          onSelect={select}
          onPreview={(pc) => session && loadReport(pc, plan).catch(() => {})}
          onRemoveRecent={removeRecent}
        />
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
                  <p className="small supporter">Thanks for supporting Overnight</p>
                ) : (
                  <button className="primary" onClick={() => (setMenu(false), startCheckout())}>
                    Support · {session.plans.pro?.price_label}
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

      {visible.overflights && flightPaths && (
        <FlightSlider hours={flightPaths.hours} days={flightPaths.days} onPosition={(p) => mapRef.current?.setFlightHour(p)} />
      )}

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

      {compareOpen ? (
        <CompareView
          session={session}
          postcodes={compareList}
          recents={recents}
          onAdd={addToCompare}
          onRemove={(pc) => setCompareList((list) => list.filter((p) => !samePostcode(p, pc)))}
          onClose={closeCompare}
          onOpen={(pc) => select({ postcode: pc })}
          onUnlock={unlock}
          onItems={setCompareItems}
        />
      ) : (
      <Panel
          session={session}
          onCompare={report ? () => addToCompare(report.place.postcode) : undefined}
          inCompare={!!report && compareList.some((p) => samePostcode(p, report.place.postcode))}
          report={report}
          error={error}
          heading={target}
          live={live}
          onUnlock={unlock}
          onPick={(pc) => select({ postcode: pc })}
          recents={recents}
          onNightHover={setNightHighlight}
          onPlaceSelect={(lat, lon, key) => {
            if (!visible.health) setVisible({ ...visible, health: true });
            setNightHighlight(key);
            mapRef.current?.flyTo(lat, lon);
          }}
          onNightSelect={(o) => {
            if (!visible.transport) setVisible({ ...visible, transport: true });
            setNightHighlight(optionKey(o));
            mapRef.current?.flyTo(o.lat, o.lon);
          }}
        />
      )}

      {!compareOpen && compareList.length > 0 && (
        <div className="cmp-tray" role="region" aria-label="Postcodes to compare">
          {compareList.map((pc, i) => (
            <span key={pc} className="cmp-tray-item">
              <span className="cmp-letter" style={{ background: compareColor(i) }}>
                {COMPARE_LETTERS[i]}
              </span>
              <span className="num">{pc}</span>
              <button className="cmp-x" onClick={() => setCompareList((list) => list.filter((p) => p !== pc))} aria-label={`Remove ${pc}`}>
                ×
              </button>
            </span>
          ))}
          <button className="primary" onClick={openCompare}>
            {compareList.length < 2 ? "Add one more to compare" : `Compare ${compareList.length}`}
          </button>
        </div>
      )}

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
