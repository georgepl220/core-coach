'use strict';

// Draw the same geometric diamond and arrow as the interface. No external
// images or imaging dependency are needed; the generated assets are reproducible.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assets = path.join(__dirname, '..', 'data', 'assets');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect x="4" y="4" width="248" height="248" rx="44" fill="#0b0d18"/><path d="M128 24 232 128 128 232 24 128Z" fill="none" stroke="#858ae3" stroke-width="12"/><path d="m88 168 80-80m-64 0h64v64" fill="none" stroke="#9ae2cf" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/></svg>\n';
const segments = {
  orbit: [[128, 24, 232, 128], [232, 128, 128, 232], [128, 232, 24, 128], [24, 128, 128, 24]],
  core: [[88, 168, 168, 88], [104, 88, 168, 88], [168, 88, 168, 152]],
};
function distance(x, y, line) {
  const [x1, y1, x2, y2] = line, dx = x2 - x1, dy = y2 - y1;
  const along = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - x1 - along * dx, y - y1 - along * dy);
}
function sample(x, y) {
  const cornerX = Math.max(48 - x, 0, x - 208), cornerY = Math.max(48 - y, 0, y - 208);
  if (x < 4 || y < 4 || x > 252 || y > 252 || Math.hypot(cornerX, cornerY) > 44) return [0, 0, 0, 0];
  if (segments.core.some(line => distance(x, y, line) <= 8)) return [154, 226, 207, 255];
  if (segments.orbit.some(line => distance(x, y, line) <= 6)) return [133, 138, 227, 255];
  return [11, 13, 24, 255];
}
function raster(size) {
  const rgba = Buffer.alloc(size * size * 4), scale = 256 / size, samples = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const color = sample((x + (sx + .5) / samples) * scale, (y + (sy + .5) / samples) * scale);
      for (let channel = 0; channel < 4; channel++) sum[channel] += color[channel];
    }
    const offset = (y * size + x) * 4, count = samples * samples;
    const alpha = sum[3] / count;
    for (let channel = 0; channel < 3; channel++) rgba[offset + channel] = alpha ? Math.round(sum[channel] * 255 / sum[3]) : 0;
    rgba[offset + 3] = Math.round(alpha);
  }
  return rgba;
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function dib(size, rgba) {
  const header = Buffer.alloc(40), xor = Buffer.alloc(size * size * 4), maskStride = Math.ceil(size / 32) * 4, mask = Buffer.alloc(maskStride * size);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8); header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14); header.writeUInt32LE(xor.length + mask.length, 20);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const source = (y * size + x) * 4, target = ((size - y - 1) * size + x) * 4;
    xor[target] = rgba[source + 2]; xor[target + 1] = rgba[source + 1]; xor[target + 2] = rgba[source]; xor[target + 3] = rgba[source + 3];
    if (!rgba[source + 3]) mask[(size - y - 1) * maskStride + Math.floor(x / 8)] |= 0x80 >> (x % 8);
  }
  return Buffer.concat([header, xor, mask]);
}
function generate() {
  fs.mkdirSync(assets, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256], images = sizes.map(size => {
    const rgba = raster(size);
    return size === 256 ? png(size, rgba) : dib(size, rgba);
  });
  const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16; header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6); header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += images[index].length;
  });
  fs.writeFileSync(path.join(assets, 'core-coach.svg'), SVG);
  fs.writeFileSync(path.join(assets, 'core-coach.png'), images.at(-1));
  fs.writeFileSync(path.join(assets, 'core-coach.ico'), Buffer.concat([header, ...images]));
  console.log('Core Coach icon generated: 16–256 px ICO, PNG and SVG.');
}
module.exports = { generate };
if (require.main === module) generate();
