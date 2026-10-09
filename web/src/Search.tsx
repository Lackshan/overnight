import { useEffect, useRef, useState } from "react";
import { searchPostcodes, type PostcodeHit } from "./api";
import type { RecentSearch } from "./recent";

interface Props {
  value: string;
  recents: RecentSearch[];
  onSelect: (hit: { postcode: string; lat?: number; lon?: number; area?: string }) => void;
  onPreview: (postcode: string) => void; // highlight: start fetching early
  onRemoveRecent: (postcode: string | null) => void; // null clears all
}

type Item = { postcode: string; area: string; lat: number; lon: number; recent?: RecentSearch };

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const scoreColor = (s: number) => (s >= 70 ? "var(--good)" : s >= 45 ? "var(--ok)" : "var(--bad)");

export default function Search({ value, recents, onSelect, onPreview, onRemoveRecent }: Props) {
  const [q, setQ] = useState(value);
  const [hits, setHits] = useState<PostcodeHit[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setQ(value), [value]);

  // ⌘K / Ctrl+K focuses search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Until they start typing something new, show recent searches.
  const typing = q.trim().length >= 2 && q.trim().toUpperCase() !== value.toUpperCase();

  useEffect(() => {
    if (!typing) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchPostcodes(q.trim(), ctrl.signal)
        .then((h) => {
          setHits(h);
          setActive(0);
          if (h[0]) onPreview(h[0].postcode);
        })
        .catch(() => {});
    }, 90);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const items: Item[] = typing ? hits : recents.map((r) => ({ postcode: r.postcode, area: r.area, lat: r.lat, lon: r.lon, recent: r }));

  useEffect(() => setActive(0), [typing, recents.length]);

  const choose = (item?: Item) => {
    const pick = item ?? items[active];
    if (pick) onSelect(pick);
    else if (q.trim()) onSelect({ postcode: q.trim() });
    setOpen(false);
    input.current?.blur();
  };

  const move = (d: number) => {
    if (!items.length) return;
    const i = (active + d + items.length) % items.length;
    setActive(i);
    onPreview(items[i].postcode);
  };

  return (
    <div className="search">
      <div className="search-box">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          ref={input}
          value={q}
          placeholder="Enter a London postcode"
          aria-label="Postcode"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), move(1));
            else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
            else if (e.key === "Enter") choose();
            else if (e.key === "Escape") input.current?.blur();
          }}
        />
        <kbd>⌘K</kbd>
      </div>
      {open && items.length > 0 && (
        <div className="search-list">
          {!typing && (
            <div className="search-head small muted">
              <span>Recent</span>
              <button className="link small" onMouseDown={(e) => (e.preventDefault(), onRemoveRecent(null))}>
                Clear
              </button>
            </div>
          )}
          <ul role="listbox" aria-label={typing ? "Matching postcodes" : "Recent searches"}>
            {items.map((h, i) => (
              <li
                key={h.postcode}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : ""}
                onMouseEnter={() => {
                  setActive(i);
                  onPreview(h.postcode);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(h);
                }}
              >
                {h.recent && (
                  <svg className="recent-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                )}
                <span className="num">{h.postcode}</span>
                <span className="muted search-area">{h.area}</span>
                {h.recent && (
                  <>
                    {h.recent.night_score != null && (
                      <span className="recent-score num" style={{ color: scoreColor(h.recent.night_score) }} title="Overnight score when you searched">
                        {h.recent.night_score}
                      </span>
                    )}
                    <span className="small muted recent-ago">{ago(h.recent.at)}</span>
                    <button
                      className="recent-x"
                      aria-label={`Remove ${h.postcode} from recent searches`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onRemoveRecent(h.postcode);
                      }}
                    >
                      ×
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
