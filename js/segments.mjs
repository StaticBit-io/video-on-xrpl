/**
 * Rebuilds one playable piece — the init segment or a media fragment — out of the
 * transactions that carry it, and refuses to hand back anything that fails its checksum.
 */
import { assembleRange } from './offsets.mjs';

/** SHA-256 as uppercase hex, to compare against the digests in the index. */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * @param {object} piece entry from segments.json (init or a segment)
 * @param {import('./chunks.mjs').ChunkStore} store batched reader over the clip's transactions
 * @param {number} chunkSize payload bytes per transaction
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{bytes: Uint8Array, sources: object[], verified: boolean, digest: string, seconds: number}>}
 */
export async function fetchPiece(piece, store, chunkSize, onProgress) {
  const startedAt = performance.now();
  await store.ensure(piece.lastChunk, onProgress);
  const seconds = (performance.now() - startedAt) / 1000;

  const chunks = store.slice(piece.firstChunk, piece.lastChunk);
  const bytes = assembleRange(chunks, piece.byteStart, piece.byteEnd, chunkSize);
  const digest = await sha256Hex(bytes);

  // A damaged fragment would surface as a decoder error much later, where it looks like a
  // player bug rather than bad data. Catch it here, where the cause is still obvious.
  if (digest !== piece.sha256) {
    throw new Error(`checksum mismatch on bytes ${piece.byteStart}..${piece.byteEnd}: the ledger returned different data than the index expects`);
  }

  const transactions = piece.lastChunk - piece.firstChunk + 1;
  return {
    bytes,
    digest,
    verified: true,
    seconds,
    transactions,
    txPerSecond: transactions / Math.max(seconds, 0.001),
    sources: store.sources(piece.firstChunk, piece.lastChunk),
  };
}
