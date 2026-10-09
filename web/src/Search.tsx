import { useEffect, useRef, useState } from "react";
import { searchPostcodes, type PostcodeHit } from "./api";

interface Props {
  value: string;
  onSelect: (hit: { postcode: string; lat?: number; lon?: number; area?: string }) => void;
  onPreview: (postcode: string) => void; // highlight: start fetching early
}

export default function Search({ value, onSelect, onPreview }: Props) {
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

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || term.toUpperCase() === value.toUpperCase()) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchPostcodes(term, ctrl.signal)
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

  const choose = (hit?: PostcodeHit) => {
    const pick = hit ?? hits[active];
    if (pick) onSelect(pick);
    else if (q.trim()) onSelect({ postcode: q.trim() });
    setOpen(false);
    input.current?.blur();
  };

  const move = (d: number) => {
    if (!hits.length) return;
    const i = (active + d + hits.length) % hits.length;
    setActive(i);
    onPreview(hits[i].postcode);
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
      {open && hits.length > 0 && (
        <ul className="search-list" role="listbox">
          {hits.map((h, i) => (
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
              <span className="num">{h.postcode}</span>
              <span className="muted">{h.area}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
