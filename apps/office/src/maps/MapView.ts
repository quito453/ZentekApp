// One small map interface for the Routes and Live screens. Google Maps when a key is set; OpenStreetMap
// (Leaflet) otherwise, so the app still works in development and if the key is missing.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { hasGoogle, loadGoogle, MAP_ID } from "./google";

export type LL = [number, number];
export interface MarkerSpec { at: LL; html: string; title?: string; tooltip?: string; z?: number; onClick?: () => void }
export interface MapView {
  clear(): void;
  marker(m: MarkerSpec): void;
  line(points: LL[], color: string, weight?: number, opacity?: number): void;
  fit(points: LL[], maxZoom?: number): void;
  resize(): void;
  destroy(): void;
}

const TILES = (import.meta.env.VITE_MAP_TILES as string | undefined) || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIB = (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) || "© OpenStreetMap contributors";
const html = (s: string) => { const d = document.createElement("div"); d.innerHTML = s; return d.firstElementChild as HTMLElement; };

function leafletMap(el: HTMLElement, center: LL): MapView {
  const m = L.map(el).setView(center, 11);
  L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIB }).addTo(m);
  const g = L.layerGroup().addTo(m);
  return {
    clear: () => g.clearLayers(),
    marker: (s) => {
      const mk = L.marker(s.at, { icon: L.divIcon({ className: "", html: s.html, iconSize: [30, 30], iconAnchor: [15, 15] }), title: s.title, zIndexOffset: s.z ?? 0, keyboard: true });
      if (s.tooltip) mk.bindTooltip(s.tooltip);
      if (s.onClick) mk.on("click", s.onClick);
      mk.addTo(g);
    },
    line: (pts, color, weight = 4, opacity = 0.8) => { if (pts.length > 1) L.polyline(pts, { color, weight, opacity }).addTo(g); },
    fit: (pts, maxZoom = 15) => { if (pts.length) m.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom }); },
    resize: () => m.invalidateSize(),
    destroy: () => m.remove(),
  };
}

async function googleMap(el: HTMLElement, center: LL): Promise<MapView> {
  await loadGoogle();
  const { Map } = (await google.maps.importLibrary("maps")) as google.maps.MapsLibrary;
  const { AdvancedMarkerElement } = (await google.maps.importLibrary("marker")) as google.maps.MarkerLibrary;
  const m = new Map(el, { center: { lat: center[0], lng: center[1] }, zoom: 11, mapId: MAP_ID, streetViewControl: false, mapTypeControl: false, fullscreenControl: true, clickableIcons: false });
  let items: { setMap?: (m: google.maps.Map | null) => void; map?: google.maps.Map | null }[] = [];
  return {
    clear: () => { for (const i of items) { if (i.setMap) i.setMap(null); else i.map = null; } items = []; },
    marker: (s) => {
      const content = html(s.html);
      if (s.tooltip) content.title = s.tooltip.replace(/<[^>]+>/g, " ");
      const mk = new AdvancedMarkerElement({ map: m, position: { lat: s.at[0], lng: s.at[1] }, content, title: s.title ?? "", zIndex: s.z ?? 0, gmpClickable: !!s.onClick });
      if (s.onClick) mk.addListener("gmp-click", s.onClick);
      items.push(mk);
    },
    line: (pts, color, weight = 4, opacity = 0.8) => {
      if (pts.length < 2) return;
      items.push(new google.maps.Polyline({ map: m, path: pts.map(([lat, lng]) => ({ lat, lng })), strokeColor: color, strokeWeight: weight, strokeOpacity: opacity }));
    },
    fit: (pts, maxZoom = 15) => {
      if (!pts.length) return;
      const b = new google.maps.LatLngBounds();
      for (const [lat, lng] of pts) b.extend({ lat, lng });
      m.fitBounds(b, 36);
      google.maps.event.addListenerOnce(m, "idle", () => { if ((m.getZoom() ?? 0) > maxZoom) m.setZoom(maxZoom); });
    },
    resize: () => {},
    destroy: () => { for (const i of items) { if (i.setMap) i.setMap(null); else i.map = null; } },
  };
}

/** Make a map in `el`. Falls back to OpenStreetMap if Google can't load. */
export async function createMap(el: HTMLElement, center: LL = [43.7, -79.4]): Promise<MapView> {
  if (hasGoogle()) {
    try {
      return await googleMap(el, center);
    } catch {
      /* fall through to OpenStreetMap */
    }
  }
  return leafletMap(el, center);
}

/** The yard pin, the same on every map. */
export const YARD_HTML = `<span class="yardpin" aria-hidden="true">Y</span>`;
