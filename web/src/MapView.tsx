import { useEffect, useRef } from "react";
import { Map as MLMap, Marker, Popup, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type RasterTileSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre v6 ships its worker as a separate file; let Vite copy it and tell MapLibre where it is.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { AircraftLayer } from "./aircraft";
import type { Aircraft, Report } from "./types";

setWorkerUrl(workerUrl);

export type LayerKey = "aircraft" | "overflights" | "crime" | "air" | "transport";

interface Props {
  target: { lat: number; lon: number } | null;
  report: Report | null;
  live: { aircraft: Aircraft[]; now: number } | null;
  visible: Record<LayerKey, boolean>;
  dark: boolean;
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

export default function MapView({ target, report, live, visible, dark }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const planes = useRef<AircraftLayer | null>(null);
  const pin = useRef<Marker | null>(null);
  const latest = useRef({ report, visible, live });
  latest.current = { report, visible, live };

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
    if (new URLSearchParams(location.search).has("debug")) (window as unknown as { overnightMap: MLMap }).overnightMap = m;

    // "style.load" fires as soon as the style is ready; "load" would also wait
    // for every initial tile, which delays the overlays on a slow connection.
    m.once("style.load", () => {
      for (const id of ["radius", "overflights", "crime", "air", "stations"]) m.addSource(id, { type: "geojson", data: empty });

      m.addLayer({
        id: "overflights", type: "heatmap", source: "overflights",
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "passes"], 0, 0, 30, 1],
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

      const { report, visible, live } = latest.current;
      applyReport(m, report);
      applyVisibility(m, visible);
      planes.current.setVisible(visible.aircraft);
      if (live) planes.current.ingest(live.aircraft, live.now);
    });

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

  return <div ref={box} className="map" />;
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
  set("overflights", points(r.layers.overflights, (c) => ({ passes: c.passes })));
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
