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
 * @param {string[]} hashes every transaction hash, in ticket order
 * @param {import('./ledger.mjs').LedgerClient} client
 * @param {number} chunkSize payload bytes per transaction
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{bytes: Uint8Array, sources: object[], verified: boolean, digest: string, seconds: number}>}
 */
export async function fetchPiece(piece, hashes, client, chunkSize, onProgress) {
  const wanted = hashes.slice(piece.firstChunk, piece.lastChunk + 1);
  if (wanted.length !== piece.lastChunk - piece.firstChunk + 1) {
    throw new Error(`index is short: this piece needs chunks ${piece.firstChunk}..${piece.lastChunk}`);
  }

  const startedAt = performance.now();
  const chunks = await client.fetchChunks(wanted, onProgress);
  const seconds = (performance.now() - startedAt) / 1000;

  const bytes = assembleRange(chunks.map((c) => c.bytes), piece.byteStart, piece.byteEnd, chunkSize);
  const digest = await sha256Hex(bytes);

  // A damaged fragment would surface as a decoder error much later, where it looks like a
  // player bug rather than bad data. Catch it here, where the cause is still obvious.
  if (digest !== piece.sha256) {
    throw new Error(`checksum mismatch on bytes ${piece.byteStart}..${piece.byteEnd}: the ledger returned different data than the index expects`);
  }

  return {
    bytes,
    digest,
    verified: true,
    seconds,
    txPerSecond: wanted.length / Math.max(seconds, 0.001),
    sources: chunks.map((chunk, i) => ({
      index: piece.firstChunk + i,
      hash: wanted[i],
      ledger: chunk.tx.ledger_index,
      bytes: chunk.bytes.length,
    })),
  };
}
