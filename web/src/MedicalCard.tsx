import { status } from "./health";
import type { Medical } from "./types";

interface Props {
  data: Medical;
  onHover?: (key: string | null) => void;
  onSelect?: (lat: number, lon: number, key: string) => void;
}

const dist = (m: number) => (m < 200 ? "on the doorstep" : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

function Row({ k, badge, cls, title, sub, where, lat, lon, onHover, onSelect }: { k: string; badge: string; cls: string; title: string; sub: React.ReactNode; where: number; lat: number; lon: number } & Pick<Props, "onHover" | "onSelect">) {
  return (
    <div
      className="med-row"
      tabIndex={0}
      onMouseEnter={() => onHover?.(k)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(k)}
      onBlur={() => onHover?.(null)}
      onClick={() => onSelect?.(lat, lon, k)}
      onKeyDown={(e) => e.key === "Enter" && onSelect?.(lat, lon, k)}
    >
      <span className={`gh-badge ${cls}`}>{badge}</span>
      <span className="med-main">
        <span className="med-title">{title}</span>
        <span className="small muted">{sub}</span>
      </span>
      <span className="small muted med-dist">{dist(where)}</span>
    </div>
  );
}

export default function MedicalCard({ data, onHover, onSelect }: Props) {
  const gpStatus = status(data.gp_hours);
  const openUTC = data.utcs.find((u) => status(u.schedule).open);
  const now = new Date().toLocaleString("en-GB", { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <div className="med">
      <h2>Medical help nearby</h2>
      <p className="small gh-summary">
        <strong>Now ({now}):</strong>{" "}
        {gpStatus.open ? "GP surgeries are open" : "GP surgeries are closed"}
        {openUTC ? `; ${openUTC.site} urgent treatment centre is open, ${dist(openUTC.distance_m)}` : "; no urgent treatment centre nearby is open"}
        . NHS 111 is available any time.
      </p>
      {data.gps.map((g) => (
        <Row
          key={g.code}
          k={`gp:${g.code}`}
          badge="GP"
          cls="gh-gp"
          title={g.name}
          sub={
            <>
              {gpStatus.text.replace("Open until", "Usually open until").replace(/^Opens/, "Usually opens")}
              {g.phone && (
                <>
                  {" · "}
                  <a href={`tel:${g.phone.replace(/\s/g, "")}`} onClick={(e) => e.stopPropagation()}>
                    {g.phone}
                  </a>
                </>
              )}
            </>
          }
          where={g.distance_m}
          lat={g.lat}
          lon={g.lon}
          onHover={onHover}
          onSelect={onSelect}
        />
      ))}
      {data.utcs.map((u) => {
        const st = status(u.schedule);
        return (
          <Row
            key={u.name}
            k={`utc:${u.name}`}
            badge={u.schedule.open24 ? "UTC 24h" : "UTC"}
            cls="gh-utc"
            title={u.site}
            sub={
              <>
                <span className={st.open ? "med-open" : "med-closed"}>{st.text}</span>
                {" · "}
                {u.schedule.text}
                {u.walkIn === false && " · not walk-in"}
              </>
            }
            where={u.distance_m}
            lat={u.lat}
            lon={u.lon}
            onHover={onHover}
            onSelect={onSelect}
          />
        );
      })}
      {data.ae.map((h) => (
        <Row
          key={h.name}
          k={`ae:${h.name}`}
          badge="A&E"
          cls="gh-ae"
          title={h.name}
          sub={<span className="med-open">Open 24 hours · emergencies only</span>}
          where={h.distance_m}
          lat={h.lat}
          lon={h.lon}
          onHover={onHover}
          onSelect={onSelect}
        />
      ))}
      <p className="small muted gh-key">
        GP hours are the standard 8am–6:30pm on weekdays; many surgeries open longer, so check with yours. Urgent treatment centre hours are from NHS
        and hospital pages; check before you travel, or call 111.
      </p>
    </div>
  );
}
