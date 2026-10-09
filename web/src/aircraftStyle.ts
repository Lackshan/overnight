// MapLibre sources and layers for live aircraft. Kept free of browser code so
// test/style.test.ts can validate them against the style spec: an invalid
// layer is dropped with only a console error, which means no aircraft at all.
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

// Trail and glow colours: police blue, air ambulance green.
export const TINT = { plane: "#7F77DD", police: "#3B7BFF", ambulance: "#22D36B" };
export type Tint = keyof typeof TINT;

const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export const AIRCRAFT_SOURCES: Record<string, SourceSpecification> = {
  "ac-trails": { type: "geojson", data: empty, lineMetrics: true },
  "ac-shadows": { type: "geojson", data: empty },
  ac: { type: "geojson", data: empty },
};

// Icons scale gently with zoom so aircraft feel physical without swamping the
// map. MapLibre only allows ["zoom"] in a top-level interpolate, so the
// per-aircraft size multiplies each stop rather than the whole curve.
const ZOOM_STOPS: [number, number][] = [[8, 0.55], [11, 0.85], [13, 1.1], [16, 2.2]];
const ICON_SIZE = ["interpolate", ["exponential", 1.6], ["zoom"], ...ZOOM_STOPS.flatMap(([z, k]) => [z, ["*", k, ["get", "size"]]])];

const iconLayout = {
  "icon-rotate": ["get", "hdg"],
  "icon-rotation-alignment": "map",
  "icon-size": ICON_SIZE,
  "icon-allow-overlap": true,
  "icon-ignore-placement": true,
};

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export const AIRCRAFT_LAYERS = [
  ...(Object.keys(TINT) as Tint[]).map((tint) => ({
    id: `ac-trails-${tint}`,
    type: "line",
    source: "ac-trails",
    filter: ["==", ["get", "tint"], tint],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 14, tint === "plane" ? 2 : 2.5],
      // Fade in from the tail to the aircraft.
      "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, rgba(TINT[tint], 0), 1, rgba(TINT[tint], tint === "plane" ? 0.55 : 0.75)],
    },
  })),
  {
    id: "ac-shadows",
    type: "symbol",
    source: "ac-shadows",
    minzoom: 11,
    layout: { ...iconLayout, "icon-image": ["get", "icon"] },
    paint: { "icon-opacity": ["get", "shade"] },
  },
  // A soft coloured glow under emergency helicopters that pulses with their
  // lights, so they're easy to spot even zoomed out.
  {
    id: "ac-glow",
    type: "circle",
    source: "ac",
    filter: ["==", ["get", "em"], true],
    paint: {
      "circle-color": ["get", "glow"],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 14, 13, 24, 16, 40],
      "circle-blur": 0.9,
      "circle-opacity": ["get", "glowA"],
    },
  },
  {
    id: "ac-icons",
    type: "symbol",
    source: "ac",
    layout: { ...iconLayout, "icon-image": ["get", "icon"], "symbol-sort-key": ["get", "alt"] },
  },
  {
    id: "ac-rotors",
    type: "symbol",
    source: "ac",
    filter: ["has", "rotorIcon"],
    layout: { ...iconLayout, "icon-image": ["get", "rotorIcon"], "icon-rotate": ["get", "rotor"] },
  },
  {
    id: "ac-labels",
    type: "symbol",
    source: "ac",
    filter: ["!=", ["get", "label"], ""],
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Open Sans Semibold"],
      "text-size": 11,
      "text-offset": [0, 2.4],
      "text-anchor": "top",
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": ["match", ["get", "tint"], "police", "#163C9C", "ambulance", "#0B5E2A", "#3C3489"],
      "text-halo-color": "rgba(255,255,255,0.92)",
      "text-halo-width": 1.6,
    },
  },
] as unknown as LayerSpecification[];
