// Run with: node generate-icons.js
// Generates icons/icon16.png, icon32.png, icon48.png, icon128.png
// No npm dependencies required.

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

// CRC32 for PNG chunks
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function createPNG(width, height, pixelFn) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rowBytes = width * 4;
  const raw = Buffer.allocUnsafe((rowBytes + 1) * height);

  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const off = y * (rowBytes + 1) + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// Pixel-art glyphs (5 wide x 7 tall)
const GLYPHS = {
  P: [
    [1,1,1,1,0],
    [1,0,0,1,0],
    [1,0,0,1,0],
    [1,1,1,1,0],
    [1,0,0,0,0],
    [1,0,0,0,0],
    [1,0,0,0,0],
  ],
  T: [
    [1,1,1,1,1],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
  ],
};

function buildBitmap(size) {
  const gw = 5, gh = 7, gap = 1;
  const totalW = gw * 2 + gap;
  const scale = Math.max(1, Math.min(Math.floor(size * 0.55 / totalW), Math.floor(size * 0.60 / gh)));
  const bw = totalW * scale;
  const bh = gh * scale;
  const rows = [];

  for (let y = 0; y < bh; y++) {
    const row = [];
    for (let x = 0; x < bw; x++) {
      const gx = Math.floor(x / scale);
      const gy = Math.floor(y / scale);
      if (gx < gw) {
        row.push(GLYPHS.P[gy]?.[gx] ?? 0);
      } else if (gx === gw) {
        row.push(0);
      } else {
        row.push(GLYPHS.T[gy]?.[gx - gw - gap] ?? 0);
      }
    }
    rows.push(row);
  }
  return { rows, bw, bh };
}

const BG = [22, 163, 74, 255];   // #16a34a green
const FG = [255, 255, 255, 255]; // white

function createIcon(size) {
  const { rows, bw, bh } = buildBitmap(size);
  const ox = Math.floor((size - bw) / 2);
  const oy = Math.floor((size - bh) / 2);

  return createPNG(size, size, (x, y) => {
    const lx = x - ox, ly = y - oy;
    if (lx >= 0 && lx < bw && ly >= 0 && ly < bh && rows[ly][lx]) return FG;
    return BG;
  });
}

const outDir = path.join(__dirname, "icons");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, createIcon(size));
  console.log(`Created ${file}`);
}

console.log("Done.");
