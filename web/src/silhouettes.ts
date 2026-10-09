// Top-down aircraft silhouettes drawn at real relative size from each type's
// wingspan and length. Nose points up; MapLibre rotates the image to the
// aircraft's heading.
import type { AircraftType } from "./aircraftTypes";

// plane: ordinary traffic. em: emergency-service fixed-wing. The rest are
// helicopter liveries: UK police (NPAS navy with yellow-blue Battenburg),
// most UK air ambulances (yellow with green checks) and London's Air
// Ambulance (red).
export type Variant = "plane" | "em" | "shadow" | "police" | "ambulance" | "ambulance-red";
// Which side's emergency light is lit in this frame: left, right or neither.
export type Light = "L" | "R" | "N";

const PX_PER_M = 0.8; // at icon-size 1: an A320 is ~29 px across
const MIN_PX = 15; // small aircraft are drawn bigger than life so they stay visible
const RATIO = 2; // draw at 2× for sharp edges on retina screens

const COLORS: Record<Variant, { body: string; engine: string }> = {
  plane: { body: "#7F77DD", engine: "#534AB7" },
  em: { body: "#16213A", engine: "#0B1220" },
  shadow: { body: "#000000", engine: "#000000" },
  police: { body: "#16213A", engine: "#0B1220" },
  ambulance: { body: "#FFD21E", engine: "#8A6D00" },
  "ambulance-red": { body: "#D71920", engine: "#7A0E12" },
};

const LIVERY: Partial<Record<Variant, { checks: [string, string]; light: string }>> = {
  police: { checks: ["#FFD100", "#1F5BD8"], light: "#3B7BFF" },
  ambulance: { checks: ["#0F8A3C", "#FFD21E"], light: "#22D36B" },
  "ambulance-red": { checks: ["#FFFFFF", "#D71920"], light: "#22D36B" },
};
const isLivery = (v: Variant) => v in LIVERY;
const EM_MIN_PX = 28; // emergency helicopters are drawn larger so their livery reads

const rad = (deg: number) => (deg * Math.PI) / 180;

interface Parts {
  body: Path2D[]; // fuselage, wings, tail
  engines: Path2D[]; // nacelles, drawn darker on top
  props: Path2D[]; // propeller discs, drawn faint
  boom?: Path2D; // helicopter tail boom, painted with livery checks
  glass?: Path2D; // helicopter windscreen
  lights?: [number, number][]; // emergency light positions, left then right
}

function fuselage(L: number, w: number): Path2D {
  const p = new Path2D();
  const nose = -L / 2, noseLen = w * 1.4, tailStart = L / 2 - L * 0.2;
  p.moveTo(0, nose);
  p.quadraticCurveTo(w / 2, nose, w / 2, nose + noseLen);
  p.lineTo(w / 2, tailStart);
  p.lineTo(w * 0.14, L / 2);
  p.lineTo(-w * 0.14, L / 2);
  p.lineTo(-w / 2, tailStart);
  p.lineTo(-w / 2, nose + noseLen);
  p.quadraticCurveTo(-w / 2, nose, 0, nose);
  p.closePath();
  return p;
}

// A pair of mirrored tapered surfaces (wings or tailplane).
function surfaces(rootX: number, rootY: number, halfSpan: number, rootChord: number, sweepDeg: number, taper: number): Path2D {
  const p = new Path2D();
  const tipLE = rootY + (halfSpan - rootX) * Math.tan(rad(sweepDeg));
  const tipChord = rootChord * taper;
  for (const s of [1, -1]) {
    p.moveTo(s * rootX, rootY);
    p.lineTo(s * halfSpan, tipLE);
    p.lineTo(s * halfSpan, tipLE + tipChord);
    p.lineTo(s * rootX, rootY + rootChord);
    p.closePath();
  }
  return p;
}

// Leading edge y of a surface at distance x from the centreline.
const leadingEdge = (rootX: number, rootY: number, x: number, sweepDeg: number) => rootY + (x - rootX) * Math.tan(rad(sweepDeg));

function pods(xs: number[], yAt: (x: number) => number, width: number, length: number): Path2D {
  const p = new Path2D();
  for (const x of xs) for (const s of [1, -1]) p.roundRect(s * x - width / 2, yAt(x), width, length, width / 2);
  return p;
}

function propDiscs(xs: number[], yAt: (x: number) => number, dia: number): Path2D {
  const p = new Path2D();
  for (const x of xs) for (const s of [1, -1]) p.ellipse(s * x, yAt(x), dia / 2, dia * 0.06, 0, 0, Math.PI * 2);
  return p;
}

function build(t: AircraftType): Parts {
  const S = t.span, L = t.length, half = S / 2;
  const parts: Parts = { body: [], engines: [], props: [] };
  switch (t.family) {
    case "narrow":
    case "wide":
    case "quad": {
      const w = L * (t.family === "narrow" ? 0.105 : t.family === "wide" ? 0.09 : 0.095);
      const sweep = t.family === "narrow" ? 25 : t.family === "wide" ? 31 : 33;
      const rootX = w * 0.45, rootY = -0.06 * L, chord = 0.2 * L;
      parts.body.push(surfaces(rootX, rootY, half, chord, sweep, 0.28));
      parts.body.push(surfaces(w * 0.3, 0.34 * L, 0.18 * S, 0.1 * L, sweep + 5, 0.35));
      parts.body.push(fuselage(L, w));
      const xs = t.family === "quad" ? [0.33 * half, 0.62 * half] : [0.33 * half];
      const ew = S * (t.family === "narrow" ? 0.064 : 0.06), el = L * (t.family === "narrow" ? 0.12 : 0.11);
      parts.engines.push(pods(xs, (x) => leadingEdge(rootX, rootY, x, sweep) - el * 0.35, ew, el));
      break;
    }
    case "rearjet": {
      const w = L * 0.095, sweep = 26, rootX = w * 0.45, rootY = -0.02 * L;
      parts.body.push(surfaces(rootX, rootY, half, 0.2 * L, sweep, 0.35));
      parts.body.push(surfaces(w * 0.1, 0.4 * L, 0.17 * S, 0.08 * L, 32, 0.45)); // T-tail
      parts.body.push(fuselage(L, w));
      const ew = Math.max(0.05 * L, 0.7), el = 0.17 * L;
      parts.engines.push(pods([w / 2 + ew / 2], () => 0.2 * L, ew, el));
      break;
    }
    case "turboprop":
    case "quadprop":
    case "twinpiston": {
      const w = L * (t.family === "twinpiston" ? 0.12 : 0.095), rootX = w * 0.45, rootY = -0.1 * L, chord = 0.13 * L;
      parts.body.push(surfaces(rootX, rootY, half, chord, 3, 0.55));
      parts.body.push(surfaces(w * 0.15, 0.42 * L, 0.14 * S, 0.08 * L, 6, 0.6));
      parts.body.push(fuselage(L, w));
      const xs = t.family === "quadprop" ? [0.27 * half, 0.53 * half] : [0.3 * half];
      const ew = Math.max(0.045 * S, 0.8), el = 0.24 * L;
      const front = (x: number) => leadingEdge(rootX, rootY, x, 3) - el * 0.5;
      parts.engines.push(pods(xs, front, ew, el));
      parts.props.push(propDiscs(xs, front, S * (t.family === "twinpiston" ? 0.16 : 0.145)));
      break;
    }
    case "single": {
      const w = L * 0.13, rootX = w * 0.45, rootY = -0.12 * L;
      parts.body.push(surfaces(rootX, rootY, half, 0.17 * L, 2, 0.7));
      parts.body.push(surfaces(w * 0.15, 0.36 * L, 0.17 * S, 0.11 * L, 4, 0.65));
      parts.body.push(fuselage(L, w));
      parts.props.push(propDiscs([0], () => -L / 2, 0.17 * S));
      break;
    }
    case "heli": {
      // Span is rotor diameter here; the body is drawn from the overall length.
      // Drawn about the rotor hub, which sits over the middle of the cabin.
      const cy = -HUB * L;
      const cabin = new Path2D();
      cabin.ellipse(0, cy, 0.08 * L, 0.23 * L, 0, 0, Math.PI * 2);
      const boom = new Path2D();
      boom.roundRect(-0.024 * L, cy + 0.15 * L, 0.048 * L, 0.48 * L, 0.02 * L);
      const stab = new Path2D();
      stab.roundRect(-0.1 * L, 0.33 * L, 0.2 * L, 0.035 * L, 0.015 * L); // horizontal stabiliser
      const skids = new Path2D();
      for (const sx of [-1, 1]) skids.roundRect(sx * 0.105 * L - 0.008 * L, cy - 0.14 * L, 0.016 * L, 0.3 * L, 0.008 * L);
      parts.body.push(skids, boom, stab, cabin);
      parts.boom = boom;
      const glass = new Path2D();
      glass.ellipse(0, cy - 0.15 * L, 0.06 * L, 0.07 * L, 0, Math.PI, Math.PI * 2); // windscreen, front half
      glass.closePath();
      parts.glass = glass;
      const fin = new Path2D();
      fin.ellipse(0.032 * L, 0.46 * L, 0.012 * L, 0.04 * L, 0, 0, Math.PI * 2); // tail rotor
      parts.engines.push(fin);
      parts.lights = [[-0.125 * L, cy + 0.02 * L], [0.125 * L, cy + 0.02 * L]]; // on the skids
      break;
    }
  }
  return parts;
}

function scaleFor(t: AircraftType, variant: Variant = "plane") {
  const reach = t.family === "heli" ? t.span : Math.max(t.span, t.length);
  const min = t.family === "heli" && isLivery(variant) ? EM_MIN_PX : MIN_PX;
  return Math.max(PX_PER_M, min / reach);
}

// Helicopters are drawn centred on the rotor hub (over the cabin), so the
// rotor spins in place and the body turns about the mast.
const HUB = 0.17;
const extent = (t: AircraftType) => (t.family === "heli" ? Math.max(t.span, (0.46 + HUB) * 2 * t.length) : Math.max(t.span, t.length));

// Returns image data for map.addImage, nose up, centred.
// scaleAs draws a shadow at the same size as the livery it belongs to.
export function drawAircraft(t: AircraftType, variant: Variant, light: Light = "N", scaleAs: Variant = variant): { data: ImageData; pixelRatio: number } {
  const livery = LIVERY[variant];
  const k = scaleFor(t, scaleAs);
  const glowPx = LIVERY[scaleAs] ? 9 : 0;
  const size = Math.ceil(extent(t) * k + 6 + glowPx * 2);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size * RATIO;
  const c = canvas.getContext("2d")!;
  c.scale(RATIO, RATIO);
  c.translate(size / 2, size / 2);
  c.scale(k, k);
  if (t.family === "heli") c.translate(0, HUB * t.length);
  const parts = build(t);
  const col = COLORS[variant];
  c.lineJoin = "round";
  const litIndex = light === "L" ? 0 : light === "R" ? 1 : -1;
  if (livery && parts.lights && litIndex >= 0) {
    // The lit light's glow goes behind the body so it never hides the livery.
    const [x, y] = parts.lights[litIndex];
    const r = glowPx / k;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgbaOf(livery.light, 0.95));
    g.addColorStop(0.35, rgbaOf(livery.light, 0.55));
    g.addColorStop(1, rgbaOf(livery.light, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
  if (variant !== "shadow") {
    // A white halo first, so the silhouette reads on any map.
    c.strokeStyle = "rgba(255,255,255,0.95)";
    c.lineWidth = 2.2 / k;
    for (const p of [...parts.body, ...parts.engines]) c.stroke(p);
  }
  c.fillStyle = col.body;
  for (const p of parts.body) c.fill(p);
  if (livery && parts.boom) {
    // Battenburg checks along the tail boom, two rows of squares.
    const L = t.length, w = 0.048 * L, sq = w / 2;
    c.save();
    c.clip(parts.boom);
    for (let i = 0, y = -HUB * L + 0.15 * L; y < 0.5 * L; i++, y += sq) {
      for (let j = 0; j < 2; j++) {
        c.fillStyle = livery.checks[(i + j) % 2];
        c.fillRect(-w / 2 + j * sq, y, sq, sq);
      }
    }
    c.restore();
  }
  c.fillStyle = col.engine;
  for (const p of parts.engines) c.fill(p);
  if (parts.glass && variant !== "shadow") {
    c.fillStyle = "rgba(18,28,44,0.85)";
    c.fill(parts.glass);
  }
  if (variant !== "shadow") {
    c.fillStyle = "rgba(68,68,65,0.45)";
    for (const p of parts.props) c.fill(p);
  }
  if (livery && parts.lights) {
    // Light lenses on top: a bright white-hot core when lit, dim otherwise.
    parts.lights.forEach(([x, y], i) => {
      c.beginPath();
      c.arc(x, y, (i === litIndex ? 1.7 : 1.1) / k, 0, Math.PI * 2);
      c.fillStyle = i === litIndex ? "#FFFFFF" : rgbaOf(livery.light, 0.6);
      c.fill();
    });
  }
  return { data: c.getImageData(0, 0, size * RATIO, size * RATIO), pixelRatio: RATIO };
}

function rgbaOf(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const TWO_BLADES = new Set(["R22", "R44", "R66", "B06"]);
const FIVE_BLADES = new Set(["EXPL", "MD90", "A139", "A169", "A189", "S92", "H160"]);

// Main rotor: a faint disc with blades, each trailing a motion-blur wedge in
// the direction of spin (clockwise on screen, as MapLibre rotates it).
export function drawRotor(t: AircraftType, designator: string, variant: Variant = "plane"): { data: ImageData; pixelRatio: number } {
  const k = scaleFor(t, variant);
  const glowPx = LIVERY[variant] ? 9 : 0;
  const size = Math.ceil(extent(t) * k + 6 + glowPx * 2);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size * RATIO;
  const c = canvas.getContext("2d")!;
  c.scale(RATIO, RATIO);
  c.translate(size / 2, size / 2);
  c.scale(k, k);
  const r = t.span / 2;
  const disc = new Path2D();
  disc.arc(0, 0, r, 0, Math.PI * 2);
  c.fillStyle = "rgba(68,68,65,0.05)";
  c.fill(disc);
  const blades = TWO_BLADES.has(designator) ? 2 : FIVE_BLADES.has(designator) ? 5 : 4;
  const wedge = Math.PI / (blades * 1.6);
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    const g = c.createConicGradient(a - wedge, 0, 0);
    const end = wedge / (Math.PI * 2);
    g.addColorStop(0, "rgba(68,68,65,0)");
    g.addColorStop(end, "rgba(68,68,65,0.16)");
    g.addColorStop(Math.min(1, end + 0.0005), "rgba(68,68,65,0)");
    g.addColorStop(1, "rgba(68,68,65,0)");
    c.fillStyle = g;
    c.fill(disc);
  }
  c.strokeStyle = "rgba(52,52,50,0.4)";
  c.lineCap = "round";
  c.lineWidth = 0.9 / k;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    c.stroke();
  }
  c.fillStyle = "rgba(40,40,38,0.7)";
  c.beginPath();
  c.arc(0, 0, 1.2 / k, 0, Math.PI * 2); // hub
  c.fill();
  return { data: c.getImageData(0, 0, size * RATIO, size * RATIO), pixelRatio: RATIO };
}
