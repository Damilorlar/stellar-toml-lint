/* eslint-disable no-undef -- Node globals; the same escape hatch scripts/build-browser.js uses. */
/**
 * Writes the action and toolbar icons at the four sizes Chrome and Firefox ask
 * for, plus the store icon.
 *
 * Hand-rolled rather than pulled from an image library for the same reason the
 * PWA does it: shipping a native dependency to draw a magnifier is not a trade
 * this repository makes. Output is deterministic, so regenerating is a no-op.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'icons');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixel) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const INDIGO = [79, 70, 229];
const WHITE = [255, 255, 255];

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** An indigo tile with a white magnifier: "look at what this site serves". */
function iconPixel(size) {
  const centre = size * 0.44;
  const radius = size * 0.25;
  const stroke = Math.max(1, size * 0.09) / 2;
  const corner = size * 0.22;

  const handleFrom = [centre + radius * 0.72, centre + radius * 0.72];
  const handleTo = [size * 0.8, size * 0.8];

  return (x, y) => {
    const dx = Math.max(corner - x, x - (size - corner), 0);
    const dy = Math.max(corner - y, y - (size - corner), 0);
    if (dx * dx + dy * dy > corner * corner) return [0, 0, 0, 0];

    const ring = Math.abs(Math.hypot(x - centre, y - centre) - radius);
    if (ring <= stroke) return [...WHITE, 255];

    const handle = distanceToSegment(x, y, handleFrom[0], handleFrom[1], handleTo[0], handleTo[1]);
    if (handle <= stroke) return [...WHITE, 255];

    return [...INDIGO, 255];
  };
}

mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, iconPixel(size));
  writeFileSync(join(outDir, `icon-${size}.png`), png);
  process.stdout.write(`wrote icons/icon-${size}.png (${png.length} bytes)\n`);
}
