/**
 * Turns a fragmented MP4 into the exact byte stream that will live in the ledger,
 * plus a map of where each playable piece sits inside it.
 *
 * The payload is the init segment followed by every media fragment, concatenated.
 * Anything the player does not need — the mfra index at the tail, for instance — is
 * dropped here rather than paid for in transactions.
 *
 * Usage:
 *   node tools/prepare-payload.mjs <fragmented.mp4> <out-dir>
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readDuration, splitFragmented, topLevelBoxes } from './mp4.mjs';

const CHUNK_SIZE = 1019;   // the memo ceiling, measured against rippled

const [, , inputPath, outDir = '.'] = process.argv;
if (!inputPath) {
  console.error('usage: node tools/prepare-payload.mjs <fragmented.mp4> <out-dir>');
  process.exit(1);
}

const source = readFileSync(inputPath);
const { init, fragments } = splitFragmented(source);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();

/** avc1.PPCCLL — the codec string MediaSource checks before it accepts a byte. */
function codecString(buffer) {
  const at = buffer.indexOf(Buffer.from('avcC', 'latin1'));
  if (at < 0) throw new Error('no avcC box: cannot determine the codec string');
  const profile = buffer.readUInt8(at + 5);
  const compat = buffer.readUInt8(at + 6);
  const level = buffer.readUInt8(at + 7);
  return `avc1.${[profile, compat, level].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

const hasAudio = source.indexOf(Buffer.from('mp4a', 'latin1')) >= 0;
const codecs = hasAudio ? `${codecString(source)},mp4a.40.2` : codecString(source);

// Build the payload: init first, then the fragments in order.
const pieces = [source.subarray(init.start, init.end)];
const segments = [];
let at = pieces[0].length;

for (const fragment of fragments) {
  const bytes = source.subarray(fragment.start, fragment.end);
  segments.push({
    index: fragment.index,
    byteStart: at,
    byteEnd: at + bytes.length,
    byteLength: bytes.length,
    firstChunk: Math.floor(at / CHUNK_SIZE),
    lastChunk: Math.floor((at + bytes.length - 1) / CHUNK_SIZE),
    sha256: sha256(bytes),
  });
  pieces.push(bytes);
  at += bytes.length;
}

const payload = Buffer.concat(pieces);

const map = {
  source: inputPath.split(/[\\/]/).pop(),
  mimeCodec: `video/mp4; codecs="${codecs}"`,
  hasAudio,
  durationSeconds: readDuration(source)?.durationSeconds || null,
  chunkSize: CHUNK_SIZE,
  payloadBytes: payload.length,
  payloadSha256: sha256(payload),
  chunks: Math.ceil(payload.length / CHUNK_SIZE),
  init: {
    byteStart: 0,
    byteEnd: init.end - init.start,
    byteLength: init.end - init.start,
    firstChunk: 0,
    lastChunk: Math.floor((init.end - init.start - 1) / CHUNK_SIZE),
    sha256: sha256(pieces[0]),
  },
  segments,
};

writeFileSync(join(outDir, 'video-payload.bin'), payload);
writeFileSync(join(outDir, 'payload-map.json'), JSON.stringify(map, null, 2));

const dropped = source.length - payload.length;
const boxes = topLevelBoxes(source).map((b) => b.type);

console.log(`source    : ${inputPath} (${source.length.toLocaleString('en-US')} B, boxes: ${[...new Set(boxes)].join(' ')})`);
console.log(`codec     : ${map.mimeCodec}${hasAudio ? '' : '  (video only — the source had no audio track)'}`);
console.log(`init      : ${map.init.byteLength} B → chunks ${map.init.firstChunk}..${map.init.lastChunk}`);
console.log(`segments  : ${segments.length}, median ${median(segments.map((s) => s.byteLength)).toLocaleString('en-US')} B ` +
            `(${median(segments.map((s) => s.lastChunk - s.firstChunk + 1))} transactions each)`);
console.log(`payload   : ${payload.length.toLocaleString('en-US')} B → ${map.chunks} transactions, dropped ${dropped} B of tail index`);
console.log(`estimate  : ${(map.chunks * 12 / 1e6).toFixed(6)} XRP in fees at 12 drops`);

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
