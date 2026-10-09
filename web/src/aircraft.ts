// Draws live aircraft on a MapLibre map. Motion smoothing lives in motion.ts.
import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent } from "maplibre-gl";
import { Popup } from "maplibre-gl";
import { Motion, toLngLat } from "./motion";
import type { Aircraft } from "./types";

const COLORS = { plane: "#7F77DD", helicopter: "#7F77DD", police: "#BA7517", air_ambulance: "#BA7517" };

const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export class AircraftLayer {
  private motion = new Motion();
  private last = performance.now();
  private trailsAt = 0;
  private visible = true;

  constructor(private map: MLMap) {
    this.addImages();
    map.addSource("ac-trails", { type: "geojson", data: empty, lineMetrics: true });
    map.addSource("ac-shadows", { type: "geojson", data: empty });
    map.addSource("ac", { type: "geojson", data: empty });

    for (const [id, color, filter] of [
      ["ac-trails-plane", COLORS.plane, ["==", ["get", "em"], false]],
      ["ac-trails-em", COLORS.police, ["==", ["get", "em"], true]],
    ] as const) {
      map.addLayer({
        id,
        type: "line",
        source: "ac-trails",
        filter: filter as unknown as boolean,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 14, 2],
          // Fade in from the tail to the aircraft.
          "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, hexA(color, 0), 1, hexA(color, 0.55)],
        },
      });
    }
    map.addLayer({
      id: "ac-shadows",
      type: "symbol",
      source: "ac-shadows",
      minzoom: 11,
      layout: {
        "icon-image": ["get", "icon"],
        "icon-rotate": ["get", "hdg"],
        "icon-rotation-alignment": "map",
        "icon-size": ["get", "size"],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-opacity": ["get", "shade"] },
    });
    map.addLayer({
      id: "ac-ring",
      type: "circle",
      source: "ac",
      filter: ["==", ["get", "em"], true],
      paint: { "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": COLORS.police, "circle-stroke-width": 1.5, "circle-radius": 8, "circle-stroke-opacity": 0.5 },
    });
    map.addLayer({
      id: "ac-icons",
      type: "symbol",
      source: "ac",
      layout: {
        "icon-image": ["get", "icon"],
        "icon-rotate": ["get", "hdg"],
        "icon-rotation-alignment": "map",
        "icon-size": ["get", "size"],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-sort-key": ["get", "alt"],
      },
    });
    map.addLayer({
      id: "ac-rotors",
      type: "symbol",
      source: "ac",
      filter: ["==", ["get", "heli"], true],
      layout: {
        "icon-image": "rotor",
        "icon-rotate": ["get", "rotor"],
        "icon-rotation-alignment": "map",
        "icon-size": ["get", "size"],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
    map.addLayer({
      id: "ac-labels",
      type: "symbol",
      source: "ac",
      filter: ["!=", ["get", "label"], ""],
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Open Sans Semibold"],
        "text-size": 11,
        "text-offset": [0, 1.8],
        "text-anchor": "top",
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#633806", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 },
    });

    const popup = new Popup({ closeButton: false, offset: 12 });
    map.on("click", "ac-icons", (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as Record<string, string> | undefined;
      if (!p) return;
      const t = this.motion.tracks.get(p.hex);
      if (!t) return;
      const a = t.a;
      const what = { police: "Police helicopter", air_ambulance: "Air ambulance", helicopter: "Helicopter", plane: "Aircraft" }[a.kind];
      const rows = [
        `<strong>${esc(a.callsign || a.reg || a.hex.toUpperCase())}</strong> · ${what}`,
        [a.type, a.reg].filter(Boolean).map(esc).join(" · "),
        `${Math.round(t.alt).toLocaleString()} ft · ${Math.round(a.speed_kt)} kt`,
      ];
      popup.setLngLat(e.lngLat).setHTML(rows.filter(Boolean).join("<br>")).addTo(map);
    });
    map.on("mouseenter", "ac-icons", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "ac-icons", () => (map.getCanvas().style.cursor = ""));
  }

  setVisible(v: boolean) {
    this.visible = v;
    for (const id of ["ac-trails-plane", "ac-trails-em", "ac-shadows", "ac-ring", "ac-icons", "ac-rotors", "ac-labels"]) {
      this.map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
    }
  }

  // Feed a fresh snapshot from the API.
  ingest(aircraft: Aircraft[], serverNow: number) {
    this.motion.ingest(aircraft, serverNow, Date.now(), performance.now());
  }

  // Call every animation frame.
  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.visible) return;
    this.motion.step(Date.now(), now, dt);
    const b = this.map.getBounds();
    const padLng = (b.getEast() - b.getWest()) * 0.2, padLat = (b.getNorth() - b.getSouth()) * 0.2;
    const inView = (lng: number, lat: number) =>
      lng > b.getWest() - padLng && lng < b.getEast() + padLng && lat > b.getSouth() - padLat && lat < b.getNorth() + padLat;

    const points: GeoJSON.Feature[] = [];
    const shadows: GeoJSON.Feature[] = [];
    const updateTrails = now - this.trailsAt > 100;

    for (const [hex, tr] of this.motion.tracks) {
      if (!tr.started) continue;
      const [lng, lat] = toLngLat(tr.x, tr.y);
      if (!inView(lng, lat)) continue;

      const a = tr.a;
      const heli = a.kind !== "plane";
      const em = a.kind === "police" || a.kind === "air_ambulance";
      // Low aircraft draw a little larger, so altitude reads at a glance.
      const size = heli ? 1 : 1.15 - Math.min(tr.alt, 30000) / 30000 * 0.45;
      points.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          hex,
          icon: heli ? (em ? "heli-em" : "heli") : "plane",
          hdg: tr.hdg,
          size,
          alt: tr.alt,
          heli,
          em,
          rotor: heli ? (now * 0.9) % 360 : 0,
          label: a.kind === "police" ? "Police" : a.kind === "air_ambulance" ? "Air ambulance" : "",
        },
      });
      // A ground shadow offset by altitude, for anything low enough to hear.
      if (tr.alt < 6000) {
        const off = tr.alt * 0.3048 * 0.12;
        shadows.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: toLngLat(tr.x + off, tr.y - off) },
          properties: { icon: heli ? "heli-shadow" : "plane-shadow", hdg: tr.hdg, size, shade: 0.35 - (tr.alt / 6000) * 0.2 },
        });
      }
    }

    (this.map.getSource("ac") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: points });
    (this.map.getSource("ac-shadows") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: shadows });

    if (updateTrails) {
      this.trailsAt = now;
      const trails: GeoJSON.Feature[] = [];
      for (const tr of this.motion.tracks.values()) {
        if (tr.trail.length < 2) continue;
        const [lng, lat] = toLngLat(tr.x, tr.y);
        trails.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [...tr.trail, [lng, lat]] },
          properties: { em: tr.a.kind === "police" || tr.a.kind === "air_ambulance" },
        });
      }
      (this.map.getSource("ac-trails") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: trails });
    }

    // One shared pulse for emergency-service rings.
    const phase = (now % 1800) / 1800;
    this.map.setPaintProperty("ac-ring", "circle-radius", 8 + 18 * phase);
    this.map.setPaintProperty("ac-ring", "circle-stroke-opacity", 0.6 * (1 - phase));
  }

  count() {
    return this.motion.tracks.size;
  }

  private addImages() {
    const add = (name: string, size: number, draw: (c: CanvasRenderingContext2D) => void) => {
      if (this.map.hasImage(name)) return;
      const ratio = 2;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size * ratio;
      const c = canvas.getContext("2d")!;
      c.scale(ratio, ratio);
      c.translate(size / 2, size / 2);
      draw(c);
      this.map.addImage(name, c.getImageData(0, 0, size * ratio, size * ratio), { pixelRatio: ratio });
    };
    const plane = (c: CanvasRenderingContext2D) => {
      c.beginPath();
      // Top-down airliner, nose up, ~20px long.
      c.moveTo(0, -10);
      c.bezierCurveTo(1.4, -9, 1.6, -6, 1.6, -3.5);
      c.lineTo(9.5, 1.5);
      c.lineTo(9.5, 3.2);
      c.lineTo(1.6, 1);
      c.lineTo(1.2, 6.5);
      c.lineTo(4, 8.6);
      c.lineTo(4, 9.8);
      c.lineTo(0, 8.8);
      c.lineTo(-4, 9.8);
      c.lineTo(-4, 8.6);
      c.lineTo(-1.2, 6.5);
      c.lineTo(-1.6, 1);
      c.lineTo(-9.5, 3.2);
      c.lineTo(-9.5, 1.5);
      c.lineTo(-1.6, -3.5);
      c.bezierCurveTo(-1.6, -6, -1.4, -9, 0, -10);
      c.closePath();
    };
    const heli = (c: CanvasRenderingContext2D) => {
      c.beginPath();
      c.ellipse(0, -1.5, 3.4, 4.8, 0, 0, Math.PI * 2);
      c.moveTo(0.8, 2.5);
      c.lineTo(0.6, 10);
      c.lineTo(2.6, 10.5);
      c.lineTo(2.6, 11.6);
      c.lineTo(-2.6, 11.6);
      c.lineTo(-2.6, 10.5);
      c.lineTo(-0.6, 10);
      c.lineTo(-0.8, 2.5);
      c.closePath();
    };
    const filled = (shape: (c: CanvasRenderingContext2D) => void, fill: string, stroke = "#ffffff") => (c: CanvasRenderingContext2D) => {
      shape(c);
      c.fillStyle = fill;
      c.fill();
      c.lineWidth = 1.2;
      c.strokeStyle = stroke;
      c.stroke();
    };
    add("plane", 24, filled(plane, COLORS.plane));
    add("heli", 28, filled(heli, COLORS.helicopter));
    add("heli-em", 28, filled(heli, COLORS.police));
    add("plane-shadow", 24, (c) => (plane(c), (c.fillStyle = "#000"), c.fill()));
    add("heli-shadow", 28, (c) => (heli(c), (c.fillStyle = "#000"), c.fill()));
    add("rotor", 28, (c) => {
      c.translate(0, -1.5);
      c.strokeStyle = "rgba(68,68,65,0.75)";
      c.lineWidth = 1.1;
      c.lineCap = "round";
      for (const a of [0, Math.PI / 2]) {
        c.beginPath();
        c.moveTo(Math.cos(a) * -12, Math.sin(a) * -12);
        c.lineTo(Math.cos(a) * 12, Math.sin(a) * 12);
        c.stroke();
      }
      c.beginPath();
      c.arc(0, 0, 12, 0, Math.PI * 2);
      c.strokeStyle = "rgba(68,68,65,0.12)";
      c.lineWidth = 3;
      c.stroke();
    });
  }
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
