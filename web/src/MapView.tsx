import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Map as MLMap, Marker, Popup, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type RasterTileSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre v6 ships its worker as a separate file; let Vite copy it and tell MapLibre where it is.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { AircraftLayer } from "./aircraft";
import { TYPES } from "./aircraftTypes";
import { drawAircraft, drawRotor } from "./silhouettes";
import { badgeClass, badgeStyle, isRail, optionKey } from "./nightBadges";
import type { Aircraft, FlightPaths, NightOption, Report } from "./types";

setWorkerUrl(workerUrl);

export type LayerKey = "aircraft" | "overflights" | "crime" | "air" | "transport";

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
};

const MapView = forwardRef<MapHandle, Props>(function MapView({ target, report, live, visible, dark, onBounds, flightPaths, nightHighlight }, ref) {
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
  const nightMarkers = useRef<{ marker: Marker; keys: string[]; el: HTMLElement }[]>([]);

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

  // Night bus stops and Night Tube stations, marked with the same badges as
  // the panel. Routes sharing a stop share one marker.
  useEffect(() => {
    const m = map.current;
    for (const n of nightMarkers.current) n.marker.remove();
    nightMarkers.current = [];
    if (!m) return;
    const groups = new Map<string, NightOption[]>();
    for (const o of report?.getting_home?.options ?? []) {
      const k = `${o.lat.toFixed(5)},${o.lon.toFixed(5)}`;
      groups.set(k, [...(groups.get(k) ?? []), o]);
    }
    for (const g of groups.values()) {
      g.sort((a, b) => Number(isRail(b)) - Number(isRail(a))); // rail first
      const el = document.createElement("div");
      el.className = "nt-marker";
      const card = document.createElement("div");
      card.className = "nt-badges";
      for (const o of g.slice(0, 4)) {
        const b = document.createElement("span");
        b.className = badgeClass(o);
        Object.assign(b.style, badgeStyle(o));
        b.textContent = o.line;
        card.appendChild(b);
      }
      if (g.length > 4) {
        const more = document.createElement("span");
        more.className = "nt-more";
        more.textContent = `+${g.length - 4}`;
        card.appendChild(more);
      }
      const pin = document.createElement("div");
      pin.className = "nt-pin";
      // MapLibre positions the marker with a transform on `el`, so any
      // scaling happens on this inner wrapper instead.
      const inner = document.createElement("div");
      inner.className = "nt-inner";
      inner.append(card, pin);
      el.append(inner);
      el.title = `${g[0].where}: ${g.map((o) => o.line).join(", ")}`;
      el.style.display = latest.current.visible.transport ? "" : "none";
      const marker = new Marker({ element: el, anchor: "bottom" }).setLngLat([g[0].lon, g[0].lat]).addTo(m);
      nightMarkers.current.push({ marker, keys: g.map(optionKey), el });
    }
  }, [report]);

  useEffect(() => {
    for (const n of nightMarkers.current) {
      n.el.style.display = visible.transport ? "" : "none";
    }
  }, [visible.transport]);

  useEffect(() => {
    for (const n of nightMarkers.current) {
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
