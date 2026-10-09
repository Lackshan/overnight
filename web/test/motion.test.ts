// Simulates jittery, rate-limited ADS-B updates and checks the rendered motion
// is smooth: no jumps, no stalls, sensible turns. Run: npm test
import { Motion, toLngLat } from "../src/motion.ts";

const KT = 0.514444;
const M_LAT = 110574;
const M_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);

// Ground truth: position (metres) and velocity at time t (seconds).
type Truth = (t: number) => { x: number; y: number; vx: number; vy: number };

function straight(x0: number, y0: number, hdg: number, kt: number): Truth {
  const v = kt * KT, r = (hdg * Math.PI) / 180;
  return (t) => ({ x: x0 + v * Math.sin(r) * t, y: y0 + v * Math.cos(r) * t, vx: v * Math.sin(r), vy: v * Math.cos(r) });
}
function circling(cx: number, cy: number, radius: number, kt: number): Truth {
  const v = kt * KT, w = v / radius;
  return (t) => ({ x: cx + radius * Math.sin(w * t), y: cy + radius * Math.cos(w * t), vx: v * Math.cos(w * t), vy: -v * Math.sin(w * t) });
}
// Flies straight, then a standard-rate turn (3°/s) for 60 s, then straight.
function turning(x0: number, y0: number, hdg0: number, kt: number): Truth {
  const v = kt * KT, rate = (3 * Math.PI) / 180, h0 = (hdg0 * Math.PI) / 180;
  return (t) => {
    let x = x0, y = y0, h = h0;
    const t1 = Math.min(t, 40);
    x += v * Math.sin(h) * t1; y += v * Math.cos(h) * t1;
    if (t > 40) {
      const t2 = Math.min(t - 40, 60), R = v / rate;
      x += R * (Math.cos(h) - Math.cos(h + rate * t2));
      y += R * (Math.sin(h + rate * t2) - Math.sin(h));
      h += rate * t2;
      if (t > 100) { x += v * Math.sin(h) * (t - 100); y += v * Math.cos(h) * (t - 100); }
    }
    return { x, y, vx: v * Math.sin(h), vy: v * Math.cos(h) };
  };
}

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());

const base = { x: -0.2 * M_LON, y: 51.5 * M_LAT };
const fleet: { hex: string; kt: number; kind: string; truth: Truth }[] = [];
for (let i = 0; i < 12; i++) fleet.push({ hex: `s${i}`, kt: 140 + i * 25, kind: "plane", truth: straight(base.x + i * 900, base.y - i * 700, (i * 37) % 360, 140 + i * 25) });
for (let i = 0; i < 6; i++) fleet.push({ hex: `t${i}`, kt: 160 + i * 20, kind: "plane", truth: turning(base.x - i * 1200, base.y + i * 800, i * 60, 160 + i * 20) });
fleet.push({ hex: "npas", kt: 60, kind: "police", truth: circling(base.x, base.y, 600, 60) });
fleet.push({ hex: "heli", kt: 110, kind: "helicopter", truth: circling(base.x + 5000, base.y, 1500, 110) });

const T0 = 1_800_000_000_000; // wall clock at sim start
const DURATION = 240; // seconds
const motion = new Motion();

// Server polls: every 5 s, but 16 s apart during a rate-limited spell (60–120 s).
const polls: number[] = [];
for (let t = 0; t < DURATION; ) {
  polls.push(t);
  t += t > 60 && t < 120 ? 16 : 5 + rand();
}
function snapshot(at: number) {
  return fleet.map((f) => {
    const age = rand() * 2; // ADS-B position up to 2 s old
    const p = f.truth(at - age);
    const x = p.x + gauss() * 15, y = p.y + gauss() * 15; // position noise
    const [lon, lat] = toLngLat(x, y);
    const track = ((Math.atan2(p.vx, p.vy) * 180) / Math.PI + 360 + gauss() * 2) % 360;
    return { hex: f.hex, callsign: "", reg: "", type: "", lat, lon, alt_ft: 3000, speed_kt: f.kt + gauss() * 3, track, kind: f.kind as "plane", t: T0 + (at - age) * 1000 };
  });
}

let pollIdx = 0, latest: ReturnType<typeof snapshot> | null = null, nextClientPoll = 0;
const prev = new Map<string, { x: number; y: number; hdg: number }>();
const ratios: number[] = [], turnRates: number[] = [], errors: number[] = [];
let stalls = 0;
const FPS = 60, dt = 1 / FPS;
for (let frame = 0; frame < DURATION * FPS; frame++) {
  const t = frame * dt;
  while (pollIdx < polls.length && polls[pollIdx] <= t) latest = snapshot(polls[pollIdx++]);
  if (t >= nextClientPoll && latest) {
    // Browser polls every 2 s; the network adds up to 300 ms.
    motion.ingest(latest, T0 + t * 1000, T0 + t * 1000 + rand() * 300, t * 1000);
    nextClientPoll += 2;
  }
  motion.step(T0 + t * 1000, t * 1000, dt);
  if (t < 60) continue; // let the adaptive delay settle
  const renderT = t - motion.delayMs / 1000;
  for (const f of fleet) {
    const tr = motion.tracks.get(f.hex);
    if (!tr || !tr.started) continue;
    const p = prev.get(f.hex);
    if (p) {
      const speed = Math.hypot(tr.x - p.x, tr.y - p.y) / dt;
      const ratio = speed / (f.kt * KT);
      ratios.push(ratio);
      if (ratio < 0.3) stalls++;
      turnRates.push(Math.abs(((tr.hdg - p.hdg + 540) % 360) - 180) / dt);
    }
    const truth = f.truth(renderT);
    errors.push(Math.hypot(tr.x - truth.x, tr.y - truth.y));
    prev.set(f.hex, { x: tr.x, y: tr.y, hdg: tr.hdg });
  }
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)];
const report = {
  frames: ratios.length,
  speedRatio: { p1: +pct(ratios, 0.01).toFixed(2), p50: +pct(ratios, 0.5).toFixed(2), p99: +pct(ratios, 0.99).toFixed(2), max: +ratios.reduce((a, b) => Math.max(a, b), 0).toFixed(2) },
  stallFrames: stalls,
  turnRateDegPerSec: { p99: +pct(turnRates, 0.99).toFixed(1), max: +turnRates.reduce((a, b) => Math.max(a, b), 0).toFixed(1) },
  errorM: { p50: Math.round(pct(errors, 0.5)), p99: Math.round(pct(errors, 0.99)) },
  finalDelayS: +(motion.delayMs / 1000).toFixed(1),
};
console.log(JSON.stringify(report, null, 2));

const failures: string[] = [];
if (report.speedRatio.max > 2) failures.push(`jump: apparent speed ${report.speedRatio.max}× true speed`);
if (report.speedRatio.p1 < 0.6) failures.push(`stutter: 1% of frames slower than ${report.speedRatio.p1}× true speed`);
if (report.turnRateDegPerSec.max > 45) failures.push(`snap turn: ${report.turnRateDegPerSec.max}°/s`);
if (report.errorM.p99 > 200) failures.push(`drift: p99 error ${report.errorM.p99} m`);
if (failures.length) {
  console.error("FAIL\n" + failures.join("\n"));
  process.exit(1);
}
console.log("PASS");
