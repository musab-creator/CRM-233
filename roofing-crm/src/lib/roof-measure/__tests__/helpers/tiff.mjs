// Minimal GeoTIFF writer (uncompressed, one strip) for synthetic Solar API data layers:
// UTM (EPSG:326xx) georeferencing with ModelTiepoint / ModelPixelScale, like Google's mask and DSM files.
export function writeGeoTiff({ width, height, data, float, originE, originN, px, epsg }) {
  const bps = float ? 32 : 8;
  const bytes = width * height * (bps / 8);
  const tags = [];
  const add = (tag, type, values) => tags.push({ tag, type, values: Array.isArray(values) ? values : [values] });
  add(256, 4, width); add(257, 4, height); add(258, 3, bps); add(259, 3, 1); add(262, 3, 1);
  add(273, 4, 0); add(277, 3, 1); add(278, 4, height); add(279, 4, bytes); add(284, 3, 1); add(339, 3, float ? 3 : 1);
  add(33550, 12, [px, px, 0]);
  add(33922, 12, [0, 0, 0, originE, originN, 0]);
  add(34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg]);
  tags.sort((a, b) => a.tag - b.tag);
  const size = { 3: 2, 4: 4, 12: 8 };
  const ifdOffset = 8, ifdSize = 2 + tags.length * 12 + 4;
  let extra = ifdOffset + ifdSize;
  for (const t of tags) { const n = t.values.length * size[t.type]; if (n > 4) { t.offset = extra; extra += n + (n % 2); } }
  const dataOffset = extra;
  tags.find((t) => t.tag === 273).values = [dataOffset];
  const buf = new ArrayBuffer(dataOffset + bytes); const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, ifdOffset, true);
  dv.setUint16(ifdOffset, tags.length, true);
  const put = (off, type, v) => { if (type === 3) dv.setUint16(off, v, true); else if (type === 4) dv.setUint32(off, v, true); else dv.setFloat64(off, v, true); };
  tags.forEach((t, i) => {
    const e = ifdOffset + 2 + i * 12;
    dv.setUint16(e, t.tag, true); dv.setUint16(e + 2, t.type, true); dv.setUint32(e + 4, t.values.length, true);
    if (t.offset != null) { dv.setUint32(e + 8, t.offset, true); t.values.forEach((v, k) => put(t.offset + k * size[t.type], t.type, v)); }
    else t.values.forEach((v, k) => put(e + 8 + k * size[t.type], t.type, v));
  });
  dv.setUint32(ifdOffset + 2 + tags.length * 12, 0, true);
  for (let i = 0; i < width * height; i++) { if (float) dv.setFloat32(dataOffset + i * 4, data[i], true); else dv.setUint8(dataOffset + i, data[i]); }
  return Buffer.from(buf);
}
