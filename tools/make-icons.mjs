/**
 * Generate the extension icons.
 *
 *   node tools/make-icons.mjs
 *
 * Run once; the PNGs are committed. This exists rather than a checked-in binary
 * blob nobody can edit: the mark is a few numbers, so it should be a few numbers
 * in source control, regenerable at any size.
 *
 * Chrome also *requires* an iconUrl for a basic notification, so the signed-out
 * notification cannot exist without these files.
 *
 * The mark is a floor-plan desk tile: a desk edge with a chair below it, which
 * is what the thing actually books, and which stays readable at 16px where a
 * letterform would not.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const ACCENT = [37, 99, 235];      // #2563eb, the popup's accent
const INK = [255, 255, 255];

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
});

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;   // bit depth
    header[9] = 6;   // colour type: RGBA
    // 10-12: compression, filter, interlace — all zero.

    // Each scanline is prefixed with its filter type; 0 means "none".
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y += 1) {
        const rowStart = y * (size * 4 + 1);
        raw[rowStart] = 0;
        rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── the mark ────────────────────────────────────────────────────────────────

function insideRoundedSquare(x, y, size, radius) {
    if (x < 0 || y < 0 || x > size || y > size) return false;
    const nearLeft = x < radius;
    const nearRight = x > size - radius;
    const nearTop = y < radius;
    const nearBottom = y > size - radius;
    if (!((nearLeft || nearRight) && (nearTop || nearBottom))) return true;

    const cornerX = nearLeft ? radius : size - radius;
    const cornerY = nearTop ? radius : size - radius;
    return (x - cornerX) ** 2 + (y - cornerY) ** 2 <= radius ** 2;
}

const insideRect = (x, y, left, top, right, bottom) =>
    x >= left && x <= right && y >= top && y <= bottom;

/**
 * 4x4 supersampling per pixel. Cheap, and without it the rounded corners and
 * the chair look ragged at 16px.
 */
function render(size) {
    const rgba = Buffer.alloc(size * size * 4);
    const radius = size * 0.22;

    const desk = [size * 0.17, size * 0.32, size * 0.83, size * 0.45];
    const chair = [size * 0.36, size * 0.53, size * 0.64, size * 0.72];

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            let background = 0;
            let ink = 0;

            for (let subY = 0; subY < 4; subY += 1) {
                for (let subX = 0; subX < 4; subX += 1) {
                    const sampleX = x + (subX + 0.5) / 4;
                    const sampleY = y + (subY + 0.5) / 4;
                    if (!insideRoundedSquare(sampleX, sampleY, size, radius)) continue;
                    background += 1;
                    if (insideRect(sampleX, sampleY, ...desk)
                        || insideRect(sampleX, sampleY, ...chair)) ink += 1;
                }
            }

            const offset = (y * size + x) * 4;
            if (background === 0) continue;

            const inkShare = ink / background;
            for (let channel = 0; channel < 3; channel += 1) {
                rgba[offset + channel] = Math.round(
                    ACCENT[channel] * (1 - inkShare) + INK[channel] * inkShare,
                );
            }
            rgba[offset + 3] = Math.round((background / 16) * 255);
        }
    }

    return rgba;
}

for (const size of [16, 32, 48, 128]) {
    const file = join(PUBLIC_DIR, `icon-${size}.png`);
    writeFileSync(file, encodePng(size, render(size)));
    console.log(`wrote ${file}`);
}
