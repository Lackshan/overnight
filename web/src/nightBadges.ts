// Shared look for night-service badges, in the report panel and on the map.
import type { NightOption } from "./types";

// TfL line colours.
export const LINE_COLORS: Record<string, string> = {
  Central: "#DC241F",
  Jubilee: "#A0A5A9",
  Northern: "#000000",
  Piccadilly: "#0019A8",
  Victoria: "#00A0E2",
  Windrush: "#EF4D5E",
};

export const isRail = (o: NightOption) => o.kind === "night_tube" || o.kind === "night_overground";

export function badgeClass(o: NightOption) {
  return `gh-badge ${isRail(o) ? "gh-tube" : o.kind === "night_bus" ? "gh-nbus" : "gh-bus"}`;
}

export function badgeStyle(o: NightOption): { background?: string } {
  return isRail(o) ? { background: LINE_COLORS[o.line] ?? "#555" } : {};
}

// Identifies an option across the panel and the map.
export const optionKey = (o: NightOption) => `${o.kind}:${o.line}`;
