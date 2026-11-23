// Minimal grayscale PNG encoder for Workers (uses the built-in CompressionStream).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlibDeflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Render a QR module matrix to a PNG.
 * @param {number} count  modules per side
 * @param {(r:number,c:number)=>boolean} isDark
 * @param {{minSize?:number, border?:number}} opts
 */
export async function qrToPng(count, isDark, { minSize = 1200, border = 4 } = {}) {
  const total = count + border * 2;
  const scale = Math.ceil(minSize / total);
  const size = total * scale;
  const rowLen = size + 1; // 1 filter byte per row
  const raw = new Uint8Array(rowLen * size).fill(255);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter: none
    const r = Math.floor(y / scale) - border;
    if (r < 0 || r >= count) continue;
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - border;
      if (c >= 0 && c < count && isDark(r, c)) raw[y * rowLen + 1 + x] = 0;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlibDeflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return { png: out, size };
}
