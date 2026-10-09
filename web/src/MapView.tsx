import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Map as MLMap, Marker, Popup, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type RasterTileSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre v6 ships its worker as a separate file; let Vite copy it and tell MapLibre where it is.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { AircraftLayer } from "./aircraft";
import { TYPES } from "./aircraftTypes";
import { drawAircraft, drawRotor } from "./silhouettes";
import { badgeClass, badgeStyle, isRail, optionKey } from "./nightBadges";
import { AE_BADGE, GP_BADGE, addPlaceMarker, aeBlock, gpBlock, groupByPlace, nightBlock, popupBox, utcBadge, utcBlock, type Badge, type PlaceMarker } from "./placeMarkers";
import type { Aircraft, FlightPaths, NightOption, Report } from "./types";

const NIGHT_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// "Every night, about every 20 min" or "Friday and Saturday nights, about every 10 min".
function nightsText(o: NightOption) {
  const on = o.nights.map((n, i) => (n ? i : -1)).filter((i) => i >= 0);
  const days = on.length === 7 ? "Every night" : on.length === 2 && on[0] === 4 && on[1] === 5 ? "Friday and Saturday nights" : `${on.map((i) => NIGHT_NAMES[i]).join(", ")} nights`;
  const freq = Math.max(...on.map((i) => o.nights[i]!.per_hour));
  const mins = Math.max(5, Math.round(60 / freq / 5) * 5);
  return `${days}, 1am–5am: up to every ${mins} min${o.nights[on[0]]?.approx ? " (approx.)" : ""}`;
}

setWorkerUrl(workerUrl);

export type LayerKey = "aircraft" | "overflights" | "crime" | "air" | "transport" | "health";

interface Props {
  target: { lat: number; lon: number } | null;
  report: Report | null;
  live: { aircraft: Aircraft[]; now: number } | null;
  visible: Record<LayerKey, boolean>;
  dark: boolean;
  // Called with the visible area (padded) whenever the map moves.
  onBounds?: (bbox: [number, number, number, number]) => void;
  flightPaths: FlightPaths | null;
  nightHighlight: string | null; // optionKey of the night service hovered in the panel
  comparePins?: { lat: number; lon: number; label: string; color: string; postcode: string }[];
}

export interface MapHandle {
  // Show flight paths at a fractional position along flightPaths.hours.
  setFlightHour: (pos: number) => void;
  // Centre the map on a point, e.g. a night bus stop picked in the panel.
  flyTo: (lat: number, lon: number) => void;
}

// Heatmap weight for a position between two hourly stops: a linear blend of
// the two hours' counts, so playback cross-fades instead of jumping. About
// 12 aircraft an hour through a cell counts as full intensity, for every hour
// alike, so quiet hours look quiet.
function flightWeight(pos: number, stops: number) {
  const i = Math.max(0, Math.min(stops - 1, Math.floor(pos)));
  const j = Math.min(stops - 1, i + 1);
  const f = pos - i;
  const blend = ["+", ["*", 1 - f, ["get", `h${i}`]], ["*", f, ["get", `h${j}`]]];
  return ["interpolate", ["linear"], blend, 0, 0, 12, 1];
}

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY as string | undefined;

function baseTiles(dark: boolean): { tiles: string[]; tileSize: number; attribution: string } {
  if (MAPTILER_KEY) {
    const style = dark ? "dataviz-dark" : "dataviz";
    return {
      tiles: [`https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`],
      tileSize: 512,
      attribution: '<a href="https://www.maptiler.com/copyright/">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
    };
  }
  // Fallback for local dev without a key. Not for production traffic.
  return {
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    tileSize: 256,
    attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
  };
}

const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function points<T extends { lat: number; lon: number }>(items: T[] = [], props: (t: T) => Record<string, unknown>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: items.map((t) => ({ type: "Feature", geometry: { type: "Point", coordinates: [t.lon, t.lat] }, properties: props(t) })),
  };
}

function circle(lat: number, lon: number, radiusM: number): GeoJSON.FeatureCollection {
  const coords: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    const dLat = (radiusM / 111320) * Math.cos(a);
    const dLon = (radiusM / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a);
    coords.push([lon + dLon, lat + dLat]);
  }
  return { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {} }] };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const layerIds: Record<Exclude<LayerKey, "aircraft">, string[]> = {
  overflights: ["overflights"],
  crime: ["crime-heat", "crime-points"],
  air: ["air-halo", "air-points"],
  transport: ["stations"],
  health: [], // DOM markers, toggled separately
};

const MapView = forwardRef<MapHandle, Props>(function MapView({ target, report, live, visible, dark, onBounds, flightPaths, nightHighlight, comparePins = [] }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const planes = useRef<AircraftLayer | null>(null);
  const pin = useRef<Marker | null>(null);
  const latest = useRef({ report, visible, live, onBounds, flightPaths });
  latest.current = { report, visible, live, onBounds, flightPaths };
  const flightPos = useRef(0);

  const applyFlightHour = () => {
    const m = map.current, fp = latest.current.flightPaths;
    if (m?.getLayer("overflights") && fp) m.setPaintProperty("overflights", "heatmap-weight", flightWeight(flightPos.current, fp.hours.length) as never);
  };
  useImperativeHandle(ref, () => ({
    setFlightHour: (pos: number) => {
      flightPos.current = pos;
      applyFlightHour();
    },
    flyTo: (lat: number, lon: number) => {
      const m = map.current;
      if (m) m.flyTo({ center: [lon, lat], zoom: Math.max(m.getZoom(), 16), duration: 700, padding: sidePadding() });
    },
  }));
  const nightMarkers = useRef<PlaceMarker[]>([]);

  // Create the map once and never re-create it.
  useEffect(() => {
    const m = new MLMap({
      container: box.current!,
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: { base: { type: "raster", ...baseTiles(dark) } },
        layers: [{ id: "base", type: "raster", source: "base" }],
      },
      center: [-0.1, 51.51],
      zoom: 10.5,
      attributionControl: { compact: true },
      fadeDuration: 0,
    });
    map.current = m;
    // Inspect the map from the console with ?debug in the URL.
    if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { overnightMap: m, overnightDebug: { TYPES, drawAircraft, drawRotor } });

    // "style.load" fires as soon as the style is ready; "load" would also wait
    // for every initial tile, which delays the overlays on a slow connection.
    m.once("style.load", () => {
      for (const id of ["radius", "overflights", "crime", "air", "stations"]) m.addSource(id, { type: "geojson", data: empty });

      m.addLayer({
        id: "overflights", type: "heatmap", source: "overflights",
        paint: {
          "heatmap-weight": 0,
          "heatmap-radius": ["interpolate", ["exponential", 2], ["zoom"], 9, 14, 12, 60, 15, 400],
          "heatmap-intensity": 0.7,
          "heatmap-opacity": 0.55,
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(127,119,221,0)", 0.3, "rgba(175,169,236,0.45)", 0.7, "rgba(127,119,221,0.7)", 1, "rgba(83,74,183,0.85)"],
        },
      });

      m.addLayer({ id: "radius-fill", type: "fill", source: "radius", paint: { "fill-color": "#378ADD", "fill-opacity": 0.05 } });
      m.addLayer({ id: "radius-line", type: "line", source: "radius", paint: { "line-color": "#378ADD", "line-width": 1.5, "line-opacity": 0.7, "line-dasharray": [2, 2] } });

      m.addLayer({
        id: "crime-heat", type: "heatmap", source: "crime", maxzoom: 15,
        paint: {
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 11, 8, 15, 22],
          "heatmap-intensity": 0.6,
          "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 15, 0],
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(216,90,48,0)", 0.3, "rgba(240,153,123,0.5)", 1, "rgba(216,90,48,0.9)"],
        },
      });
      m.addLayer({
        id: "crime-points", type: "circle", source: "crime", minzoom: 13,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2, 17, 4.5],
          "circle-color": "#D85A30",
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, 0.7],
          "circle-stroke-width": 0.5,
          "circle-stroke-color": "#fff",
        },
      });

      const airColor = ["step", ["get", "index"], "#1D9E75", 4, "#BA7517", 7, "#E24B4A"] as unknown as string;
      m.addLayer({ id: "air-halo", type: "circle", source: "air", paint: { "circle-radius": 16, "circle-color": airColor, "circle-opacity": 0.15 } });
      m.addLayer({ id: "air-points", type: "circle", source: "air", paint: { "circle-radius": 5, "circle-color": airColor, "circle-stroke-width": 1.5, "circle-stroke-color": "#fff" } });
      m.addLayer({ id: "stations", type: "circle", source: "stations", paint: { "circle-radius": 6, "circle-color": "#185FA5", "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });

      // Aircraft go on top of everything.
      planes.current = new AircraftLayer(m);
      if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { overnightPlanes: planes.current });

      const popup = new Popup({ closeButton: false, offset: 10, maxWidth: "240px" });
      const show = (html: (p: Record<string, string>) => string) => (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (f) popup.setLngLat(e.lngLat).setHTML(html(f.properties as Record<string, string>)).addTo(m);
      };
      m.on("click", "stations", show((p) => `<strong>${esc(p.name)}</strong><br>${esc(p.lines)}`));
      m.on("click", "air-points", show((p) => `<strong>${esc(p.name)}</strong><br>${esc(p.band)} (${esc(p.index)}) · ${esc(p.pollutant)}`));
      m.on("click", "crime-points", show((p) => `<strong>${esc(p.label)}</strong><br>${esc(p.street)}`));
      for (const id of ["stations", "air-points", "crime-points"]) {
        m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
      }

      const { report, visible, live, flightPaths } = latest.current;
      applyReport(m, report);
      applyFlightPaths(m, flightPaths);
      applyFlightHour();
      applyVisibility(m, visible);
      planes.current.setVisible(visible.aircraft);
      if (live) planes.current.ingest(live.aircraft, live.now);
    });

    // Report the visible area, padded so aircraft are already loaded before
    // they fly into view.
    const reportBounds = () => {
      const b = m.getBounds();
      const padX = (b.getEast() - b.getWest()) * 0.25, padY = (b.getNorth() - b.getSouth()) * 0.25;
      latest.current.onBounds?.([b.getWest() - padX, b.getSouth() - padY, b.getEast() + padX, b.getNorth() + padY]);
    };
    m.on("moveend", reportBounds);
    m.once("load", reportBounds);

    let raf = 0;
    const tick = () => {
      planes.current?.frame();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      m.remove();
      map.current = null;
      planes.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap tiles for light and dark mode without rebuilding the map.
  useEffect(() => {
    (map.current?.getSource("base") as RasterTileSource | undefined)?.setTiles(baseTiles(dark).tiles);
  }, [dark]);

  // Fly as soon as we know where, before the report arrives.
  useEffect(() => {
    const m = map.current;
    if (!m || !target) return;
    m.flyTo({ center: [target.lon, target.lat], zoom: 13.6, duration: 900, padding: sidePadding() });
    if (!pin.current) {
      const el = document.createElement("div");
      el.className = "pin";
      pin.current = new Marker({ element: el });
    }
    pin.current.setLngLat([target.lon, target.lat]).addTo(m);
  }, [target?.lat, target?.lon]);

  useEffect(() => {
    if (map.current) applyReport(map.current, report);
  }, [report]);

  useEffect(() => {
    if (map.current) applyVisibility(map.current, visible);
    planes.current?.setVisible(visible.aircraft);
  }, [visible]);

  useEffect(() => {
    if (live) planes.current?.ingest(live.aircraft, live.now);
  }, [live]);

  useEffect(() => {
    if (!map.current) return;
    applyFlightPaths(map.current, flightPaths);
    applyFlightHour();
  }, [flightPaths]);

  // Comparison: a lettered pin per postcode, and the map fitted to show them all.
  const pins = useRef<Marker[]>([]);
  const pinKey = comparePins.map((p) => p.postcode).join(",");
  useEffect(() => {
    const m = map.current;
    for (const p of pins.current) p.remove();
    pins.current = [];
    if (!m || comparePins.length === 0) {
      if (pin.current && target) pin.current.addTo(m!);
      return;
    }
    pin.current?.remove();
    for (const p of comparePins) {
      // MapLibre owns the outer element's transform, so the pin shape is inside.
      const el = document.createElement("div");
      el.title = p.postcode;
      const shape = document.createElement("div");
      shape.className = "cmp-pin";
      shape.style.background = p.color;
      const letter = document.createElement("span");
      letter.textContent = p.label;
      shape.appendChild(letter);
      el.appendChild(shape);
      pins.current.push(new Marker({ element: el, anchor: "bottom" }).setLngLat([p.lon, p.lat]).addTo(m));
    }
    const lons = comparePins.map((p) => p.lon), lats = comparePins.map((p) => p.lat);
    const wide = window.innerWidth > 760;
    m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
      padding: wide ? { top: 90, bottom: 90, left: 90, right: Math.min(660, window.innerWidth * 0.55) + 40 } : { top: 150, bottom: window.innerHeight * 0.62 + 24, left: 40, right: 40 },
      maxZoom: 13,
      duration: 900,
    });
  }, [pinKey]);

  // Night bus stops and Night Tube stations, marked with the same badges as
  // the panel. Routes sharing a stop share one marker; click for details.
  useEffect(() => {
    const m = map.current;
    for (const n of nightMarkers.current) n.marker.remove();
    nightMarkers.current = [];
    if (!m) return;
    for (const g of groupByPlace(report?.getting_home?.options ?? [])) {
      g.sort((a, b) => Number(isRail(b)) - Number(isRail(a))); // rail first
      const badges = g.map((o) => ({ text: o.line, className: badgeClass(o), style: badgeStyle(o) }));
      const details = () => popupBox(...g.map((o, i) => nightBlock(badges[i], isRail(o) ? `${o.line} Night ${o.kind === "night_overground" ? "Overground" : "Tube"}` : `Route ${o.line}`, o.where, o.distance_m, nightsText(o))));
      nightMarkers.current.push(addPlaceMarker(m, [g[0].lon, g[0].lat], badges, g.map(optionKey), `${g[0].where}: ${g.map((o) => o.line).join(", ")}`, details, latest.current.visible.transport));
    }
  }, [report]);

  useEffect(() => {
    for (const n of nightMarkers.current) {
      n.el.style.display = visible.transport ? "" : "none";
    }
  }, [visible.transport]);

  // GPs, urgent treatment centres and A&Es, with the same badge markers.
  // Everything at one site (a hospital's A&E and UTC, GPs sharing a health
  // centre) shares one card; click for name, address and hours.
  const healthMarkers = useRef<PlaceMarker[]>([]);
  useEffect(() => {
    const m = map.current;
    for (const n of healthMarkers.current) n.marker.remove();
    healthMarkers.current = [];
    if (!m || !report) return;
    type Item = { lat: number; lon: number; key: string; badge: Badge; block: () => HTMLElement; order: number; label: string };
    const gpHours = report.medical?.gp_hours;
    const items: Item[] = [
      ...(report.layers.ae ?? []).map((h) => ({ lat: h.lat, lon: h.lon, key: `ae:${h.name}`, badge: AE_BADGE, block: () => aeBlock(h), order: 0, label: `${h.name} A&E` })),
      ...(report.layers.utcs ?? []).map((u) => ({ lat: u.lat, lon: u.lon, key: `utc:${u.name}`, badge: utcBadge(u), block: () => utcBlock(u), order: 1, label: u.name })),
      ...(report.layers.gps ?? []).map((g) => ({
        lat: g.lat, lon: g.lon, key: `gp:${g.code}`, badge: GP_BADGE, order: 2, label: g.name,
        block: () => gpBlock(g, gpHours ?? { open24: false, days: [], text: "Weekdays 8am–6:30pm" }),
      })),
    ];
    for (const g of groupByPlace(items)) {
      g.sort((a, b) => a.order - b.order);
      healthMarkers.current.push(addPlaceMarker(m, [g[0].lon, g[0].lat], g.map((x) => x.badge), g.map((x) => x.key), g.map((x) => x.label).join(" · "), () => popupBox(...g.map((x) => x.block())), latest.current.visible.health));
    }
  }, [report]);

  useEffect(() => {
    for (const n of healthMarkers.current) n.el.style.display = visible.health ? "" : "none";
  }, [visible.health]);

  useEffect(() => {
    for (const n of [...nightMarkers.current, ...healthMarkers.current]) {
      const on = !!nightHighlight && n.keys.includes(nightHighlight);
      n.el.classList.toggle("hl", on);
      n.el.classList.toggle("dim", !!nightHighlight && !on);
    }
  }, [nightHighlight, report]);

  return <div ref={box} className="map" />;
});

export default MapView;

// One point per grid cell, with each hour's count as h0, h1, ... so the
// heatmap can pick an hour with a paint property instead of new data.
function applyFlightPaths(m: MLMap, fp: FlightPaths | null) {
  const features: GeoJSON.Feature[] = (fp?.cells ?? []).map((c) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    properties: Object.fromEntries(c.h.map((v, i) => [`h${i}`, v])),
  }));
  (m.getSource("overflights") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
}

function sidePadding() {
  // Keep the searched point visible beside the report panel on desktop.
  return window.innerWidth > 760 ? { right: 380, left: 0, top: 0, bottom: 0 } : { bottom: window.innerHeight * 0.45, top: 0, left: 0, right: 0 };
}

function applyReport(m: MLMap, r: Report | null) {
  const set = (id: string, data: GeoJSON.FeatureCollection) => (m.getSource(id) as GeoJSONSource | undefined)?.setData(data);
  if (!r) {
    for (const id of ["radius", "crime", "air", "stations"]) set(id, empty);
    return;
  }
  set("radius", circle(r.place.lat, r.place.lon, r.radius_m));
  set("crime", points(r.layers.crime, (c) => ({ label: crimeLabel(c.category), street: c.street })));
  set("air", points(r.layers.air, (a) => ({ name: a.name, index: a.index, band: a.band, pollutant: a.pollutant })));
  set("stations", points(r.layers.stations, (s) => ({ name: s.name, lines: s.lines.map((l) => l.name).join(", ") })));
}

function applyVisibility(m: MLMap, v: Record<LayerKey, boolean>) {
  for (const key of Object.keys(layerIds) as (keyof typeof layerIds)[]) {
    for (const id of layerIds[key]) {
      if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", v[key] ? "visible" : "none");
    }
  }
}

function crimeLabel(slug: string) {
  const s = slug.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
