import { useEffect, useRef, useState } from "react";
import { hourLabel } from "./Panel";

interface Props {
  hours: number[]; // slider stops, e.g. [21, 22, ..., 9]
  days: number;
  // Fractional position along `hours` (0 = first hour). Fractions cross-fade
  // between neighbouring hours during playback.
  onPosition: (pos: number) => void;
}

const PLAY_SECONDS_PER_HOUR = 1.1;

export default function FlightSlider({ hours, days, onPosition }: Props) {
  // Start at 5am, when Heathrow's first arrivals usually begin.
  const [pos, setPos] = useState(() => Math.max(0, hours.indexOf(5)));
  const [playing, setPlaying] = useState(false);
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => onPosition(pos), [pos]);

  // Playback: advance smoothly through the hours, looping at the end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = posRef.current + (now - last) / 1000 / PLAY_SECONDS_PER_HOUR;
      last = now;
      setPos(next > hours.length - 1 ? 0 : next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, hours.length]);

  const h = hours[Math.min(hours.length - 1, Math.round(pos))];
  const next = (h + 1) % 24;

  return (
    <div className="flight-slider" role="group" aria-label="Flight paths by hour">
      <div className="fs-head">
        <button className="fs-play" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play through the night"}>
          {playing ? (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor" />
              <rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <span className="fs-title">Flight paths</span>
        <span className="fs-hour num">
          {hourLabel(h)}–{hourLabel(next)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={hours.length - 1}
        step={1}
        value={Math.round(pos)}
        onChange={(e) => {
          setPlaying(false);
          setPos(Number(e.target.value));
        }}
        aria-valuetext={`${hourLabel(h)} to ${hourLabel(next)}`}
      />
      <div className="fs-axis small muted">
        <span>9pm</span>
        <span>midnight</span>
        <span>3am</span>
        <span>6am</span>
        <span>10am</span>
      </div>
      <p className="fs-note small muted">
        Aircraft below 10,000 ft per hour, from {days} day{days === 1 ? "" : "s"} of recorded flights
      </p>
    </div>
  );
}
