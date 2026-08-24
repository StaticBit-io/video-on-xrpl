/**
 * Merges the payload map (where each fragment sits in the byte stream) with the upload
 * dataset (which transaction carries which chunk) into the index the player reads.
 *
 * The video itself is never copied here: data/ holds byte ranges, transaction hashes and
 * checksums, and nothing else.
 *
 * Usage:
 *   node tools/build-video-index.mjs <payload-map.json> <run-dataset.json> [outDir]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chunkRangeFor } from '../js/offsets.mjs';

const [, , mapPath, datasetPath, outDir = 'data', ...rest] = process.argv;
if (!mapPath || !datasetPath) {
  console.error('usage: node tools/build-video-index.mjs <payload-map.json> <run-dataset.json> [outDir] [--title T] [--credit C]');
  process.exit(1);
}

/** Title and credit describe the clip, not the pipeline, so they come from the command line. */
const flag = (name, fallback) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 && rest[at + 1] ? rest[at + 1] : fallback;
};

const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const run = JSON.parse(readFileSync(datasetPath, 'utf8'));

if (map.payloadBytes !== run.SourceBytes) {
  throw new Error(`payload map says ${map.payloadBytes} B but the run uploaded ${run.SourceBytes} B — they describe different files`);
}
if (map.chunkSize !== run.ChunkSize) {
  throw new Error(`chunk size mismatch: map ${map.chunkSize}, run ${run.ChunkSize}`);
}

const hashes = run.Transactions
  .slice()
  .sort((a, b) => a.Sequence - b.Sequence)   // ticket numbers are handed out in order
  .map((t) => t.Hash);

if (hashes.length !== run.ChunksApplied) {
  throw new Error(`hash count ${hashes.length} does not match ChunksApplied ${run.ChunksApplied}`);
}

/** Re-derives the chunk range so the index cannot disagree with the arithmetic the player uses. */
function withRange(piece) {
  const { firstChunk, lastChunk } = chunkRangeFor(piece.byteStart, piece.byteEnd, map.chunkSize);
  if (firstChunk !== piece.firstChunk || lastChunk !== piece.lastChunk) {
    throw new Error(`chunk range drift on bytes ${piece.byteStart}..${piece.byteEnd}`);
  }
  if (lastChunk >= hashes.length) {
    throw new Error(`piece needs chunk ${lastChunk} but only ${hashes.length} were uploaded`);
  }
  return { ...piece, transactions: lastChunk - firstChunk + 1 };
}

const ENDPOINTS = {
  testnet: ['wss://s.altnet.rippletest.net:51233', 'wss://testnet.xrpl-labs.com'],
  mainnet: ['wss://xrplcluster.com', 'wss://s2.ripple.com', 'wss://s1.ripple.com'],
};
const networkKey = run.Network.toLowerCase().includes('test') ? 'testnet' : 'mainnet';

const rawSegments = map.segments.map(withRange);
const durationSeconds = map.durationSeconds || rawSegments.length;   // fragments are ~1 s each

// Fragments were encoded at a fixed duration, so playback time maps to an index by division.
// Seeking needs this: it has to know which fragment covers the moment the viewer jumped to.
const segmentSeconds = durationSeconds / rawSegments.length;
const segments = rawSegments.map((s) => ({
  ...s,
  startSeconds: Math.round(s.index * segmentSeconds * 1000) / 1000,
  durationSeconds: Math.round(segmentSeconds * 1000) / 1000,
}));

const manifest = {
  network: run.Network,
  networkKey,
  endpoints: ENDPOINTS[networkKey],
  explorer: run.Explorer,
  account: run.Account,
  accountUrl: run.AccountUrl,
  video: {
    title: flag('title', 'Untitled clip'),
    credit: flag('credit', ''),
    mimeCodec: map.mimeCodec,
    hasAudio: map.hasAudio,
    width: map.width || 854,
    height: map.height || 480,
    durationSeconds,
    bytes: map.payloadBytes,
    sha256: map.payloadSha256,
    segments: segments.length,
  },
  ledger: {
    chunkSize: map.chunkSize,
    transactions: run.ChunksApplied,
    startSequence: run.StartSequence,
    firstLedger: run.FirstLedger,
    lastLedger: run.LastLedger,
    ledgersUsed: run.LedgersUsed,
    ticketed: run.Ticketed === true,   // how this copy was written, not how it could be
    submitMinutes: run.SubmitMinutes,
    feeDropsPerTx: run.FeeAvgDrops,
    feeBurnedXrp: run.FeeBurnedXrp,
    readBackSeconds: run.ReadBackSeconds,
    // What the player has to keep up with, and what the ledger can actually deliver.
    requiredTxPerSecond: Math.round((run.ChunksApplied / durationSeconds) * 10) / 10,
  },
  verification: {
    rebuiltBytes: run.RebuiltBytes,
    byteForByteMatch: run.ByteForByteMatch,
  },
};

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(outDir, 'segments.json'), JSON.stringify({ init: withRange(map.init), segments }));
writeFileSync(join(outDir, 'tx-hashes.json'), JSON.stringify(hashes));

console.log(`network   : ${manifest.network}, account ${manifest.account}`);
console.log(`video     : ${manifest.video.mimeCodec}, ${durationSeconds}s, ${segments.length} segments`);
console.log(`init      : ${manifest.video.bytes.toLocaleString('en-US')} B payload, init is ${map.init.byteLength} B (${withRange(map.init).transactions} tx)`);
console.log(`segments  : ${Math.min(...segments.map((s) => s.transactions))}–${Math.max(...segments.map((s) => s.transactions))} transactions each`);
console.log(`playback  : needs ${manifest.ledger.requiredTxPerSecond} tx/s sustained; the upload read back at ` +
            `${Math.round(run.ChunksApplied / run.ReadBackSeconds)} tx/s`);
console.log(`hashes    : ${hashes.length}`);
