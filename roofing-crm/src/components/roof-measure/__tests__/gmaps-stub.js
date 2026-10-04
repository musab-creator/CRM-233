/* eslint-disable */
// Test-only stand-in for the Google Maps JavaScript API, injected with Playwright's addInitScript (there is no
// network to Google in the test environment). It implements what Roof Measure's map uses: Map (Web-Mercator
// view, panning, fitBounds, click / dblclick / mousemove / contextmenu events), Polygon / Polyline / Rectangle /
// Marker drawn in an SVG layer (editable shapes get draggable corner handles; corners can be pressed, right-clicked
// and dragged), OverlayView with panes and a projection, LatLng / LatLngBounds / MVCArray with events,
// google.maps.event, Geocoder (answers from window.__gmStub), ControlPosition. The spherical geometry functions are
// the engine's geo.ts, prepended by the test (window.__geo).
(() => {
  const geo = window.__geo || {};
  const stub = (window.__gmStub = window.__gmStub || {});
  stub.defaultLocation = stub.defaultLocation || { lat: 30.3, lng: -81.6 };
  stub.events = [];

  // ------------------------------------------------------------------ events
  const LS = new WeakMap();
  const listenersOf = (o, name) => { let m = LS.get(o); if (!m) { m = {}; LS.set(o, m); } return (m[name] = m[name] || []); };
  const event = {
    addListener(o, name, fn) { const arr = listenersOf(o, name); const h = { remove() { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); } }; arr.push(fn); return h; },
    removeListener(h) { if (h) h.remove(); },
    clearInstanceListeners(o) { LS.delete(o); },
    trigger(o, name, ...args) { for (const fn of [...listenersOf(o, name)]) fn(...args); },
  };
  class MVCObject {
    addListener(name, fn) { return event.addListener(this, name, fn); }
    set(k, v) { this[k] = v; }
    get(k) { return this[k]; }
  }

  // ------------------------------------------------------------------ values
  class LatLng {
    constructor(a, b) {
      if (a && typeof a === 'object') { this._lat = typeof a.lat === 'function' ? a.lat() : a.lat; this._lng = typeof a.lng === 'function' ? a.lng() : a.lng; }
      else { this._lat = a; this._lng = b; }
    }
    lat() { return this._lat; }
    lng() { return this._lng; }
    equals(o) { return !!o && this._lat === o.lat() && this._lng === o.lng(); }
    toJSON() { return { lat: this._lat, lng: this._lng }; }
    toString() { return `(${this._lat}, ${this._lng})`; }
  }
  const toLL = (p) => (p instanceof LatLng ? p : new LatLng(p));
  const lit = (p) => (typeof p.lat === 'function' ? { lat: p.lat(), lng: p.lng() } : { lat: p.lat, lng: p.lng });
  class LatLngBounds {
    constructor(sw, ne) { this.s = Infinity; this.n = -Infinity; this.w = Infinity; this.e = -Infinity; if (sw) this.extend(sw); if (ne) this.extend(ne); }
    extend(p) { const q = lit(p); this.s = Math.min(this.s, q.lat); this.n = Math.max(this.n, q.lat); this.w = Math.min(this.w, q.lng); this.e = Math.max(this.e, q.lng); return this; }
    isEmpty() { return this.s > this.n; }
    getCenter() { return new LatLng((this.s + this.n) / 2, (this.w + this.e) / 2); }
    getNorthEast() { return new LatLng(this.n, this.e); }
    getSouthWest() { return new LatLng(this.s, this.w); }
    contains(p) { const q = lit(p); return q.lat >= this.s && q.lat <= this.n && q.lng >= this.w && q.lng <= this.e; }
    union(b) { this.extend(b.getSouthWest()); this.extend(b.getNorthEast()); return this; }
  }
  class MVCArray extends MVCObject {
    constructor(a) { super(); this.a = (a || []).map(toLL); }
    getArray() { return this.a; }
    getLength() { return this.a.length; }
    getAt(i) { return this.a[i]; }
    forEach(f) { this.a.forEach(f); }
    setAt(i, v) { const old = this.a[i]; this.a[i] = toLL(v); event.trigger(this, 'set_at', i, old); }
    insertAt(i, v) { this.a.splice(i, 0, toLL(v)); event.trigger(this, 'insert_at', i); }
    removeAt(i) { const r = this.a.splice(i, 1)[0]; event.trigger(this, 'remove_at', i, r); return r; }
    push(v) { this.a.push(toLL(v)); event.trigger(this, 'insert_at', this.a.length - 1); return this.a.length; }
    pop() { return this.removeAt(this.a.length - 1); }
    clear() { while (this.a.length) this.pop(); }
  }

  // ------------------------------------------------------------------ projection (Web Mercator, 256 px tiles)
  const TILE = 256;
  const world = (ll) => { const s = Math.min(Math.max(Math.sin((ll.lat * Math.PI) / 180), -0.9999), 0.9999); return { x: TILE * (0.5 + ll.lng / 360), y: TILE * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) }; };
  const unworld = (p) => ({ lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * p.y) / TILE))) * 180) / Math.PI, lng: (p.x / TILE - 0.5) * 360 });

  // ------------------------------------------------------------------ map
  const SVGNS = 'http://www.w3.org/2000/svg';
  class Map extends MVCObject {
    constructor(el, opts = {}) {
      super();
      stub.map = this;
      this.el = el; this.opts = { ...opts }; this.center = lit(opts.center || stub.defaultLocation); this.z = opts.zoom != null ? opts.zoom : 18;
      this.shapes = new Set(); this.overlays = new Set(); this.markers = new Set();
      el.innerHTML = '';
      const root = (this.root = document.createElement('div'));
      root.className = 'gm-style';
      root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#3c4a3c;background-image:linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px);background-size:32px 32px;touch-action:none;user-select:none;';
      this.svg = document.createElementNS(SVGNS, 'svg');
      this.svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      root.appendChild(this.svg);
      const pane = (z) => { const d = document.createElement('div'); d.style.cssText = `position:absolute;left:0;top:0;width:0;height:0;z-index:${z};pointer-events:none;`; root.appendChild(d); return d; };
      this.panes = { mapPane: pane(1), overlayLayer: pane(2), markerLayer: pane(3), overlayMouseTarget: pane(4), floatPane: pane(5) };
      el.appendChild(root);
      this.wire();
      this.redraw();
    }
    getDiv() { return this.el; }
    size() { return { w: this.el.clientWidth || 800, h: this.el.clientHeight || 600 }; }
    scale() { return Math.pow(2, this.z); }
    toPixel(ll) { const c = world(this.center), p = world(lit(ll)), s = this.scale(), { w, h } = this.size(); return { x: (p.x - c.x) * s + w / 2, y: (p.y - c.y) * s + h / 2 }; }
    fromPixel(x, y) { const c = world(this.center), s = this.scale(), { w, h } = this.size(); return unworld({ x: c.x + (x - w / 2) / s, y: c.y + (y - h / 2) / s }); }
    getCenter() { return new LatLng(this.center.lat, this.center.lng); }
    setCenter(c) { this.center = lit(c); this.changed(); }
    panTo(c) { this.setCenter(c); }
    panBy(dx, dy) { const { w, h } = this.size(); this.center = this.fromPixel(w / 2 + dx, h / 2 + dy); this.changed(); }
    getZoom() { return this.z; }
    setZoom(z) { this.z = z; this.changed(); }
    getTilt() { return 0; }
    setTilt() {}
    setOptions(o) { Object.assign(this.opts, o); this.root.style.cursor = this.opts.draggableCursor || ''; }
    getBounds() { const { w, h } = this.size(); const a = this.fromPixel(0, h), b = this.fromPixel(w, 0); return new LatLngBounds(a, b); }
    fitBounds(b, padding = 0) {
      const pad = typeof padding === 'number' ? padding : 0;
      const sw = world(lit(b.getSouthWest())), ne = world(lit(b.getNorthEast())), { w, h } = this.size();
      const dx = Math.max(1e-9, Math.abs(ne.x - sw.x)), dy = Math.max(1e-9, Math.abs(ne.y - sw.y));
      this.z = Math.min(22, Math.floor(Math.log2(Math.min((w - 2 * pad) / dx, (h - 2 * pad) / dy))));
      this.center = unworld({ x: (sw.x + ne.x) / 2, y: (sw.y + ne.y) / 2 });
      this.changed();
    }
    changed() { this.redraw(); for (const o of this.overlays) o.draw && o.draw(); event.trigger(this, 'bounds_changed'); event.trigger(this, 'idle'); }
    redraw() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
    }
    paint() {
      const svg = this.svg; svg.innerHTML = '';
      const items = [...this.shapes].filter((s) => s.map === this && s.visible !== false).sort((a, b) => (a.opts.zIndex || 0) - (b.opts.zIndex || 0));
      for (const s of items) s.paint(svg, this);
      for (const m of this.markers) m.paint(svg, this);
    }

    // hit testing: topmost clickable shape under the pixel; vertex index for editable shapes
    hit(x, y) {
      const items = [...this.shapes].filter((s) => s.map === this && s.opts.clickable !== false && s.visible !== false && s.hitTest).sort((a, b) => (b.opts.zIndex || 0) - (a.opts.zIndex || 0));
      for (const s of items) { const r = s.hitTest(x, y, this); if (r) return { shape: s, vertex: r.vertex }; }
      return null;
    }
    markerAt(x, y) { for (const m of this.markers) { if (m.map !== this || !m.position) continue; const p = this.toPixel(m.position); if (Math.hypot(p.x - x, p.y - (y + 14)) < 14) return m; } return null; }

    wire() {
      const el = this.root;
      const xy = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      const ev = (e, extra) => { const p = xy(e); return { latLng: new LatLng(this.fromPixel(p.x, p.y)), domEvent: e, pixel: p, ...extra }; };
      let down = null;
      el.addEventListener('pointerdown', (e) => {
        if (e.button === 2) return;
        const p = xy(e);
        const marker = this.opts && this.markerAt(p.x, p.y);
        const h = this.hit(p.x, p.y);
        down = { p, moved: false, marker: marker && marker.draggable ? marker : null, h, center: { ...this.center }, id: e.pointerId };
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (h) event.trigger(h.shape, 'mousedown', ev(e, { vertex: h.vertex }));
        stub.events.push('pointerdown');
      });
      el.addEventListener('pointermove', (e) => {
        const p = xy(e);
        if (down) {
          if (!down.moved && Math.hypot(p.x - down.p.x, p.y - down.p.y) > 4) down.moved = true;
          if (down.moved) {
            if (down.marker) { down.marker.position = new LatLng(this.fromPixel(p.x, p.y)); this.redraw(); return; }
            if (down.h && down.h.vertex != null && down.h.shape.opts.editable) { down.h.shape.dragVertex = { i: down.h.vertex, ll: this.fromPixel(p.x, p.y) }; this.redraw(); if (down.h) event.trigger(down.h.shape, 'mousemove', ev(e, { vertex: down.h.vertex })); return; }
            if (this.opts.draggable !== false) { const s = this.scale(), c = world(down.center); this.center = unworld({ x: c.x - (p.x - down.p.x) / s, y: c.y - (p.y - down.p.y) / s }); this.changed(); return; }
          }
          if (down.h) event.trigger(down.h.shape, 'mousemove', ev(e, { vertex: down.h.vertex }));
        }
        event.trigger(this, 'mousemove', ev(e));
      });
      el.addEventListener('pointerup', (e) => {
        const d = down; down = null;
        if (!d) return;
        if (d.h) event.trigger(d.h.shape, 'mouseup', ev(e, { vertex: d.h.vertex }));
        if (d.moved) {
          if (d.marker) { event.trigger(d.marker, 'dragend', ev(e)); return; }
          if (d.h && d.h.shape.dragVertex) { const dv = d.h.shape.dragVertex; d.h.shape.dragVertex = null; d.h.shape.getPath().setAt(dv.i, new LatLng(dv.ll)); return; }
          return;
        }
        if (d.h) event.trigger(d.h.shape, 'click', ev(e, { vertex: d.h.vertex }));
        else event.trigger(this, 'click', ev(e));
      });
      el.addEventListener('dblclick', (e) => {
        const p = xy(e); const h = this.hit(p.x, p.y);
        if (h) event.trigger(h.shape, 'dblclick', ev(e, { vertex: h.vertex }));
        else event.trigger(this, 'dblclick', ev(e));
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const p = xy(e); const h = this.hit(p.x, p.y);
        if (h) { event.trigger(h.shape, 'contextmenu', ev(e, { vertex: h.vertex })); event.trigger(h.shape, 'rightclick', ev(e, { vertex: h.vertex })); }
        else { event.trigger(this, 'contextmenu', ev(e)); event.trigger(this, 'rightclick', ev(e)); }
      });
      el.addEventListener('wheel', (e) => { e.preventDefault(); this.setZoom(this.z + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    }
  }

  // ------------------------------------------------------------------ shapes
  class Shape extends MVCObject {
    constructor(o = {}) { super(); this.opts = {}; this.map = null; this.path = new MVCArray([]); this.setOptions(o); }
    setOptions(o = {}) {
      const { map, path, paths, bounds, ...rest } = o;
      Object.assign(this.opts, rest);
      if (path !== undefined || paths !== undefined) this.setPath(path !== undefined ? path : paths);
      if (bounds !== undefined) this.bounds = bounds;
      if (map !== undefined) this.setMap(map);
      else if (this.map) this.map.redraw();
    }
    setPath(p) {
      const arr = p instanceof MVCArray ? p.getArray() : (Array.isArray(p) && Array.isArray(p[0]) ? p[0] : p || []);
      this.path = new MVCArray(arr);
      const redraw = () => this.map && this.map.redraw();
      ['set_at', 'insert_at', 'remove_at'].forEach((n) => this.path.addListener(n, redraw));
      redraw();
    }
    setPaths(p) { this.setPath(p); }
    getPath() { return this.path; }
    getPaths() { return new MVCArray([this.path]); }
    setMap(m) { if (this.map && this.map !== m) { this.map.shapes.delete(this); this.map.redraw(); } this.map = m || null; if (m) { m.shapes.add(this); m.redraw(); } }
    getMap() { return this.map; }
    setEditable(v) { this.opts.editable = v; this.map && this.map.redraw(); }
    getEditable() { return !!this.opts.editable; }
    setVisible(v) { this.visible = v; this.map && this.map.redraw(); }
    pts(map) { const a = this.path.getArray().map((p) => map.toPixel(p)); if (this.dragVertex) a[this.dragVertex.i] = map.toPixel(this.dragVertex.ll); return a; }
    vertexAt(x, y, map) { if (!this.opts.editable) return null; const a = this.pts(map); for (let i = 0; i < a.length; i++) if (Math.hypot(a[i].x - x, a[i].y - y) <= 9) return i; return null; }
    strokeAttrs(el) {
      const o = this.opts;
      const dashed = o.strokeOpacity === 0 && o.icons && o.icons.length;
      el.setAttribute('stroke', dashed ? (o.icons[0].icon.strokeColor || o.strokeColor || '#000') : (o.strokeColor || '#000'));
      el.setAttribute('stroke-opacity', String(dashed ? 1 : o.strokeOpacity != null ? o.strokeOpacity : 1));
      el.setAttribute('stroke-width', String(o.strokeWeight != null ? o.strokeWeight : 3));
      if (dashed) el.setAttribute('stroke-dasharray', '6 6');
    }
    handles(svg, map) {
      if (!this.opts.editable) return;
      for (const p of this.pts(map)) { const r = document.createElementNS(SVGNS, 'rect'); r.setAttribute('x', p.x - 5); r.setAttribute('y', p.y - 5); r.setAttribute('width', 10); r.setAttribute('height', 10); r.setAttribute('fill', '#fff'); r.setAttribute('stroke', '#333'); svg.appendChild(r); }
    }
  }
  const segD = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); };
  class Polygon extends Shape {
    paint(svg, map) {
      const a = this.pts(map); if (!a.length) return;
      const el = document.createElementNS(SVGNS, 'polygon');
      el.setAttribute('points', a.map((p) => `${p.x},${p.y}`).join(' '));
      el.setAttribute('fill', this.opts.fillColor || '#000'); el.setAttribute('fill-opacity', String(this.opts.fillOpacity != null ? this.opts.fillOpacity : 0.3));
      this.strokeAttrs(el); svg.appendChild(el); this.handles(svg, map);
    }
    hitTest(x, y, map) {
      const v = this.vertexAt(x, y, map); if (v != null) return { vertex: v };
      const a = this.pts(map); let c = false;
      for (let i = 0, j = a.length - 1; i < a.length; j = i++) if ((a[i].y > y) !== (a[j].y > y) && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) c = !c;
      return c ? { vertex: undefined } : null;
    }
  }
  class Polyline extends Shape {
    paint(svg, map) {
      const a = this.pts(map); if (a.length < 2) return;
      const el = document.createElementNS(SVGNS, 'polyline');
      el.setAttribute('points', a.map((p) => `${p.x},${p.y}`).join(' ')); el.setAttribute('fill', 'none');
      this.strokeAttrs(el); svg.appendChild(el); this.handles(svg, map);
    }
    hitTest(x, y, map) {
      const v = this.vertexAt(x, y, map); if (v != null) return { vertex: v };
      const a = this.pts(map); const w = Math.max(6, (this.opts.strokeWeight || 3) / 2 + 3);
      for (let i = 1; i < a.length; i++) if (segD({ x, y }, a[i - 1], a[i]) <= w) return { vertex: undefined };
      return null;
    }
  }
  class Rectangle extends Shape {
    paint(svg, map) {
      const b = this.bounds; if (!b) return;
      const p1 = map.toPixel({ lat: b.north, lng: b.west }), p2 = map.toPixel({ lat: b.south, lng: b.east });
      const el = document.createElementNS(SVGNS, 'rect');
      el.setAttribute('x', Math.min(p1.x, p2.x)); el.setAttribute('y', Math.min(p1.y, p2.y)); el.setAttribute('width', Math.abs(p2.x - p1.x)); el.setAttribute('height', Math.abs(p2.y - p1.y));
      el.setAttribute('fill', this.opts.fillColor || 'none'); el.setAttribute('fill-opacity', String(this.opts.fillOpacity || 0));
      this.strokeAttrs(el); svg.appendChild(el);
    }
    getBounds() { const b = this.bounds; return b ? new LatLngBounds({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east }) : null; }
  }
  class Marker extends MVCObject {
    constructor(o = {}) { super(); this.map = null; this.position = o.position ? toLL(o.position) : null; this.draggable = !!o.draggable; this.title = o.title; if (o.map) this.setMap(o.map); }
    setMap(m) { if (this.map) { this.map.markers.delete(this); this.map.redraw(); } this.map = m || null; if (m) { m.markers.add(this); m.redraw(); } }
    getMap() { return this.map; }
    setPosition(p) { this.position = toLL(p); this.map && this.map.redraw(); }
    getPosition() { return this.position; }
    setDraggable(v) { this.draggable = v; }
    paint(svg, map) {
      if (!this.position) return;
      const p = map.toPixel(this.position);
      const el = document.createElementNS(SVGNS, 'path');
      el.setAttribute('d', `M ${p.x} ${p.y} l -9 -16 a 10 10 0 1 1 18 0 z`);
      el.setAttribute('fill', '#ea4335'); el.setAttribute('stroke', '#a52714'); el.setAttribute('data-marker', '1');
      svg.appendChild(el);
    }
  }

  // ------------------------------------------------------------------ overlay view
  class OverlayView extends MVCObject {
    setMap(m) {
      if (this.__map) { this.__map.overlays.delete(this); this.onRemove && this.onRemove(); }
      this.__map = m || null;
      if (m) { m.overlays.add(this); this.onAdd && this.onAdd(); this.draw && this.draw(); }
    }
    getMap() { return this.__map; }
    getPanes() { return this.__map ? this.__map.panes : null; }
    getProjection() {
      const m = this.__map; if (!m) return null;
      return {
        fromLatLngToDivPixel: (ll) => m.toPixel(ll),
        fromLatLngToContainerPixel: (ll) => m.toPixel(ll),
        fromContainerPixelToLatLng: (p) => new LatLng(m.fromPixel(p.x, p.y)),
        fromDivPixelToLatLng: (p) => new LatLng(m.fromPixel(p.x, p.y)),
      };
    }
  }

  // ------------------------------------------------------------------ geocoder
  class Geocoder {
    async geocode(req) {
      stub.geocodeCalls = (stub.geocodeCalls || 0) + 1;
      if (stub.geocode) return stub.geocode(req);
      if (req.location) {
        const l = lit(req.location);
        return { results: [{ formatted_address: stub.reverseAddress || '100 Test St, Jacksonville, FL 32207, USA', types: ['street_address'], geometry: { location_type: 'ROOFTOP', location: new LatLng(l) } }] };
      }
      const l = stub.defaultLocation;
      return { results: [{ formatted_address: stub.forwardAddress || req.address, types: ['street_address'], geometry: { location_type: 'ROOFTOP', location: new LatLng(l) } }] };
    }
  }

  const lits = (path) => (Array.isArray(path) ? path : path.getArray()).map(lit);
  window.google = {
    maps: {
      Map, LatLng, LatLngBounds, MVCArray, MVCObject, Polygon, Polyline, Rectangle, Marker, OverlayView, Geocoder, event,
      ControlPosition: { TOP_LEFT: 1, TOP_CENTER: 2, TOP_RIGHT: 3, LEFT_TOP: 5, LEFT_CENTER: 4, LEFT_BOTTOM: 6, RIGHT_TOP: 7, RIGHT_CENTER: 8, RIGHT_BOTTOM: 9, BOTTOM_LEFT: 10, BOTTOM_CENTER: 11, BOTTOM_RIGHT: 12 },
      MapTypeId: { SATELLITE: 'satellite', HYBRID: 'hybrid', ROADMAP: 'roadmap', TERRAIN: 'terrain' },
      geometry: {
        spherical: {
          computeArea: (p) => geo.computeArea(lits(p)),
          computeLength: (p) => geo.computeLength(lits(p)),
          computeDistanceBetween: (a, b) => geo.computeDistanceBetween(lit(a), lit(b)),
          computeHeading: (a, b) => geo.computeHeading(lit(a), lit(b)),
          computeOffset: (a, d, h) => new LatLng(geo.computeOffset(lit(a), d, h)),
        },
        poly: { containsLocation: (pt, poly) => geo.containsLocation(lit(pt), lits(poly.getPath())) },
      },
    },
  };
})();
