import { useRef, useState } from "react";
import { COMPARE_LETTERS, compareColor, type CompareItem } from "./compare";
import { hourLabel } from "./Panel";

// One line per postcode: the overall score through the day, 6pm to 5pm so the
// night sits in the middle. Hover for every postcode's score at that hour.
const ORDER = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const W = 560, H = 170, PAD = { l: 28, r: 30, t: 10, b: 22 };

export default function CompareChart({ items }: { items: CompareItem[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<SVGSVGElement>(null);
  const x = (i: number) => PAD.l + (i / (ORDER.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / 100) * (H - PAD.t - PAD.b);
  const nightFrom = x(ORDER.indexOf(23)) - 6, nightTo = x(ORDER.indexOf(5)) + 6;

  const onMove = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (ORDER.length - 1));
    setHover(Math.max(0, Math.min(ORDER.length - 1, i)));
  };

  const lines = items.map((it, k) => ({ it, k })).filter(({ it }) => it.hourly?.length);
  const ends = spread(lines.map(({ it }) => y(it.hourly![17])), 12);
  return (
    <div className="cmp-chart">
      <svg ref={box} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Overall score by hour for each postcode" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <rect x={nightFrom} y={PAD.t} width={nightTo - nightFrom} height={H - PAD.t - PAD.b} className="cmp-night" rx="4" />
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="cmp-grid" />
            <text x={PAD.l - 6} y={y(v) + 3} className="cmp-axis" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {[18, 0, 6, 12, 17].map((h) => (
          <text key={h} x={x(ORDER.indexOf(h))} y={H - 6} className="cmp-axis" textAnchor="middle">
            {hourLabel(h)}
          </text>
        ))}
        {lines.map(({ it, k }) => (
          <polyline
            key={it.postcode}
            points={ORDER.map((h, i) => `${x(i)},${y(it.hourly![h])}`).join(" ")}
            fill="none"
            stroke={compareColor(k)}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {/* Direct labels at the line ends: the letter, so identity isn't colour alone. */}
        {lines.map(({ it, k }, j) => (
          <g key={it.postcode + "-label"}>
            <circle cx={x(ORDER.length - 1)} cy={y(it.hourly![17])} r="4" fill={compareColor(k)} className="cmp-ring" />
            <text x={x(ORDER.length - 1) + 8} y={ends[j] + 4} className="cmp-end">
              {COMPARE_LETTERS[k]}
            </text>
          </g>
        ))}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="cmp-cross" />
            {lines.map(({ it, k }) => (
              <circle key={it.postcode} cx={x(hover)} cy={y(it.hourly![ORDER[hover]])} r="4.5" fill={compareColor(k)} className="cmp-ring" />
            ))}
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="cmp-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <strong>{hourLabel(ORDER[hover])}</strong>
          {lines
            .map(({ it, k }) => ({ it, k, v: it.hourly![ORDER[hover]] }))
            .sort((a, b) => b.v - a.v)
            .map(({ it, k, v }) => (
              <span key={it.postcode} className="cmp-tip-row">
                <span className="cmp-key" style={{ background: compareColor(k) }} />
                {COMPARE_LETTERS[k]} {it.postcode}
                <span className="num">{v}</span>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

// Nudges label positions apart so no two are closer than gap, keeping their order.
function spread(ys: number[], gap: number) {
  const order = ys.map((v, i) => i).sort((a, b) => ys[a] - ys[b]);
  const out = [...ys];
  for (let n = 1; n < order.length; n++) {
    const prev = out[order[n - 1]];
    if (out[order[n]] - prev < gap) out[order[n]] = prev + gap;
  }
  return out;
}
