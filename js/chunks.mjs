/**
 * Chunk store: fetches the clip's transactions in batches and hands out payloads by index.
 *
 * The first version of this player asked for one transaction per hash. That is 632 messages
 * for an eight-second clip, against a public-node budget of about 1000 messages per minute —
 * a single viewing nearly exhausted the quota and a second one hit
 * "You are placing too much load on the server".
 *
 * account_tx returns up to 400 transactions per message, so the same clip costs two messages
 * instead of 632. Streaming survives because batches are pulled on demand, not all at once:
 * the store fetches only far enough ahead to cover the fragment being played.
 */

const BATCH_SIZE = 400;   // the most a public node returns per account_tx

export class ChunkStore {
  /**
   * @param {import('./ledger.mjs').LedgerClient} client
   * @param {{account: string, firstLedger: number}} source where the clip starts in the ledger
   */
  constructor(client, source) {
    this.client = client;
    this.account = source.account;
    this.firstLedger = source.firstLedger;

    /** @type {Uint8Array[]} payloads in ledger order — index i is chunk i */
    this.chunks = [];
    /** @type {{hash: string, ledger: number}[]} */
    this.meta = [];
    this.marker = null;
    this.exhausted = false;
    this.messages = 0;      // how many requests this store has cost — shown in the UI
    this.pending = null;
  }

  get loaded() {
    return this.chunks.length;
  }

  /** Fetches batches until chunk `index` is available, or the account runs out. */
  async ensure(index, onProgress) {
    while (this.chunks.length <= index && !this.exhausted) {
      // Serialise: several fragments may await the same batch.
      this.pending = this.pending ?? this.fetchNextBatch();
      try {
        await this.pending;
      } finally {
        this.pending = null;
      }
      onProgress?.(this.chunks.length, index + 1);
    }

    if (this.chunks.length <= index) {
      throw new Error(`the ledger holds only ${this.chunks.length} chunks, but this fragment needs ${index + 1}`);
    }
  }

  async fetchNextBatch() {
    const page = await this.client.accountBatch({
      account: this.account,
      ledgerIndexMin: this.firstLedger,
      limit: BATCH_SIZE,
      marker: this.marker,
    });
    this.messages += 1;

    for (const entry of page.entries) {
      this.chunks.push(entry.bytes);
      this.meta.push({ hash: entry.hash, ledger: entry.ledger });
    }

    this.marker = page.marker ?? null;
    if (!this.marker) this.exhausted = true;
  }

  /** Payloads for chunks [from, to] inclusive — call ensure(to) first. */
  slice(from, to) {
    return this.chunks.slice(from, to + 1);
  }

  sources(from, to) {
    return this.meta.slice(from, to + 1).map((m, i) => ({ index: from + i, ...m }));
  }
}
