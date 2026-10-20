/* eslint-disable no-undef -- Node globals; the same escape hatch scripts/build-browser.js uses. */
/**
 * Generates the PWA's PNG icons and a store screenshot.
 *
 * Written by hand instead of pulling in an image library: the manifest needs
 * real raster PNGs at exact sizes (a 404 or an SVG with no fixed size is the
 * usual reason an "installable" PWA will not install), and adding a native
 * image dependency to ship two flat-colour squares is not a trade this
 * repository makes. The output is deterministic, so regenerating never churns
 * the diff.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');

// --- minimal PNG encoder -----------------------------------------------------

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

/** Encodes RGBA pixels (from `pixel(x, y)`) as a colour-type-6 PNG. */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter type: none
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the mark ---------------------------------------------------------------

const PURPLE = [109, 40, 217];
const WHITE = [255, 255, 255];
const INK = [13, 17, 23];
const PANEL = [21, 27, 35];

/**
 * A rounded purple tile with a white diamond.
 *
 * `maskable` disables the rounding and shrinks the mark into the 80% safe zone,
 * because a maskable icon is cropped to whatever shape the launcher uses and
 * rounding it here would compound.
 */
function iconPixel(size, maskable) {
  const centre = size / 2;
  const radius = maskable ? 0 : size * 0.18;
  const reach = size * (maskable ? 0.2 : 0.3);

  return (x, y) => {
    // Outside a rounded corner: transparent.
    if (radius > 0) {
      const dx = Math.max(radius - x, x - (size - radius), 0);
      const dy = Math.max(radius - y, y - (size - radius), 0);
      if (dx * dx + dy * dy > radius * radius) return [0, 0, 0, 0];
    }
    const diamond = Math.abs(x - centre) + Math.abs(y - centre);
    return diamond <= reach ? [...WHITE, 255] : [...PURPLE, 255];
  };
}

/** A flat wireframe screenshot: the studio's two panes and its accent bar. */
function screenshotPixel(width) {
  return (x, y) => {
    if (y < 64) return [...PURPLE, 255];
    if (x >= 40 && x < width * 0.34 && y >= 96) return [...PANEL, 255];
    if (x >= width * 0.36 && x < width - 40 && y >= 96) return [...PANEL, 255];
    return [...INK, 255];
  };
}

// --- output -----------------------------------------------------------------

mkdirSync(outDir, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, pixel: iconPixel(192, false) },
  { file: 'icon-512.png', size: 512, pixel: iconPixel(512, false) },
  { file: 'icon-maskable-512.png', size: 512, pixel: iconPixel(512, true) },
];

for (const { file, size, pixel } of targets) {
  const png = encodePng(size, size, pixel);
  writeFileSync(join(outDir, file), png);
  process.stdout.write(`wrote public/icons/${file} (${size}x${size}, ${png.length} bytes)\n`);
}

const shot = encodePng(1280, 720, screenshotPixel(1280));
writeFileSync(join(outDir, 'screenshot-wide.png'), shot);
process.stdout.write(`wrote public/icons/screenshot-wide.png (1280x720, ${shot.length} bytes)\n`);
