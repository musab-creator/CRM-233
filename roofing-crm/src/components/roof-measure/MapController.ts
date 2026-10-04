'use client';

import type { LatLng } from '@/lib/roof-measure/geo';
import type { Edge, Facet, Project } from '@/lib/roof-measure/model';
import { draftLabels, EDGE_TYPES, FACET_COLOR, mapLabels, type MapLabel, type ToPixel } from '@/lib/roof-measure/measure';
import { COM_COL, SEC_FILL } from '@/lib/roof-measure/commercial-report';
import type { CommercialModel } from '@/lib/roof-measure/commercial';
import { useRM } from './store';
import { KEYS, readJSON } from './storage';

// The Google Map and everything drawn on it, kept in step with the store:
// facets (polygons), lines (polylines, dashed for wall / step flashing), the
// shape being drawn with its rubber band, Solar API plane boxes, the
// commercial measurement, the house pin and the label overlay. Map and shape
// events go back to the store; nothing here measures anything.

type Shape = google.maps.Polygon | google.maps.Polyline;
interface Bound { shape: Shape; listeners: google.maps.MapsEventListener[]; pathListeners: google.maps.MapsEventListener[] }

const lit = (ll: google.maps.LatLng): LatLng => ({ lat: ll.lat(), lng: ll.lng() });
const pathOf = (shape: Shape): LatLng[] => shape.getPath().getArray().map(lit);
const samePath = (a: LatLng[], b: LatLng[]) => a.length === b.length && a.every((p, i) => p.lat === b[i].lat && p.lng === b[i].lng);
const dashedIcons = (color: string): google.maps.IconSequence[] => [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: color, strokeWeight: 4, scale: 2.5 }, offset: '0', repeat: '12px' }];

function facetStyle(f: Facet, selected: boolean): google.maps.PolygonOptions {
  if (f.excluded) return { fillColor: '#ffffff', fillOpacity: 0.35, strokeColor: selected ? '#ff7a00' : '#ffffff', strokeWeight: selected ? 3 : 2, strokeOpacity: 0.9, zIndex: 12 };
  return { fillColor: FACET_COLOR, fillOpacity: 0.22, strokeColor: selected ? '#ff7a00' : '#ffffff', strokeWeight: selected ? 3 : 2, strokeOpacity: 1, zIndex: 10 };
}
function edgeStyle(e: Edge, selected: boolean): google.maps.PolylineOptions {
  const t = EDGE_TYPES[e.type];
  return t.dashed
    ? { strokeColor: t.color, strokeOpacity: 0, strokeWeight: selected ? 7 : 4, icons: dashedIcons(t.color), zIndex: 20 }
    : { strokeColor: t.color, strokeOpacity: 1, strokeWeight: selected ? 7 : 4, icons: [], zIndex: 20 };
}

// Label overlay: one absolutely positioned div per label in the float pane.
interface LabelLayer extends google.maps.OverlayView { setItems(items: MapLabel[]): void }
function createLabelLayer(map: google.maps.Map): LabelLayer {
  class Layer extends google.maps.OverlayView {
    items: MapLabel[] = [];
    div: HTMLDivElement | null = null;
    onAdd() {
      this.div = document.createElement('div');
      this.div.className = 'rm-labels';
      this.getPanes()?.floatPane.appendChild(this.div);
    }
    onRemove() { this.div?.remove(); this.div = null; }
    setItems(items: MapLabel[]) { this.items = items; this.draw(); }
    draw() {
      if (!this.div) return;
      const proj = this.getProjection();
      if (!proj) return;
      let html = '';
      for (const it of this.items) {
        const p = proj.fromLatLngToDivPixel(new google.maps.LatLng(it.lat, it.lng));
        if (!p) continue;
        const cls = (it.cls || '').split(' ').filter(Boolean).map((c) => 'rm-lbl-' + c).join(' ');
        html += `<div class="rm-lbl ${cls}" style="left:${p.x}px;top:${p.y}px">${it.html}</div>`;
      }
      this.div.innerHTML = html;
    }
  }
  const layer = new Layer();
  layer.setMap(map);
  return layer;
}

export interface MapHandlers {
  onLockHouse: (ll: LatLng, keepView: boolean) => void;
}

export class MapController {
  map: google.maps.Map;
  private labels: LabelLayer;
  private facets = new Map<number, Bound>();
  private edges = new Map<number, Bound>();
  private solarShapes: google.maps.Rectangle[] = [];
  private comShapes: Shape[] = [];
  private draftLine: google.maps.Polyline | null = null;
  private draftRubber: google.maps.Polyline | null = null;
  private draftFill: google.maps.Polygon | null = null;
  private marker: google.maps.Marker | null = null;
  private syncing = false;
  private unsub: () => void;
  private lastMenu = 0;
  private press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  private pressFired = false; // the click that ends a long-press only selects, it does not pick the (deleted) corner

  constructor(el: HTMLElement, private handlers: MapHandlers) {
    const saved = readJSON<LatLng | null>(KEYS.lastLoc, null);
    const loc = useRM.getState().project.location;
    const start = loc || saved || { lat: 30.3322, lng: -81.6557 };
    this.map = new google.maps.Map(el, {
      center: start, zoom: loc ? 20 : saved ? 19 : 12, mapTypeId: 'satellite', tilt: 0, heading: 0,
      disableDoubleClickZoom: true, clickableIcons: false, gestureHandling: 'greedy',
      streetViewControl: false, fullscreenControl: false, rotateControl: false, scaleControl: true,
      mapTypeControl: true, mapTypeControlOptions: { mapTypeIds: ['satellite', 'hybrid'], position: google.maps.ControlPosition.LEFT_BOTTOM },
      zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
    });
    this.map.addListener('tilt_changed', () => { if (this.map.getTilt() !== 0) this.map.setTilt(0); });
    this.labels = createLabelLayer(this.map);

    const S = () => useRM.getState();
    this.map.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      if (S().picking) { this.handlers.onLockHouse(lit(e.latLng), false); return; }
      S().mapClick(lit(e.latLng), this.toPixel);
    });
    this.map.addListener('dblclick', (e: google.maps.MapMouseEvent) => {
      if (!e.latLng || S().picking) return;
      // drawing tools finish the shape; with the select tool a double-click locks in the house under it
      if (S().tool !== 'select') { S().finishDraft(); return; }
      if (!S().draft) this.handlers.onLockHouse(lit(e.latLng), false);
    });
    this.map.addListener('mousemove', (e: google.maps.MapMouseEvent) => { if (e.latLng && S().draft) S().mapMove(lit(e.latLng), this.toPixel); });
    const menu = () => { if (this.menuOnce()) S().undoPoint(); };
    this.map.addListener('rightclick', menu);
    this.map.addListener('contextmenu', menu);

    this.unsub = useRM.subscribe((s, prev) => this.render(s, prev));
    this.render(useRM.getState(), null);
    // a roof restored before the map existed (reload): show all of it
    const facets = useRM.getState().project.facets;
    if (facets.length) this.fitPaths(facets.map((f) => f.path));
  }

  destroy() {
    this.unsub();
    for (const b of [...this.facets.values(), ...this.edges.values()]) this.unbind(b);
    this.clearDraft();
    for (const s of [...this.solarShapes, ...this.comShapes]) s.setMap(null);
    this.marker?.setMap(null);
    this.labels.setMap(null);
    google.maps.event.clearInstanceListeners(this.map);
  }

  toPixel: ToPixel = (p) => {
    const proj = this.labels.getProjection();
    if (!proj) return null;
    const pt = proj.fromLatLngToContainerPixel(new google.maps.LatLng(p.lat, p.lng));
    return pt ? { x: pt.x, y: pt.y } : null;
  };

  // ------------------------------------------------------------------ view
  center(): LatLng { const c = this.map.getCenter(); return c ? lit(c) : { lat: 30.33, lng: -81.66 }; }
  zoom() { return this.map.getZoom() || 20; }
  setView(c: LatLng, z: number) { this.map.setCenter(c); this.map.setZoom(z); }
  panTo(c: LatLng, z?: number) { this.map.panTo(c); if (z != null) this.map.setZoom(z); }
  panBy(x: number, y: number) { this.map.panBy(x, y); }
  fitPaths(paths: LatLng[][], padding = 80) {
    const b = new google.maps.LatLngBounds();
    let n = 0;
    for (const path of paths) for (const p of path) { b.extend(p); n++; }
    if (n) this.map.fitBounds(b, padding);
  }

  // ------------------------------------------------------------------ store -> map
  private render(s: ReturnType<typeof useRM.getState>, prev: ReturnType<typeof useRM.getState> | null) {
    const P = s.project, Q = prev?.project;
    const shapesChanged = !prev || P.facets !== Q!.facets || P.edges !== Q!.edges || s.selected !== prev.selected || s.tool !== prev.tool || s.picking !== prev.picking;
    if (shapesChanged) this.syncShapes(P, s);
    if (!prev || P.solar !== Q!.solar || P.otherSolar !== Q!.otherSolar || s.showSolar !== prev.showSolar) this.drawSolar(P, s.showSolar);
    if (!prev || s.comModel !== prev.comModel || s.mode !== prev.mode) this.drawCommercial(s.mode === 'com' ? s.comModel : null);
    if (!prev || s.draft !== prev.draft) this.drawDraft(s.draft);
    if (!prev || P.location !== Q!.location) this.drawMarker(P.location);
    if (!prev || s.tool !== prev.tool || s.picking !== prev.picking) this.map.setOptions({ draggableCursor: s.tool !== 'select' || s.picking ? 'crosshair' : null });
    const labelsChanged = !prev || P !== Q || s.draft !== prev.draft || s.showFacetEdges !== prev.showFacetEdges || s.showSolar !== prev.showSolar;
    if (labelsChanged) {
      // Solar plane labels first, so facet labels at the same spot draw on top of them
      const items = mapLabels(P, { showFacetEdges: s.showFacetEdges, showSolar: s.showSolar }).sort((a, b) => Number(/solar/.test(b.cls)) - Number(/solar/.test(a.cls)));
      if (s.draft) items.push(...draftLabels(s.draft.tool, s.draft.points, s.draft.cursor, P.defaultPitch));
      this.labels.setItems(items);
    }
  }

  private syncShapes(P: Project, s: ReturnType<typeof useRM.getState>) {
    const clickable = s.tool === 'select' && !s.picking;
    const sel = s.selected;
    this.syncKind('facet', P.facets, clickable, sel);
    this.syncKind('edge', P.edges, clickable, sel);
  }

  private syncKind(kind: 'facet' | 'edge', items: (Facet | Edge)[], clickable: boolean, sel: ReturnType<typeof useRM.getState>['selected']) {
    const store = kind === 'facet' ? this.facets : this.edges;
    const seen = new Set<number>();
    for (const item of items) {
      seen.add(item.id);
      const selected = !!sel && sel.kind === kind && sel.id === item.id;
      const style = kind === 'facet' ? facetStyle(item as Facet, selected) : edgeStyle(item as Edge, selected);
      let b = store.get(item.id);
      if (!b) {
        const shape: Shape = kind === 'facet'
          ? new google.maps.Polygon({ map: this.map, paths: item.path, geodesic: false, ...style })
          : new google.maps.Polyline({ map: this.map, path: item.path, ...style });
        b = { shape, listeners: [], pathListeners: [] };
        this.bindShape(b, kind, item.id);
        store.set(item.id, b);
      } else if (!samePath(pathOf(b.shape), item.path)) {
        this.syncing = true;
        b.shape.setPath(item.path);
        this.syncing = false;
        this.bindPath(b, kind, item.id);
      }
      b.shape.setOptions({ ...style, clickable, editable: selected && clickable });
    }
    for (const [id, b] of store) if (!seen.has(id)) { this.unbind(b); store.delete(id); }
  }

  private menuOnce() { const now = Date.now(); if (now - this.lastMenu < 80) return false; this.lastMenu = now; return true; }

  private bindShape(b: Bound, kind: 'facet' | 'edge', id: number) {
    const S = () => useRM.getState();
    const sh = b.shape;
    b.listeners.push(sh.addListener('click', (e: google.maps.PolyMouseEvent) => {
      if (S().tool !== 'select') return;
      const fired = this.pressFired;
      this.pressFired = false;
      S().select({ kind, id }, e.vertex != null && !fired ? e.vertex : null);
    }));
    const menu = (e: google.maps.PolyMouseEvent) => {
      if (e.vertex == null || !this.menuOnce()) return;
      S().deleteVertex(kind, id, e.vertex);
    };
    b.listeners.push(sh.addListener('rightclick', menu), sh.addListener('contextmenu', menu));
    // touch: press and hold a corner of the selected shape to delete it
    b.listeners.push(sh.addListener('mousedown', (e: google.maps.PolyMouseEvent) => {
      this.cancelPress();
      this.pressFired = false;
      if (e.vertex == null) return;
      const de = e.domEvent as MouseEvent | TouchEvent | undefined;
      const pt = de && 'touches' in de ? de.touches[0] : (de as MouseEvent | undefined);
      const vertex = e.vertex;
      this.press = {
        x: pt ? pt.clientX : 0, y: pt ? pt.clientY : 0,
        timer: setTimeout(() => {
          this.press = null;
          if (S().deleteVertex(kind, id, vertex)) { this.pressFired = true; S().showToast('Corner removed'); }
        }, 650),
      };
    }));
    b.listeners.push(sh.addListener('mouseup', () => this.cancelPress()));
    b.listeners.push(sh.addListener('mousemove', (e: google.maps.PolyMouseEvent) => {
      if (!this.press) return;
      const de = e.domEvent as MouseEvent | TouchEvent | undefined;
      const pt = de && 'touches' in de ? de.touches[0] : (de as MouseEvent | undefined);
      if (pt && Math.hypot(pt.clientX - this.press.x, pt.clientY - this.press.y) > 8) this.cancelPress();
    }));
    this.bindPath(b, kind, id);
  }

  private cancelPress() { if (this.press) { clearTimeout(this.press.timer); this.press = null; } }

  // Corner drags (set_at), midpoint drags (insert_at) and deletions write the path back into the project.
  private bindPath(b: Bound, kind: 'facet' | 'edge', id: number) {
    for (const l of b.pathListeners) l.remove();
    const path = b.shape.getPath();
    const sync = () => {
      if (this.syncing) return;
      this.cancelPress();
      useRM.getState().setShapePath(kind, id, pathOf(b.shape));
    };
    b.pathListeners = ['set_at', 'insert_at', 'remove_at'].map((ev) => path.addListener(ev, sync));
  }

  private unbind(b: Bound) {
    for (const l of [...b.listeners, ...b.pathListeners]) l.remove();
    b.shape.setMap(null);
  }

  private clearDraft() {
    this.draftLine?.setMap(null); this.draftRubber?.setMap(null); this.draftFill?.setMap(null);
    this.draftLine = this.draftRubber = null; this.draftFill = null;
  }

  private drawDraft(d: ReturnType<typeof useRM.getState>['draft']) {
    if (!d) { this.clearDraft(); return; }
    const color = d.tool === 'facet' ? FACET_COLOR : EDGE_TYPES[d.tool].color;
    if (!this.draftLine) {
      this.draftLine = new google.maps.Polyline({ map: this.map, path: [], strokeColor: color, strokeWeight: 3, clickable: false, zIndex: 50 });
      this.draftRubber = new google.maps.Polyline({ map: this.map, path: [], strokeColor: color, strokeOpacity: 0, clickable: false, zIndex: 50, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeWeight: 2, scale: 3 }, offset: '0', repeat: '12px' }] });
      if (d.tool === 'facet') this.draftFill = new google.maps.Polygon({ map: this.map, paths: [], fillColor: color, fillOpacity: 0.15, strokeOpacity: 0, clickable: false, zIndex: 49 });
    }
    this.draftLine.setPath(d.points);
    this.draftFill?.setPath(d.points);
    const last = d.points[d.points.length - 1];
    this.draftRubber!.setPath(last && d.cursor ? [last, d.cursor] : []);
  }

  private drawSolar(P: Project, show: boolean) {
    for (const r of this.solarShapes) r.setMap(null);
    this.solarShapes = [];
    if (!show) return;
    type BB = { ne: { latitude: number; longitude: number }; sw: { latitude: number; longitude: number } };
    const rect = (bb: BB, opts: google.maps.RectangleOptions) => this.solarShapes.push(new google.maps.Rectangle({
      map: this.map, bounds: { north: bb.ne.latitude, east: bb.ne.longitude, south: bb.sw.latitude, west: bb.sw.longitude }, clickable: false, zIndex: 1, ...opts,
    }));
    const sp = P.solar?.solarPotential;
    if (P.solar && sp) {
      if (P.solar.boundingBox) rect(P.solar.boundingBox, { strokeColor: '#ffd60a', strokeOpacity: 0.9, strokeWeight: 2, fillOpacity: 0 });
      for (const seg of sp.roofSegmentStats || []) rect(seg.boundingBox, { strokeColor: '#ffd60a', strokeOpacity: 0.5, strokeWeight: 1, fillColor: '#ffd60a', fillOpacity: 0.06 });
    }
    for (const o of P.otherSolar) if (o.boundingBox) rect(o.boundingBox, { strokeColor: '#ff7a00', strokeOpacity: 0.95, strokeWeight: 2, fillColor: '#ff7a00', fillOpacity: 0.12 });
  }

  private drawCommercial(M: CommercialModel | null) {
    for (const s of this.comShapes) s.setMap(null);
    this.comShapes = [];
    if (!M) return;
    const LL = M.toLL;
    M.sections.forEach((s, i) => { if (s.poly.length >= 3) this.comShapes.push(new google.maps.Polygon({ map: this.map, paths: s.poly.map(LL), strokeWeight: 1, strokeColor: '#fff', fillColor: SEC_FILL[i % SEC_FILL.length], fillOpacity: 0.28, clickable: false })); });
    for (const e of M.edges) this.comShapes.push(new google.maps.Polyline({ map: this.map, path: [LL(e.a), LL(e.b)], strokeColor: COM_COL[e.kind], strokeWeight: e.kind === 'parapet' ? 5 : 3, clickable: false }));
    for (const wl of M.walls) for (const sg of wl.segs) this.comShapes.push(new google.maps.Polyline({ map: this.map, path: sg.map(LL), strokeColor: COM_COL[wl.kind], strokeWeight: wl.kind === 'wall' ? 4 : 2, clickable: false }));
    for (const o of M.objects) {
      if (/Obstruction|Expansion/.test(o.type)) continue;
      this.comShapes.push(new google.maps.Polygon({ map: this.map, paths: o.corners.map(LL), strokeColor: /Vent|penetration/i.test(o.type) ? COM_COL.vent : COM_COL.unit, strokeWeight: 1.5, fillOpacity: 0.15, fillColor: COM_COL.unit, clickable: false }));
    }
  }

  private drawMarker(loc: LatLng | null) {
    if (!loc) { this.marker?.setMap(null); return; }
    if (!this.marker) {
      this.marker = new google.maps.Marker({ map: this.map, position: loc, draggable: true, zIndex: 900, title: 'Locked house - drag to move' });
      this.marker.addListener('dragend', (e: google.maps.MapMouseEvent) => { if (e.latLng) this.handlers.onLockHouse(lit(e.latLng), true); });
    } else {
      this.marker.setPosition(loc);
      if (!this.marker.getMap()) this.marker.setMap(this.map);
    }
  }
}
