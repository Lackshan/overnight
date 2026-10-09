// Smooth aircraft motion from sparse, irregular ADS-B positions.
//
// Raw positions arrive every few seconds at uneven intervals, which is why most
// flight maps look jerky. Instead of drawing the latest position, we draw every
// aircraft a little in the past, where we already know the position on both
// sides, and move it along a curve that respects its speed and heading at each
// end (a cubic Hermite spline). Turns become arcs and a circling helicopter
// traces a circle. When the curve has to change (a late or surprising
// position), the jump is absorbed as an offset that fades out over a couple of
// seconds, so nothing ever snaps and there's no lag in steady flight.
//
// No map code here, so it can be tested on its own (motion.test.ts).
import type { Aircraft } from "./types";

// How far behind real time we draw. It adapts to how often positions arrive
// (the data source rate-limits us at busy times) so there's always a known
// position ahead to move towards.
const MIN_DELAY_MS = 8000;
const MAX_DELAY_MS = 45000;
const DELAY_GROW = 0.3; // render clock may slow to 70% speed to make room
const DELAY_SHRINK = 0.15; // and catch up gently once data is flowing again
const MAX_EXTRAPOLATE_MS = 20000; // keep moving on the last heading through short data gaps
const STALE_MS = 60000; // drop aircraft we haven't heard from
const TRAIL_MS = 45000;
const TRAIL_EVERY_MS = 400;
const OFFSET_TAU = 2; // seconds for a correction to fade
const HDG_TAU = 0.5; // seconds; easing for heading
const MAX_TURN = { plane: 12, heli: 40 }; // degrees per second on screen

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
const KT = 0.514444;

interface Sample {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alt: number;
}

export interface Track {
  a: Aircraft;
  samples: Sample[];
  x: number; // drawn position: target + offset
  y: number;
  tx: number; // last target on the curve, and its velocity (m/s)
  ty: number;
  tvx: number;
  tvy: number;
  ox: number; // correction offset, fading to zero
  oy: number;
  hdg: number;
  alt: number;
  started: boolean;
  trail: [number, number][];
  trailAt: number;
  heard: number;
}

export const toLngLat = (x: number, y: number): [number, number] => [x / M_PER_DEG_LON, y / M_PER_DEG_LAT];
const toXY = (lat: number, lon: number) => ({ x: lon * M_PER_DEG_LON, y: lat * M_PER_DEG_LAT });

function sampleOf(a: Aircraft): Sample {
  const { x, y } = toXY(a.lat, a.lon);
  const v = a.speed_kt * KT;
  const r = (a.track * Math.PI) / 180;
  return { t: a.t, x, y, vx: v * Math.sin(r), vy: v * Math.cos(r), alt: a.alt_ft };
}

// Position and velocity (m/s) at time t between two samples.
function hermite(s0: Sample, s1: Sample, t: number) {
  const T = (s1.t - s0.t) / 1000;
  const u = Math.min(1, Math.max(0, (t - s0.t) / (s1.t - s0.t)));
  const u2 = u * u;
  const u3 = u2 * u;
  // Long gaps make tangents unreliable; fall back to a straight line.
  const k = T > 30 ? 0 : T;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const x = h00 * s0.x + h10 * k * s0.vx + h01 * s1.x + h11 * k * s1.vx;
  const y = h00 * s0.y + h10 * k * s0.vy + h01 * s1.y + h11 * k * s1.vy;
  const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
  const dx = d00 * s0.x + d10 * k * s0.vx + d01 * s1.x + d11 * k * s1.vx;
  const dy = d00 * s0.y + d10 * k * s0.vy + d01 * s1.y + d11 * k * s1.vy;
  return { x, y, vx: dx / T, vy: dy / T, alt: s0.alt + (s1.alt - s0.alt) * u };
}

function angleDiff(a: number, b: number) {
  return ((b - a + 540) % 360) - 180;
}

export class Motion {
  tracks = new Map<string, Track>();
  delayMs = 12000;
  private clockOffset = 0; // server time minus local time
  private clockSet = false;
  private gapMs = 5000; // smoothed time between positions for the same aircraft

  // Add a fresh snapshot. nowWall is Date.now(), nowPerf is performance.now().
  ingest(aircraft: Aircraft[], serverNow: number, nowWall: number, nowPerf: number) {
    const offset = serverNow - nowWall;
    // Smooth the clock offset so network jitter doesn't nudge everything.
    this.clockOffset = this.clockSet ? this.clockOffset * 0.8 + offset * 0.2 : offset;
    this.clockSet = true;
    for (const a of aircraft) {
      if (a.alt_ft <= 0) continue; // on the ground
      const s = sampleOf(a);
      const tr = this.tracks.get(a.hex);
      if (!tr) {
        this.tracks.set(a.hex, {
          a, samples: [s], x: s.x, y: s.y, tx: s.x, ty: s.y, tvx: 0, tvy: 0, ox: 0, oy: 0,
          hdg: a.track, alt: a.alt_ft, started: false, trail: [], trailAt: 0, heard: nowPerf,
        });
        continue;
      }
      tr.heard = nowPerf;
      tr.a = a;
      const last = tr.samples[tr.samples.length - 1];
      if (s.t > last.t) {
        tr.samples.push(s);
        // React to longer gaps at once, relax slowly when they shorten.
        const gap = Math.min(s.t - last.t, 60000);
        this.gapMs = gap > this.gapMs ? gap : this.gapMs * 0.98 + gap * 0.02;
      }
      if (tr.samples.length > 30) tr.samples.splice(0, tr.samples.length - 30);
    }
    for (const [hex, tr] of this.tracks) if (nowPerf - tr.heard > STALE_MS) this.tracks.delete(hex);
  }

  // Advance every aircraft to the current render time. dt is seconds since the last step.
  step(nowWall: number, nowPerf: number, dt: number) {
    // Move the delay towards 1.25× the longest recent gap, by running the
    // render clock slower or faster rather than jumping it.
    const want = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, this.gapMs * 1.25 + 2000));
    const rate = want > this.delayMs ? DELAY_GROW : DELAY_SHRINK;
    const slew = rate * dt * 1000;
    this.delayMs += Math.max(-slew, Math.min(slew, want - this.delayMs));
    const renderT = nowWall + this.clockOffset - this.delayMs;
    const fade = Math.exp(-dt / OFFSET_TAU);
    const kHdg = 1 - Math.exp(-dt / HDG_TAU);

    for (const tr of this.tracks.values()) {
      const ss = tr.samples;
      let target: { x: number; y: number; vx: number; vy: number; alt: number } | null = null;
      if (renderT >= ss[0].t) {
        // Drop samples we've fully passed, keeping one behind renderT.
        while (ss.length > 2 && ss[1].t <= renderT) ss.shift();
        if (ss.length >= 2 && renderT <= ss[1].t) {
          target = hermite(ss[0], ss[1], renderT);
        } else {
          const s = ss[ss.length - 1];
          const ahead = Math.min(renderT - s.t, MAX_EXTRAPOLATE_MS) / 1000;
          target = { x: s.x + s.vx * ahead, y: s.y + s.vy * ahead, vx: s.vx, vy: s.vy, alt: s.alt };
        }
      }
      if (!target) continue; // not due on screen yet
      if (!tr.started) {
        tr.started = true;
        tr.ox = tr.oy = 0;
      } else {
        // Where the previous curve said we'd be now, versus where the current
        // one says. Any difference is a jump: absorb it into the offset.
        const ex = tr.tx + tr.tvx * dt, ey = tr.ty + tr.tvy * dt;
        tr.ox = (tr.ox + ex - target.x) * fade;
        tr.oy = (tr.oy + ey - target.y) * fade;
      }
      tr.tx = target.x;
      tr.ty = target.y;
      tr.tvx = target.vx;
      tr.tvy = target.vy;
      tr.x = target.x + tr.ox;
      tr.y = target.y + tr.oy;
      tr.alt += (target.alt - tr.alt) * (1 - fade);
      // Hovering helicopters have no meaningful direction of travel; hold heading.
      if (Math.hypot(target.vx, target.vy) > 8) {
        const wantHdg = (Math.atan2(target.vx, target.vy) * 180) / Math.PI;
        const maxTurn = (tr.a.kind === "plane" ? MAX_TURN.plane : MAX_TURN.heli) * dt;
        const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDiff(tr.hdg, wantHdg) * kHdg));
        tr.hdg = (tr.hdg + turn + 360) % 360;
      }
      if (nowPerf - tr.trailAt > TRAIL_EVERY_MS) {
        tr.trail.push(toLngLat(tr.x, tr.y));
        tr.trailAt = nowPerf;
        const keep = Math.ceil(TRAIL_MS / TRAIL_EVERY_MS);
        if (tr.trail.length > keep) tr.trail.splice(0, tr.trail.length - keep);
      }
    }
  }
}
