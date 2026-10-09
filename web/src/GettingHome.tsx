import { useState } from "react";
import { badgeClass, badgeStyle, isRail, optionKey } from "./nightBadges";
import type { GettingHome as Data, NightOption, NightService } from "./types";

const NIGHTS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Tonight's column: after midnight, it's still last night until 5am.
function tonightIndex(now = new Date()) {
  const d = new Date(now.getTime() - 5 * 3600 * 1000);
  return (d.getDay() + 6) % 7; // Monday = 0
}

// "London Liverpool Street" → "Liverpool St"; "Liverpool Street Station (stop L)" → "Liverpool St · stop L".
function shortPlace(where: string) {
  const stop = where.match(/\(stop ([A-Z0-9]{1,3})\)/)?.[1];
  const name = where
    .replace(/\s*\(stop [A-Z0-9]{1,3}\)/, "")
    .replace(/^London /, "")
    .replace(/ (Underground |Rail |Bus )?Station$/, "")
    .replace(/\bStreet\b/, "St")
    .replace(/\bRoad\b/, "Rd");
  return stop ? `${name} · stop ${stop}` : name;
}

const every = (n: NightService) => {
  const mins = Math.round(60 / n.per_hour / 5) * 5;
  return `${n.approx ? "about " : ""}every ${Math.max(5, mins)} min`;
};

function Badge({ o }: { o: NightOption }) {
  return (
    <span className={badgeClass(o)} style={badgeStyle(o)}>
      {o.line}
    </span>
  );
}

interface Props {
  data: Data;
  onHover?: (key: string | null) => void; // highlight the stop on the map
  onSelect?: (o: NightOption) => void; // fly the map to the stop
}

export default function GettingHome({ data, onHover, onSelect }: Props) {
  const [all, setAll] = useState(false);
  const tonight = tonightIndex();
  const rows = all ? data.options : data.options.slice(0, 6);
  const tonightTubes = data.options.filter((o) => isRail(o) && o.nights[tonight]);
  const tonightBuses = data.options.filter((o) => o.kind.endsWith("bus") && o.nights[tonight]);

  const summary =
    data.options.length === 0
      ? "Nothing runs nearby between 1am and 5am."
      : [
          tonightBuses.length ? `${tonightBuses.length} bus${tonightBuses.length > 1 ? "es" : ""} all night` : "no all-night buses",
          tonightTubes.length ? `Night Tube on the ${tonightTubes.map((o) => o.line).join(" and ")}` : "",
        ]
          .filter(Boolean)
          .join(", ");

  return (
    <div className="gh">
      <h2>Getting home after midnight</h2>
      <p className="small gh-summary">
        <strong>Tonight ({NIGHTS[tonight]}):</strong> {summary}
      </p>
      {data.options.length > 0 && (
        <div className="gh-grid" role="table" aria-label="Night services by night of the week">
          <div className="gh-row gh-head" role="row">
            <span role="columnheader" />
            {NIGHTS.map((n, i) => (
              <span key={n} role="columnheader" className={`gh-day ${i === tonight ? "tonight" : ""}`}>
                {n[0]}
              </span>
            ))}
          </div>
          {rows.map((o) => (
            <div
              className="gh-row gh-option"
              role="row"
              key={optionKey(o)}
              tabIndex={0}
              onMouseEnter={() => onHover?.(optionKey(o))}
              onMouseLeave={() => onHover?.(null)}
              onFocus={() => onHover?.(optionKey(o))}
              onBlur={() => onHover?.(null)}
              onClick={() => onSelect?.(o)}
              onKeyDown={(e) => e.key === "Enter" && onSelect?.(o)}
            >
              <span className="gh-what" role="rowheader">
                <Badge o={o} />
                <span className="gh-where small muted" title={`${o.where}, ${o.distance_m} m away`}>
                  {shortPlace(o.where)} · {o.distance_m} m
                </span>
              </span>
              {o.nights.map((n, i) => (
                <span key={i} role="cell" className={`gh-cell ${i === tonight ? "tonight" : ""}`} title={n ? `${NIGHTS[i]} night: ${every(n)}` : `${NIGHTS[i]} night: doesn't run`}>
                  {n ? <span className="gh-dot" style={{ opacity: 0.45 + Math.min(1, n.per_hour / 6) * 0.55 }} /> : <span className="gh-none" />}
                </span>
              ))}
            </div>
          ))}
          {data.options.length > 6 && (
            <button className="link small gh-more" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${data.options.length}`}
            </button>
          )}
        </div>
      )}
      {data.options.length > 0 && <p className="small muted gh-key">Each dot is a night it runs between 1am and 5am. Hover for how often; click to see the stop on the map.</p>}
      {!!data.last_buses?.length && (
        <p className="small muted gh-last">
          Last regular buses on weeknights: {data.last_buses.map((b) => `${b.route} at ${b.time}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
