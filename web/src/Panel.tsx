import { useEffect, useRef, useState, type ReactNode } from "react";
import GettingHome from "./GettingHome";
import type { LiveSnapshot, NightOption, Point, Report, Section, Session } from "./types";

interface Props {
  session: Session | null;
  report: Report | null;
  error: string | null;
  heading: { postcode: string; area?: string } | null;
  live: LiveSnapshot | null;
  onUnlock: (feature: string) => void;
  onPick: (postcode: string) => void;
  onNightHover?: (key: string | null) => void;
  onNightSelect?: (o: NightOption) => void;
}

const EXAMPLES = ["E1 6AN", "SW11 1AA", "TW3 3AD", "SE15 4QL", "E16 2PX"];
// The timeline runs 6pm to 5pm so the night sits in the middle.
const ORDER = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const isNight = (h: number) => h >= 23 || h < 6;
type View = "night" | "day" | number;

export function scoreColor(s: number | null | undefined) {
  if (s == null) return "var(--text-muted)";
  if (s >= 70) return "var(--good)";
  if (s >= 45) return "var(--ok)";
  return "var(--bad)";
}

export function hourLabel(h: number) {
  if (h === 0) return "midnight";
  if (h === 12) return "midday";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export default function Panel({ session, report, error, heading, live, onUnlock, onPick, onNightHover, onNightSelect }: Props) {
  // "night" and "day" show the summaries; a number shows that hour (Pro).
  const [view, setView] = useState<View>("night");

  if (!heading) {
    return (
      <aside className="panel">
        <p className="eyebrow">Overnight</p>
        <h1>What's your street like at 3am?</h1>
        <p className="muted">
          You viewed the flat on a Saturday afternoon. See what it's like when you're trying to sleep: planes, police helicopters, night buses, air and
          crime, hour by hour, from live and recorded data.
        </p>
        <p className="label">Try one</p>
        <div className="chips">
          {EXAMPLES.map((pc) => (
            <button key={pc} className="chip num" onClick={() => onPick(pc)}>
              {pc}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  const can = (f: string) => session?.features[f]?.allowed ?? false;
  const r = report;
  const timeline = !!r?.hourly;

  return (
    <aside className="panel">
      <header className="panel-head">
        <div>
          <h1 className="num">{r?.place.postcode ?? heading.postcode.toUpperCase()}</h1>
          <p className="muted small">{r ? [r.place.ward, r.place.district].filter(Boolean).join(", ") : heading.area || " "}</p>
        </div>
        {session && <span className={`plan plan-${session.plan}`}>{session.plans[session.plan]?.name}</span>}
      </header>

      {error ? (
        <p className="error">{error}</p>
      ) : !r ? (
        <Skeleton />
      ) : (
        <>
          {r.night && r.day ? (
            <div className="scores">
              <ScoreTile icon="moon" label="Overnight" sub="11pm–6am" score={r.night.score} band={r.night.band} />
              <ScoreTile icon="sun" label="Daytime" sub="8am–8pm" score={r.day.score} band={r.day.band} />
            </div>
          ) : (
            <Locked feature="report.score" session={session} onUnlock={onUnlock} />
          )}

          <div className="view-row">
            <div className="seg" role="group" aria-label="Show">
              {(["night", "day"] as const).map((v) => (
                <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)} aria-pressed={view === v}>
                  {v === "night" ? "Night" : "Day"}
                </button>
              ))}
            </div>
            {!timeline && <Locked feature="report.timeline" session={session} onUnlock={onUnlock} compact text="Every hour" />}
          </div>
          {timeline && <Timeline hourly={r.hourly!} hour={typeof view === "number" ? view : null} onHour={setView} />}

          {r.sections ? (
            <div className="sections">
              {r.sections.map((s) => (
                <SectionRow key={s.id} s={s} view={view} />
              ))}
              {!can("report.details") && <Locked feature="report.details" session={session} onUnlock={onUnlock} compact />}
            </div>
          ) : (
            <Locked feature="report.sections" session={session} onUnlock={onUnlock} />
          )}

          {r.getting_home ? (
            <GettingHome data={r.getting_home} onHover={onNightHover} onSelect={onNightSelect} />
          ) : (
            r.sections && (
              <>
                <h2>Getting home after midnight</h2>
                <Locked feature="report.details" session={session} onUnlock={onUnlock} compact text="Every bus and Tube that runs after midnight, night by night" />
              </>
            )
          )}

          <Feed live={live} session={session} onUnlock={onUnlock} />

          <h2>Crime by category</h2>
          {r.breakdown ? (
            <Breakdown items={r.breakdown} />
          ) : (
            <Locked feature="safety.breakdown" session={session} onUnlock={onUnlock}>
              <Breakdown items={fakeBreakdown} />
            </Locked>
          )}

          <p className="footnote small muted">
            Planes and helicopters: {r.history_days} day{r.history_days === 1 ? "" : "s"} of recorded ADS-B data, plus live tracking. Air: London Air
            Quality Network. Crime: data.police.uk. Transport: TfL.
          </p>
        </>
      )}
    </aside>
  );
}

function ScoreTile({ icon, label, sub, score, band }: { icon: "moon" | "sun"; label: string; sub: string; score: number; band: string }) {
  return (
    <div className={`score-tile ${icon}`}>
      <div className="score-top">
        {icon === "moon" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        )}
        <span>{label}</span>
        <span className="muted small">{sub}</span>
      </div>
      <div className="score-num">
        <span className="num big" style={{ color: scoreColor(score) }}>
          {score}
        </span>
        <span className="band">{band}</span>
      </div>
    </div>
  );
}

// A 24-hour strip you can drag across. Each bar is the overall score for that hour.
function Timeline({ hourly, hour, onHour }: { hourly: number[]; hour: number | null; onHour: (h: number) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const pick = (clientX: number) => {
    const rect = strip.current!.getBoundingClientRect();
    const i = Math.max(0, Math.min(23, Math.floor(((clientX - rect.left) / rect.width) * 24)));
    onHour(ORDER[i]);
  };
  const idx = hour == null ? -1 : ORDER.indexOf(hour);
  return (
    <div className="timeline">
      <div className="timeline-head">
        <span className="timeline-hour">{hour == null ? "Drag to pick an hour" : hourLabel(hour)}</span>
        {hour != null && (
          <span className="num" style={{ color: scoreColor(hourly[hour]) }}>
            {hourly[hour]}
          </span>
        )}
      </div>
      <div
        ref={strip}
        className="strip"
        role="slider"
        aria-label="Hour of the day"
        aria-valuemin={0}
        aria-valuemax={23}
        aria-valuenow={hour ?? 3}
        aria-valuetext={hour == null ? "none" : hourLabel(hour)}
        tabIndex={0}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          pick(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && pick(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onKeyDown={(e) => {
          const i = idx < 0 ? ORDER.indexOf(3) : idx;
          if (e.key === "ArrowLeft") onHour(ORDER[Math.max(0, i - 1)]);
          if (e.key === "ArrowRight") onHour(ORDER[Math.min(23, i + 1)]);
        }}
      >
        <div className="night-band" style={{ left: `${(5 / 24) * 100}%`, width: `${(7 / 24) * 100}%` }} />
        {ORDER.map((h) => (
          <span key={h} className={`strip-bar ${h === hour ? "sel" : ""}`}>
            <span style={{ height: `${18 + (hourly[h] / 100) * 82}%`, background: scoreColor(hourly[h]) }} />
          </span>
        ))}
        {idx >= 0 && <div className="strip-thumb" style={{ left: `${((idx + 0.5) / 24) * 100}%` }} />}
      </div>
      <div className="strip-axis small muted">
        <span>6pm</span>
        <span>midnight</span>
        <span>6am</span>
        <span>midday</span>
        <span>5pm</span>
      </div>
    </div>
  );
}

function pointAt(s: Section, h: number): Point | null | undefined {
  return s.hourly?.[h];
}

function valueText(s: Section, p: Point | null | undefined) {
  if (!p) return "";
  const v = p.value;
  switch (s.id) {
    case "aircraft":
      return v < 0.5 ? "no flights" : `${v.toFixed(v < 10 ? 1 : 0)} flights`;
    case "helicopters":
      return v < 0.1 ? "none" : `${v.toFixed(1)} min`;
    case "air":
      return `${Math.round(v)} µg/m³`;
    case "safety":
      return `~${v < 10 ? v.toFixed(1) : Math.round(v)} a month`;
    default:
      return "";
  }
}

function SectionRow({ s, view }: { s: Section; view: View }) {
  const [open, setOpen] = useState(false);
  const hour = typeof view === "number" ? view : null;
  const p = hour == null ? undefined : pointAt(s, hour);
  const nightish = view === "night" || (hour != null && isNight(hour));
  const score = p?.score ?? (nightish ? s.night : s.day);
  const hasMore = !!s.details?.length || !!s.note;
  return (
    <div className={`section ${open ? "open" : ""}`}>
      <button className={`section-row ${hasMore ? "" : "static"}`} onClick={() => hasMore && setOpen(!open)} aria-expanded={hasMore ? open : undefined} tabIndex={hasMore ? 0 : -1}>
        <span className="section-label">
          {s.label}
          {!s.measured && <span className="tag">Estimated</span>}
          {s.sample && <span className="tag">Sample</span>}
        </span>
        <span className="section-value">
          {hour != null && <span className="muted small">{valueText(s, p)} at {hourLabel(hour)}</span>}
          <span className="num section-score" style={{ color: scoreColor(score) }}>
            {score ?? "–"}
          </span>
        </span>
        <span className="section-headline">{nightish ? s.headline : s.day_line || s.headline}</span>
        {s.hourly ? (
          <Spark s={s} hour={hour} />
        ) : (
          <span className="bar">
            <span style={{ width: `${score ?? 0}%`, background: scoreColor(score) }} />
          </span>
        )}
      </button>
      {open && (
        <div className="section-more">
          {s.note && <p className="muted small">{s.note}</p>}
          {s.details?.map((d) => (
            <div key={d.label} className="detail">
              <span>{d.label}</span>
              <span className="muted">{d.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 24 tiny bars, tallest where the section is worst.
function Spark({ s, hour }: { s: Section; hour: number | null }) {
  return (
    <span className="spark" aria-hidden="true">
      {ORDER.map((h) => {
        const p = s.hourly?.[h];
        const badness = p ? (100 - p.score) / 100 : 0;
        return (
          <span key={h} className={h === hour ? "sel" : isNight(h) ? "night" : ""}>
            <span style={{ height: `${10 + badness * 90}%`, background: p ? scoreColor(p.score) : "var(--border)" }} />
          </span>
        );
      })}
    </span>
  );
}

function Feed({ live, session, onUnlock }: { live: LiveSnapshot | null; session: Session | null; onUnlock: (f: string) => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, []);
  const allowed = session?.features["live.feed"]?.allowed;
  const disrupted = live?.lines?.filter((l) => l.severity !== 10) ?? [];
  return (
    <div className="feed">
      <h2 className="feed-title">
        <span className="pulse" aria-hidden="true" />
        Happening nearby now
      </h2>
      {!allowed ? (
        <Locked feature="live.feed" session={session} onUnlock={onUnlock} compact text="Police, air ambulance and TfL updates around here" />
      ) : (
        <ul>
          {live?.events?.map((e) => (
            <li key={e.id} className="event">
              <span className={`dot dot-${e.kind}${e.good ? " dot-good" : ""}`} aria-hidden="true" />
              <span className="event-text">
                {e.text}
                {e.dist_m != null && e.dist_m > 0 && <span className="muted"> · {fmtDist(e.dist_m)} away</span>}
              </span>
              <span className="muted small num">{ago(e.at)}</span>
            </li>
          ))}
          {!live?.events?.length && (
            <li className="event muted">
              <span className="dot dot-good" aria-hidden="true" />
              {live?.lines?.length
                ? disrupted.length
                  ? `${disrupted.length} nearby line${disrupted.length > 1 ? "s" : ""} disrupted`
                  : `All ${live.lines.length} nearby lines running normally`
                : "Quiet right now"}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function Breakdown({ items }: { items: { label: string; count: number }[] }) {
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <div className="breakdown">
      {items.slice(0, 8).map((i) => (
        <div key={i.label} className="bd-row">
          <span className="small">{i.label}</span>
          <span className="num small muted">{i.count.toLocaleString()}</span>
          <span className="bar">
            <span style={{ width: `${(i.count / max) * 100}%`, background: "var(--bad)" }} />
          </span>
        </div>
      ))}
    </div>
  );
}

// Lock overlay driven entirely by features.yaml via /api/session.
function Locked({ feature, session, onUnlock, compact, text, children }: { feature: string; session: Session | null; onUnlock: (f: string) => void; compact?: boolean; text?: string; children?: ReactNode }) {
  const f = session?.features[feature];
  const next = f?.unlocks_on;
  const label = next === "free" ? "Sign up free" : next === "pro" ? `Go Pro · ${session?.plans.pro?.price_label ?? ""}` : "Unavailable";
  const button = (
    <button className={next === "pro" ? "primary" : ""} onClick={() => onUnlock(feature)} disabled={!next}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 018 0v4" />
      </svg>
      {label}
    </button>
  );
  if (compact || !children) {
    return (
      <div className="locked-inline">
        <span className="muted small">{text ?? f?.label}</span>
        {button}
      </div>
    );
  }
  return (
    <div className="locked">
      <div className="locked-preview" aria-hidden="true">
        {children}
      </div>
      <div className="locked-cta">{button}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="skeleton" aria-label="Loading report">
      <div className="sk sk-score" />
      <div className="sk sk-strip" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="sk sk-row" />
      ))}
    </div>
  );
}

const fakeBreakdown = [
  { label: "Violence and sexual offences", count: 420 },
  { label: "Anti-social behaviour", count: 380 },
  { label: "Other theft", count: 300 },
  { label: "Shoplifting", count: 220 },
];

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function fmtDist(m: number) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
