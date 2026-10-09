// Draws live aircraft on a MapLibre map: per-model silhouettes, ground
// shadows, fading trails, and a popup that follows the selected aircraft.
// Motion smoothing lives in motion.ts.
import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent } from "maplibre-gl";
import { Popup } from "maplibre-gl";
import { AIRCRAFT_LAYERS, AIRCRAFT_SOURCES, TINT, type Tint } from "./aircraftStyle";
import { TYPES, typeOf } from "./aircraftTypes";
import { Motion, toLngLat, type Track } from "./motion";
import { drawAircraft, drawRotor, type Light, type Variant } from "./silhouettes";
import type { Aircraft } from "./types";

const LAYERS = AIRCRAFT_LAYERS.map((l) => l.id);

const isEm = (a: Aircraft) => a.kind === "police" || a.kind === "air_ambulance";
// Known types decide; otherwise trust the server (police and air ambulances
// with an unknown type are almost always helicopters).
const isHeli = (a: Aircraft) => (a.type && a.type.toUpperCase() in TYPES ? TYPES[a.type.toUpperCase()].family === "heli" : a.kind !== "plane");
const LAA = new Set(["G-EHMS", "G-LNDN", "G-LAAA", "G-LAAB"]); // London's Air Ambulance flies red

function variantOf(a: Aircraft, heli: boolean): Variant {
  if (a.kind === "police") return heli ? "police" : "em";
  if (a.kind === "air_ambulance") return LAA.has(a.reg.toUpperCase()) || /^HLE2[78]$/.test(a.callsign) ? "ambulance-red" : "ambulance";
  return "plane";
}
const tintOf = (a: Aircraft): Tint => (a.kind === "police" ? "police" : a.kind === "air_ambulance" ? "ambulance" : "plane");

// Flash patterns. Police: quick double flashes, alternating sides. Air
// ambulance: slower single flashes. Each aircraft gets its own phase.
function lightAt(a: Aircraft, now: number): Light {
  const offset = parseInt(a.hex.slice(-3), 16) || 0;
  if (a.kind === "police") {
    const t = (now + offset) % 700;
    return t < 80 || (t >= 120 && t < 200) ? "L" : (t >= 350 && t < 430) || (t >= 470 && t < 550) ? "R" : "N";
  }
  if (a.kind === "air_ambulance") {
    const t = (now + offset) % 1000;
    return t < 120 ? "L" : t >= 500 && t < 620 ? "R" : "N";
  }
  return "N";
}

export class AircraftLayer {
  private motion = new Motion();
  private last = performance.now();
  private trailsAt = 0;
  private visible = true;
  private selected: string | null = null;
  private popup: Popup;
  private popupEl = document.createElement("div");
  private popupAt = 0;

  constructor(private map: MLMap) {
    // Silhouettes are drawn on demand the first time they're needed. Icon ids
    // look like "ac|A20N|plane", "ac|EC45|heli-police|L" (left light lit),
    // "ac|EC45|heli-shadow|police" or "rotor|EC45|police".
    map.on("styleimagemissing", (e) => {
      const [kind, designator, variant, extra] = e.id.split("|");
      if (kind === "ac") {
        const t = typeOf(designator, variant?.startsWith("heli"));
        const v = (variant?.replace("heli-", "") || "plane") as Variant;
        // For shadows the extra part is the livery to match in size; otherwise it's the lit light.
        const img = v === "shadow" ? drawAircraft(t, v, "N", (extra || "plane") as Variant) : drawAircraft(t, v, (extra || "N") as Light);
        map.addImage(e.id, ...asImage(img));
      } else if (kind === "rotor") {
        map.addImage(e.id, ...asImage(drawRotor(typeOf(designator, true), designator, (variant || "plane") as Variant)));
      }
    });

    for (const [id, src] of Object.entries(AIRCRAFT_SOURCES)) map.addSource(id, src);
    for (const layer of AIRCRAFT_LAYERS) map.addLayer(layer);

    // Click an aircraft: a popup that follows it, with live altitude.
    this.popupEl.className = "ac-popup";
    this.popup = new Popup({ closeButton: true, closeOnClick: false, offset: 16, maxWidth: "260px", className: "ac-popup-wrap" });
    this.popup.setDOMContent(this.popupEl);
    this.popup.on("close", () => (this.selected = null));
    map.on("click", "ac-icons", (e: MapLayerMouseEvent) => {
      const hex = e.features?.[0]?.properties?.hex as string | undefined;
      const tr = hex && this.motion.tracks.get(hex);
      if (!tr) return;
      this.selected = hex;
      this.renderPopup(tr, true);
      this.popup.setLngLat(toLngLat(tr.x, tr.y)).addTo(map);
    });
    this.assertLayers();
    map.on("mouseenter", "ac-icons", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "ac-icons", () => (map.getCanvas().style.cursor = ""));
  }

  // MapLibre reports invalid layers as error events instead of throwing, so
  // check they all exist; a silent failure here means no aircraft at all.
  private assertLayers() {
    const missing = LAYERS.filter((id) => !this.map.getLayer(id));
    if (missing.length) console.error(`Aircraft layers failed to load: ${missing.join(", ")}`);
  }

  setVisible(v: boolean) {
    this.visible = v;
    for (const id of LAYERS) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
    if (!v) this.popup.remove();
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

    for (const [hex, tr] of this.motion.tracks) {
      if (!tr.started) continue;
      const [lng, lat] = toLngLat(tr.x, tr.y);
      if (!inView(lng, lat)) continue;
      const a = tr.a;
      const heli = isHeli(a);
      const em = isEm(a);
      const t = (a.type || "").toUpperCase();
      const variant = variantOf(a, heli);
      const light = em && heli ? lightAt(a, now) : "N";
      // Low aircraft draw slightly larger, so altitude reads at a glance.
      const size = tr.alt < 3000 ? 1.08 : 1;
      const tint = tintOf(a);
      const props: Record<string, unknown> = {
        hex,
        icon: heli ? `ac|${t}|heli-${variant}${em ? `|${light}` : ""}` : `ac|${t}|${variant}`,
        hdg: tr.hdg,
        size,
        alt: tr.alt,
        em,
        tint,
        glow: TINT[tint],
        glowA: light === "N" ? 0.08 : 0.3,
        label: a.kind === "police" ? "Police" : a.kind === "air_ambulance" ? "Air ambulance" : "",
      };
      if (heli) {
        props.rotorIcon = `rotor|${t}|${variant}`;
        props.rotor = (now * 0.75) % 360;
      }
      points.push({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: props });
      // A ground shadow offset by altitude, for anything low enough to hear.
      if (tr.alt < 6000) {
        const off = tr.alt * 0.3048 * 0.12;
        shadows.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: toLngLat(tr.x + off, tr.y - off) },
          // Emergency helicopters are drawn larger, so their shadow is too.
          properties: { icon: `ac|${t}|${heli ? "heli-" : ""}shadow${em && heli ? `|${variant}` : ""}`, hdg: tr.hdg, size, shade: 0.3 - (tr.alt / 6000) * 0.18 },
        });
      }
    }

    (this.map.getSource("ac") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: points });
    (this.map.getSource("ac-shadows") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: shadows });

    if (now - this.trailsAt > 100) {
      this.trailsAt = now;
      const trails: GeoJSON.Feature[] = [];
      for (const tr of this.motion.tracks.values()) {
        if (tr.trail.length < 2) continue;
        trails.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [...tr.trail, toLngLat(tr.x, tr.y)] },
          properties: { tint: tintOf(tr.a) },
        });
      }
      (this.map.getSource("ac-trails") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: trails });
    }

    // Keep the popup on its aircraft; refresh the numbers a few times a second.
    if (this.selected) {
      const tr = this.motion.tracks.get(this.selected);
      if (!tr) {
        this.popup.remove();
      } else {
        this.popup.setLngLat(toLngLat(tr.x, tr.y));
        if (now - this.popupAt > 250) this.renderPopup(tr, false);
      }
    }
  }

  private renderPopup(tr: Track, full: boolean) {
    this.popupAt = performance.now();
    const a = tr.a;
    const model = typeOf(a.type, isHeli(a)).name || a.type || "Unknown type";
    const role = { police: "Police helicopter", air_ambulance: "Air ambulance", helicopter: "Helicopter", plane: "" }[a.kind];
    const alt = Math.round(tr.alt / 25) * 25;
    const climb = Math.abs(a.vrate_fpm) < 200 ? "Level" : a.vrate_fpm > 0 ? `Climbing ${fmt(a.vrate_fpm)} ft/min` : `Descending ${fmt(-a.vrate_fpm)} ft/min`;
    if (full) {
      this.popupEl.innerHTML = `
        <div class="ac-title"><strong></strong><span class="ac-role"></span></div>
        <div class="ac-model"></div>
        <div class="ac-stats">
          <div><span class="ac-k">Altitude</span><span class="ac-v num" data-f="alt"></span></div>
          <div><span class="ac-k">Speed</span><span class="ac-v num" data-f="speed"></span></div>
        </div>
        <div class="ac-climb" data-f="climb"></div>`;
    }
    const set = (sel: string, text: string) => {
      const el = this.popupEl.querySelector(sel);
      if (el && el.textContent !== text) el.textContent = text;
    };
    set(".ac-title strong", a.callsign || a.reg || a.hex.toUpperCase());
    set(".ac-role", role);
    set(".ac-model", [model, a.reg].filter(Boolean).join(" · "));
    set('[data-f="alt"]', `${fmt(alt)} ft`);
    set('[data-f="speed"]', `${Math.round(a.speed_kt)} kt`);
    set('[data-f="climb"]', climb);
  }
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-GB");

function asImage(img: { data: ImageData; pixelRatio: number }): [ImageData, { pixelRatio: number }] {
  return [img.data, { pixelRatio: img.pixelRatio }];
}
