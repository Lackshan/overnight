// Badge markers for places on the map (night stops, GPs, urgent care, A&E),
// grouped so places at the same spot share one card, and a popup with
// details on click. Everything is built with textContent: the data comes
// from outside sources.
import { Marker, Popup, type Map as MLMap } from "maplibre-gl";
import { status } from "./health";
import type { GP, Hospital, Hours, UTC } from "./types";

export interface Badge {
  text: string;
  className: string;
  style?: Partial<CSSStyleDeclaration>;
}

export interface PlaceMarker {
  marker: Marker;
  keys: string[]; // for highlighting from the panel
  el: HTMLElement;
}

const popup = new Popup({ closeButton: true, closeOnClick: true, offset: 28, maxWidth: "290px", className: "place-popup-wrap" });

export function addPlaceMarker(m: MLMap, lngLat: [number, number], badges: Badge[], keys: string[], title: string, details: () => HTMLElement, visible: boolean): PlaceMarker {
  const el = document.createElement("div");
  el.className = "nt-marker clickable";
  // MapLibre positions the marker with a transform on `el`, so any scaling
  // happens on this inner wrapper instead.
  const inner = document.createElement("div");
  inner.className = "nt-inner";
  const card = document.createElement("div");
  card.className = "nt-badges";
  for (const b of badges.slice(0, 4)) {
    const s = document.createElement("span");
    s.className = b.className;
    if (b.style) Object.assign(s.style, b.style);
    s.textContent = b.text;
    card.appendChild(s);
  }
  if (badges.length > 4) {
    const more = document.createElement("span");
    more.className = "nt-more";
    more.textContent = `+${badges.length - 4}`;
    card.appendChild(more);
  }
  const pin = document.createElement("div");
  pin.className = "nt-pin";
  inner.append(card, pin);
  el.append(inner);
  el.title = title;
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.style.display = visible ? "" : "none";
  const open = (e: Event) => {
    e.stopPropagation();
    popup.setLngLat(lngLat).setDOMContent(details()).addTo(m);
  };
  el.addEventListener("click", open);
  el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && open(e));
  const marker = new Marker({ element: el, anchor: "bottom" }).setLngLat(lngLat).addTo(m);
  return { marker, keys, el };
}

// Small DOM helpers for popup content.
function node(tag: string, className: string, text?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function popupBox(...blocks: HTMLElement[]) {
  const box = node("div", "place-popup");
  blocks.forEach((b, i) => {
    if (i > 0) box.appendChild(node("hr", ""));
    box.appendChild(b);
  });
  return box;
}

const dist = (m: number) => (m < 200 ? "On the doorstep" : m < 1000 ? `${Math.round(m / 10) * 10} m away` : `${(m / 1000).toFixed(1)} km away`);

function block(badge: Badge, title: string, lines: (HTMLElement | string | null)[]) {
  const b = node("div", "pp-block");
  const head = node("div", "pp-head");
  const s = node("span", badge.className, badge.text);
  if (badge.style) Object.assign(s.style, badge.style);
  head.append(s, node("strong", "", title));
  b.appendChild(head);
  for (const l of lines) {
    if (!l) continue;
    b.appendChild(typeof l === "string" ? node("div", "pp-line", l) : l);
  }
  return b;
}

function hoursLine(h: Hours, usually = false) {
  const st = status(h);
  const line = node("div", "pp-line");
  const state = node("span", st.open ? "med-open" : "med-closed", usually ? st.text.replace(/^Open until/, "Usually open until").replace(/^Opens/, "Usually opens") : st.text);
  line.append(state, document.createTextNode(` · ${h.text}`));
  return line;
}

function link(href: string, text: string) {
  const line = node("div", "pp-line");
  const a = node("a", "", text) as HTMLAnchorElement;
  a.href = href;
  if (href.startsWith("http")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  line.appendChild(a);
  return line;
}

export const GP_BADGE: Badge = { text: "GP", className: "gh-badge gh-gp" };
export const AE_BADGE: Badge = { text: "A&E", className: "gh-badge gh-ae" };
export const utcBadge = (u: UTC): Badge => ({ text: u.schedule.open24 ? "UTC 24h" : "UTC", className: "gh-badge gh-utc" });

export function gpBlock(g: GP, hours: Hours) {
  return block(GP_BADGE, g.name, [
    `${g.address}, ${g.postcode}`,
    hoursLine(hours, true),
    node("div", "pp-line muted", "Standard GP hours; many surgeries open longer."),
    g.phone ? link(`tel:${g.phone.replace(/\s/g, "")}`, g.phone) : null,
    node("div", "pp-line muted", dist(g.distance_m)),
  ]);
}

export function utcBlock(u: UTC) {
  return block(utcBadge(u), u.name, [
    `${u.site}, ${u.postcode}`,
    hoursLine(u.schedule),
    u.walkIn === false ? node("div", "pp-line", "Not walk-in: call NHS 111 or go through A&E first.") : null,
    u.note ? node("div", "pp-line muted", u.note) : null,
    node("div", "pp-line muted", dist(u.distance_m)),
    link(u.source, "Source: check hours before you go"),
  ]);
}

export function aeBlock(h: Hospital) {
  const open = node("div", "pp-line");
  open.append(node("span", "med-open", "Open 24 hours"), document.createTextNode(" · emergencies only"));
  return block(AE_BADGE, h.name, [h.postcode, open, node("div", "pp-line muted", dist(h.distance_m)), node("div", "pp-line muted", "For anything life-threatening, call 999.")]);
}

export function nightBlock(badge: Badge, title: string, where: string, distance: number, nights: string) {
  return block(badge, title, [where, nights, node("div", "pp-line muted", dist(distance))]);
}

// Groups items that sit at (almost) the same spot.
export function groupByPlace<T extends { lat: number; lon: number }>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = `${it.lat.toFixed(4)},${it.lon.toFixed(4)}`;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  return [...groups.values()];
}
