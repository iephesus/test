'use strict';
// Build a simple branded Windows icon from the Reader chat-bubble motif.
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build');
const BLUE = [0x31, 0x5d, 0xe6, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const CLEAR = [0, 0, 0, 0];

function setPixel(png, x, y, rgba) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (png.width * y + x) << 2;
  png.data[i] = rgba[0];
  png.data[i + 1] = rgba[1];
  png.data[i + 2] = rgba[2];
  png.data[i + 3] = rgba[3];
}

function fillRect(png, x0, y0, x1, y1, rgba) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPixel(png, x, y, rgba);
}

function roundRect(png, x, y, w, h, r, rgba) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const lx = px - x, ly = py - y;
      const inCorner =
        (lx < r && ly < r && (lx - r) ** 2 + (ly - r) ** 2 > r ** 2) ||
        (lx >= w - r && ly < r && (lx - (w - r - 1)) ** 2 + (ly - r) ** 2 > r ** 2) ||
        (lx < r && ly >= h - r && (lx - r) ** 2 + (ly - (h - r - 1)) ** 2 > r ** 2) ||
        (lx >= w - r && ly >= h - r && (lx - (w - r - 1)) ** 2 + (ly - (h - r - 1)) ** 2 > r ** 2);
      if (!inCorner) setPixel(png, px, py, rgba);
    }
  }
}

function drawIcon(size) {
  const png = new PNG({ width: size, height: size, filterType: -1 });
  fillRect(png, 0, 0, size, size, CLEAR);
  const pad = Math.max(1, Math.round(size * 0.12));
  const bodyH = Math.round(size * 0.55);
  const radius = Math.max(2, Math.round(size * 0.14));
  roundRect(png, pad, pad, size - pad * 2, bodyH, radius, BLUE);
  // Tail (bottom-left notch of the brand bubble).
  const tx = pad + Math.round(size * 0.08);
  const ty = pad + bodyH - Math.round(size * 0.04);
  for (let i = 0; i < Math.round(size * 0.22); i++) {
    for (let j = 0; j <= i; j++) setPixel(png, tx + j, ty + i, BLUE);
  }
  // Message lines.
  const lineY1 = pad + Math.round(bodyH * 0.38);
  const lineY2 = pad + Math.round(bodyH * 0.58);
  const lineX = pad + Math.round(size * 0.22);
  const lineW1 = Math.round(size * 0.42);
  const lineW2 = Math.round(size * 0.28);
  const thick = Math.max(1, Math.round(size * 0.05));
  fillRect(png, lineX, lineY1, lineX + lineW1, lineY1 + thick, WHITE);
  fillRect(png, lineX, lineY2, lineX + lineW2, lineY2 + thick, WHITE);
  return png;
}

function pngToIco(pngs) {
  const images = pngs.map(png => {
    const buf = PNG.sync.write(png);
    return { size: png.width, buf };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;
  const parts = [header, entries];
  images.forEach((image, i) => {
    const entry = entries.subarray(i * 16, i * 16 + 16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    parts.push(image.buf);
    offset += image.buf.length;
  });
  return Buffer.concat(parts);
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = sizes.map(drawIcon);
  fs.writeFileSync(path.join(OUT, 'icon.png'), PNG.sync.write(pngs[pngs.length - 1]));
  fs.writeFileSync(path.join(OUT, 'icon.ico'), pngToIco(pngs));
  console.log('Wrote build/icon.png and build/icon.ico');
}

if (require.main === module) main();
module.exports = { drawIcon, pngToIco, main };
