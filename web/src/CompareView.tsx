import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import AskBox from "./AskBox";
import CompareChart from "./CompareChart";
import { COMPARE_LETTERS, compareColor, samePostcode, type CompareItem } from "./compare";
import { scoreColor } from "./Panel";
import type { RecentSearch } from "./recent";
import type { Session } from "./types";

interface Props {
  session: Session | null;
  postcodes: string[];
  recents: RecentSearch[];
  onAdd: (postcode: string) => void;
  onRemove: (postcode: string) => void;
  onClose: () => void;
  onOpen: (postcode: string) => void; // open one postcode's full report
  onUnlock: (feature: string) => void;
  onItems: (items: CompareItem[]) => void; // for the map pins
}

// The best value in a row: highest score, or the fact's better direction. Ties all win.
function bestIndexes(values: (number | null | undefined)[], better: "higher" | "lower") {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) return new Set<number>();
  const target = better === "higher" ? Math.max(...nums) : Math.min(...nums);
  if (nums.every((v) => v === target)) return new Set<number>(); // no winner if all equal
  return new Set(values.map((v, i) => (v === target ? i : -1)).filter((i) => i >= 0));
}

const ASK_COMPARE = ["Which is best for a light sleeper?", "Which is easiest to get home to late?", "Sum up how they differ at night"];

const compact = (p: string) => p.replace(/\s/g, "").toUpperCase();

const BestMark = () => (
  <svg className="cmp-best" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-label="Best">
    <path d="M5 12l5 5L20 7" />
  </svg>
);

export default function CompareView({ session, postcodes, recents, onAdd, onRemove, onClose, onOpen, onUnlock, onItems }: Props) {
  // Each postcode is fetched on its own and kept, so adding one never reloads
  // the others and each column fills in as soon as its report is ready.
  const [byPostcode, setByPostcode] = useState<Record<string, CompareItem>>({});
  const loading = useRef(new Set<string>());
  const generation = useRef(0);
  const [error, setError] = useState<{ message: string; locked?: boolean } | null>(null);
  const [mode, setMode] = useState<"night" | "day">("night");
  const [draft, setDraft] = useState("");
  const allowed = session?.features["compare"]?.allowed ?? false;
  const max = session?.limits["compare.postcodes"] || 4;
  const key = postcodes.join(",");

  // Reports depend on the plan, so a plan change starts afresh.
  useEffect(() => {
    generation.current++;
    setByPostcode({});
    loading.current.clear();
  }, [session?.plan]);

  useEffect(() => {
    setError(null);
    if (!allowed || postcodes.length < 2) return;
    for (const pc of postcodes) {
      const k = compact(pc);
      if (byPostcode[k] || loading.current.has(k)) continue;
      loading.current.add(k);
      const gen = generation.current;
      api
        .compare([pc])
        .then((r) => gen === generation.current && r.items[0] && setByPostcode((m) => ({ ...m, [k]: r.items[0] })))
        .catch((e) => setError({ message: e instanceof Error ? e.message : "Couldn't load the comparison.", locked: e instanceof ApiError && e.status === 403 }))
        .finally(() => loading.current.delete(k));
    }
  }, [key, allowed, byPostcode]);

  const suggestions = recents.filter((r) => !postcodes.some((p) => samePostcode(p, r.postcode))).slice(0, 4);
  const canAdd = postcodes.length < max;
  // Columns follow the list straight away: a removed postcode goes at once, and
  // a new one shows as loading until its report arrives.
  const cols = postcodes.map((p) => byPostcode[compact(p)] ?? ({ postcode: p } as CompareItem));
  const colsKey = cols.map((c) => `${c.postcode}:${c.place ? 1 : 0}`).join(",");
  useEffect(() => onItems(allowed && postcodes.length >= 2 ? cols : []), [colsKey, allowed]);
  const sectionIds = cols.find((it) => it.sections)?.sections?.map((s) => ({ id: s.id, label: s.label })) ?? [];
  const factIds = cols.find((it) => it.facts)?.facts?.map((f) => ({ id: f.id, label: f.label, better: f.better, estimated: f.estimated })) ?? [];

  return (
    <aside className="panel compare" aria-label="Compare postcodes">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Supporters</p>
          <h1>Compare postcodes</h1>
        </div>
        <button className="cmp-close" onClick={onClose} aria-label="Close comparison">
          ×
        </button>
      </header>

      {!allowed ? (
        <div className="support">
          <p className="small">
            <strong>Comparisons are for supporters.</strong> An optional one-off payment of {(session?.plans.pro?.price_label ?? "").replace(" one-off", "")} supports Overnight
            and lets you compare up to {max} postcodes side by side.
          </p>
          <button className="primary" onClick={() => onUnlock("compare")}>
            Support Overnight · {session?.plans.pro?.price_label}
          </button>
        </div>
      ) : (
        <>
          <div className="cmp-add">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim() && canAdd) onAdd(draft.trim().toUpperCase());
                setDraft("");
              }}
            >
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={canAdd ? "Add a postcode" : `Up to ${max} postcodes`} disabled={!canAdd} aria-label="Add a postcode to compare" />
            </form>
            {canAdd &&
              suggestions.map((r) => (
                <button key={r.postcode} className="chip num" onClick={() => onAdd(r.postcode)}>
                  + {r.postcode}
                </button>
              ))}
          </div>
          {postcodes.length < 2 && <p className="muted small cmp-hint">Add at least two postcodes. Use "+ Compare" on any report, or pick from your recent searches above.</p>}
          {error && <p className="error">{error.message}</p>}

          {postcodes.length >= 2 && (
            <div className="cmp-scroll">
              <div className="cmp-grid" style={{ "--n": cols.length } as React.CSSProperties}>
                {/* Column headers */}
                <span />
                {cols.map((c, i) => (
                  <div key={c.postcode} className="cmp-head">
                    <span className="cmp-letter" style={{ background: compareColor(i) }}>
                      {COMPARE_LETTERS[i]}
                    </span>
                    <button className="link num cmp-pc" onClick={() => onOpen(c.place?.postcode ?? c.postcode)} title="Open the full report">
                      {c.place?.postcode ?? c.postcode}
                    </button>
                    <button className="cmp-x" onClick={() => onRemove(c.postcode)} aria-label={`Remove ${c.postcode}`}>
                      ×
                    </button>
                    <span className="small muted cmp-area">{c.error ?? (c.place ? [c.place.ward, c.place.district].filter(Boolean).join(", ") : "Loading…")}</span>
                  </div>
                ))}

                {/* Headline scores */}
                {(["night", "day"] as const).map((m) => {
                  const best = bestIndexes(cols.map((c) => c[m]?.score), "higher");
                  return (
                    <Row key={m} label={m === "night" ? "Overnight score" : "Daytime score"} strong>
                      {cols.map((c, i) => (
                        <div key={c.postcode} className={`cmp-cell cmp-score ${best.has(i) ? "is-best" : ""}`}>
                          {c[m] ? (
                            <>
                              <span className="num" style={{ color: scoreColor(c[m]!.score) }}>
                                {c[m]!.score}
                              </span>
                              {best.has(i) && <BestMark />}
                              <span className="small muted">{c[m]!.band}</span>
                            </>
                          ) : (
                            <span className="muted">–</span>
                          )}
                        </div>
                      ))}
                    </Row>
                  );
                })}
              </div>

              {cols.some((c) => c.hourly) && <CompareChart items={cols} />}

              <div className="cmp-grid" style={{ "--n": cols.length } as React.CSSProperties}>
                <div className="cmp-group">
                  <span>Sections</span>
                  <div className="seg" role="group" aria-label="Scores for">
                    {(["night", "day"] as const).map((m) => (
                      <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)} aria-pressed={mode === m}>
                        {m === "night" ? "Night" : "Day"}
                      </button>
                    ))}
                  </div>
                </div>
                {sectionIds.map((sec) => {
                  const vals = cols.map((c) => c.sections?.find((s) => s.id === sec.id)?.[mode] ?? null);
                  const best = bestIndexes(vals, "higher");
                  return (
                    <Row key={sec.id} label={sec.label}>
                      {cols.map((c, i) => {
                        const s = c.sections?.find((x) => x.id === sec.id);
                        return (
                          <div key={c.postcode} className={`cmp-cell ${best.has(i) ? "is-best" : ""}`} title={s?.headline}>
                            <span className="num" style={{ color: scoreColor(vals[i]) }}>
                              {vals[i] ?? "–"}
                            </span>
                            {best.has(i) && <BestMark />}
                          </div>
                        );
                      })}
                    </Row>
                  );
                })}

                <div className="cmp-group">
                  <span>Key facts</span>
                </div>
                {factIds.map((f) => {
                  const facts = cols.map((c) => c.facts?.find((x) => x.id === f.id));
                  const best = bestIndexes(facts.map((x) => (x?.known ? x.num : null)), f.better);
                  return (
                    <Row key={f.id} label={f.label} tag={f.estimated ? "Estimated" : undefined}>
                      {cols.map((c, i) => (
                        <div key={c.postcode} className={`cmp-cell cmp-fact ${best.has(i) ? "is-best" : ""}`}>
                          <span>{facts[i]?.known ? facts[i]!.value : "–"}</span>
                          {best.has(i) && <BestMark />}
                        </div>
                      ))}
                    </Row>
                  );
                })}
              </div>
              <p className="small muted cmp-foot">
                <BestMark /> marks the best in each row. Scores are out of 100; hover a section score for its headline. Click a postcode for its full report.
              </p>
              {/* Once every column has loaded, so the conversation doesn't restart under you. */}
              {cols.every((c) => c.place || c.error) && (
                <AskBox session={session} postcodes={cols.filter((c) => c.place).map((c) => c.place!.postcode)} suggestions={ASK_COMPARE} onUnlock={onUnlock} />
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function Row({ label, children, strong, tag }: { label: string; children: React.ReactNode; strong?: boolean; tag?: string }) {
  return (
    <>
      <div className={`cmp-label ${strong ? "strong" : ""}`}>
        {label}
        {tag && <span className="tag">{tag}</span>}
      </div>
      {children}
    </>
  );
}
