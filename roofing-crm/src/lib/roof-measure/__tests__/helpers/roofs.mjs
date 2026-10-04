// Randomized roofs for the measurement parity test, and a snapshot of computeTotals() that can run in the
// browser (the original tool) and in node (the port) alike.

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const PITCHES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 24];
const WASTES = [0, 5, 10, 12, 15, 18, 20];
const TYPES = ['eave', 'valley', 'hip', 'ridge', 'rake', 'wall', 'step', 'transition', 'parapet', 'unspecified'];

// One roof: { defaultPitch, waste, mat, facets: [{path, pitch, name?, flags}], edges: [{type, path, pitch}] }
export function randomRoof(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + r() * (b - a);
  const lat0 = between(30.15, 30.45), lng0 = between(-81.8, -81.4);
  const ky = 111320, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
  const toLL = ([x, y]) => ({ lat: lat0 + y / ky, lng: lng0 + x / kx });
  const pitch = () => (r() < 0.12 ? pick([2.5, 4.5, 7.5, 0.5]) : pick(PITCHES));
  const flags = () => ({ twoStory: r() < 0.2, twoLayer: r() < 0.15, ...(r() < 0.15 ? { azimuth: Math.round(between(0, 360)) } : {}) });
  const facets = [], edges = [];
  const edgePitch = () => (r() < 0.3 ? pick(PITCHES) : null);
  const addEdge = (type, pts) => edges.push({ type, path: pts.map(toLL), pitch: edgePitch() });
  const nStruct = 1 + Math.floor(r() * 3);
  let cursorX = 0;
  for (let s = 0; s < nStruct; s++) {
    const W = between(4, 20), D = between(3, 12), th = between(0, Math.PI);
    // next structure: touching (shared wall), almost touching (around the 0.75 m threshold) or detached
    const mode = s === 0 ? 'first' : pick(['touch', 'near', 'detached', 'detached']);
    const gap = mode === 'touch' ? 0 : mode === 'near' ? pick([0.5, 0.7, 0.8, 1.0]) : between(6, 30);
    const ox = s === 0 ? 0 : cursorX + gap, oy = mode === 'detached' ? between(-15, 15) : 0;
    const rot = s === 0 || mode === 'detached' ? th : 0; // touching structures stay axis-aligned so the wall is shared
    cursorX = ox + W;
    const P = (x, y) => { const c = Math.cos(rot), sn = Math.sin(rot); return [ox + x * c - y * sn, oy + x * sn + y * c]; };
    const kind = pick(['gable', 'hip', 'shed', 'flat', 'gable', 'hip']);
    const p = kind === 'flat' ? 0 : pitch();
    const A = P(0, 0), B = P(W, 0), C = P(W, D), Dd = P(0, D), M1 = P(0, D / 2), M2 = P(W, D / 2);
    if (kind === 'gable') {
      facets.push({ path: [A, B, M2, M1].map(toLL), pitch: p, flags: flags() }, { path: [M1, M2, C, Dd].map(toLL), pitch: r() < 0.8 ? p : pitch(), flags: flags() });
      addEdge('eave', [A, B]); addEdge('eave', [Dd, C]); addEdge('ridge', [M1, M2]);
      if (r() < 0.7) { addEdge('rake', [A, M1, Dd]); addEdge('rake', [B, M2]); addEdge('rake', [M2, C]); }
    } else if (kind === 'hip') {
      const inset = Math.min(D / 2, W / 2.5);
      const R1 = P(inset, D / 2), R2 = P(W - inset, D / 2);
      facets.push({ path: [A, B, R2, R1].map(toLL), pitch: p, flags: flags() }, { path: [B, C, R2].map(toLL), pitch: p, flags: flags() }, { path: [C, Dd, R1, R2].map(toLL), pitch: p, flags: flags() }, { path: [Dd, A, R1].map(toLL), pitch: r() < 0.7 ? p : pitch(), flags: flags() });
      addEdge('eave', [A, B, C, Dd, A]); addEdge('ridge', [R1, R2]);
      for (const [a, b] of [[A, R1], [B, R2], [C, R2], [Dd, R1]]) addEdge('hip', [a, b]);
    } else {
      facets.push({ path: [A, B, C, Dd].map(toLL), pitch: p, flags: flags() });
      addEdge(kind === 'flat' ? pick(['parapet', 'eave']) : 'eave', [A, B]);
      if (kind === 'shed') { addEdge('rake', [B, C]); addEdge('wall', [C, Dd]); addEdge('rake', [Dd, A]); }
    }
    // cutouts (skylight / chimney) inside the structure
    if (r() < 0.35) {
      const cx = between(1, W - 2), cy = between(0.5, D / 2 - 1.2), sz = between(0.5, 1.2);
      facets.push({ path: [P(cx, cy), P(cx + sz, cy), P(cx + sz, cy + sz), P(cx, cy + sz)].map(toLL), pitch: r() < 0.7 ? p : pitch(), flags: { excluded: true } });
    }
    if (kind !== 'flat' && r() < 0.4) addEdge(pick(['valley', 'step', 'wall', 'transition']), [P(between(0, W), D / 2), P(between(0, W), between(0, D))]);
  }
  // stray lines: every type, some multi-point, some far from any facet
  const nStray = Math.floor(r() * 4);
  for (let i = 0; i < nStray; i++) {
    const far = r() < 0.3;
    const pts = []; const n = 2 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) pts.push([between(-5, cursorX + 5) + (far ? 80 : 0), between(-5, 15)]);
    addEdge(pick(TYPES), pts);
  }
  if (r() < 0.05) facets.length = 0; // lines only
  if (r() < 0.04) { facets.length = 0; edges.length = 0; } // empty
  // the occasional named facet
  for (const f of facets) if (r() < 0.1) f.name = pick(['Garage', 'Porch', 'Main & <rear>']);
  const mat = r() < 0.3 ? { ridgeCapLF: pick([25, 33, 40]), starterLF: pick([100, 105, 120]), underlaySq: pick([4, 10]), iwLF: pick([65.6, 66.7]), dripStick: 10, valleyStick: pick([8, 10]), nailsPerSq: 320, nailsPerBox: pick([3600, 7200]) } : null;
  return { defaultPitch: pick(PITCHES), waste: pick(WASTES), mat, facets, edges };
}

// Serializable snapshot of computeTotals(): every number the tool computes, structures by facet / line index.
export function snapshotTotals(t, facets, edges) {
  const fi = (x) => facets.indexOf(x.f), ei = (x) => edges.indexOf(x.e);
  const sum = (S) => ({
    facets: S.facets.map((x) => [fi(x), x.m.plan, x.m.sloped, x.m.perimeterFt]),
    cutouts: S.cutouts.map((x) => [fi(x), x.m.plan, x.m.sloped]),
    edges: S.edges.map((x) => [ei(x), x.m.planFt, x.m.trueFt, x.m.factor, x.m.pitch]),
    plan: S.plan, sloped: S.sloped, pitched: S.pitched, flat: S.flat, twoStory: S.twoStory, twoLayer: S.twoLayer,
    byType: S.byType, pitchGroups: S.pitchGroups, pitches: S.pitches, predominant: S.predominant, predArea: S.predArea, facetCount: S.facetCount,
    weightedPitch: S.weightedPitch, squares: S.squares, squaresWaste: S.squaresWaste, index: S.index == null ? null : S.index, recWaste: S.recWaste == null ? null : S.recWaste,
  });
  return { ...sum(t), structures: t.structures.map(sum), facetsAll: t.facetsAll.map((x) => [fi(x), x.m.path.length]) };
}

// Synthetic Solar API building insights for the report cover / summary.
export function fakeSolar(seed, center) {
  const r = rng(seed);
  const segs = Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({ pitchDegrees: 10 + r() * 30, azimuthDegrees: r() * 360, stats: { areaMeters2: 20 + r() * 80, groundAreaMeters2: 18 + r() * 60 }, center: { latitude: center.lat + (r() - 0.5) * 1e-4, longitude: center.lng + (r() - 0.5) * 1e-4 }, boundingBox: { sw: { latitude: center.lat - 1e-4, longitude: center.lng - 1e-4 }, ne: { latitude: center.lat + 1e-4, longitude: center.lng + 1e-4 } }, planeHeightAtCenterMeters: 5 }));
  return {
    name: 'buildings/' + seed, center: { latitude: center.lat, longitude: center.lng }, imageryDate: { year: 2024, month: 1 + Math.floor(r() * 12), day: 1 + Math.floor(r() * 28) }, imageryQuality: 'HIGH',
    boundingBox: { sw: { latitude: center.lat - 2e-4, longitude: center.lng - 2e-4 }, ne: { latitude: center.lat + 2e-4, longitude: center.lng + 2e-4 } },
    solarPotential: { wholeRoofStats: { areaMeters2: segs.reduce((s, x) => s + x.stats.areaMeters2, 0), groundAreaMeters2: segs.reduce((s, x) => s + x.stats.groundAreaMeters2, 0) }, roofSegmentStats: segs },
  };
}
