/**
 * Drives playback: keeps the decoder a few seconds ahead of the playhead by pulling
 * fragments out of the ledger, and shows the race between the two as it happens.
 */
import { LedgerClient } from './ledger.mjs';
import { fragmentAt, nextFragment } from './schedule.mjs';
import { fetchPiece } from './segments.mjs';
import { Streamer } from './streamer.mjs';

const $ = (id) => document.getElementById(id);

/** Seconds of media to keep ahead of the playhead before pausing the fetch loop. */
const TARGET_BUFFER_SECONDS = 4;

/** Never hold a fragment back longer than this, whatever the buffer says. */
const MAX_HOLD_MS = 8000;

const state = {
  manifest: null,
  segments: null,
  hashes: [],
  client: null,
  streamer: null,
  fetched: { transactions: 0, bytes: 0, seconds: 0 },
  started: false,
  loaded: new Set(),      // indices already in the SourceBuffer
  complete: false,
};

async function boot() {
  const [manifest, segments, hashes] = await Promise.all([
    fetchJson('data/manifest.json'),
    fetchJson('data/segments.json'),
    fetchJson('data/tx-hashes.json'),
  ]);
  Object.assign(state, { manifest, segments, hashes });

  renderChrome();
  renderSegments();
  renderAbout();

  $('start').addEventListener('click', start, { once: true });

  // Say up front if this browser cannot do it, rather than failing on the first append.
  const supported = 'MediaSource' in window && MediaSource.isTypeSupported(manifest.video.mimeCodec);
  $('overlay-note').textContent = supported
    ? `${manifest.video.segments} fragments · ${manifest.ledger.transactions} transactions · ${manifest.video.durationSeconds}s`
    : 'This browser has no MediaSource support, so it cannot decode a stream assembled in the page.';
  $('start').disabled = !supported;
}

async function start() {
  state.started = true;
  $('overlay').hidden = true;

  state.client = new LedgerClient(state.manifest.endpoints, renderNetStatus);
  state.streamer = new Streamer($('video'), state.manifest.video.mimeCodec, state.manifest.video.durationSeconds);
  await state.streamer.open();

  const video = $('video');
  video.addEventListener('timeupdate', renderGauges);
  video.addEventListener('progress', renderGauges);

  // A seek into an un-fetched stretch is not an error — it just tells the loop where to
  // work next. The loop re-reads the playhead on every pass, so nothing more is needed here.
  video.addEventListener('seeking', () => {
    if (!state.complete) $('net-status').textContent = `seeking to ${video.currentTime.toFixed(1)}s — fetching what covers it`;
    renderGauges();
  });

  try {
    await pump();
  } catch (error) {
    showFailure(error);
  }
}

/** The fragment to fetch next, chosen from where the viewer actually is. See schedule.mjs. */
function pickNext() {
  const { segments } = state.segments;
  const under = fragmentAt($('video').currentTime, segments[0].durationSeconds, segments.length);
  const index = nextFragment(state.loaded, segments.length, under);
  return index === null ? null : segments[index];
}

/**
 * The fetch loop. Fragments are pulled strictly in order — a decoder cannot take fragment 5
 * before fragment 4 — but the loop stays ahead of playback rather than downloading everything.
 */
async function pump() {
  const { init, segments } = state.segments;
  const video = $('video');

  await pull(init, 'init');

  while (state.loaded.size < segments.length) {
    const segment = pickNext();
    if (!segment) break;

    // Hold back while the buffer is full, so this streams rather than downloads. Two guards
    // keep that from becoming a deadlock: a paused video never drains its buffer (autoplay
    // refused, a hidden tab, or the viewer simply pressed pause), and even while playing the
    // wait is capped so a stalled decoder cannot freeze the fetch loop for good.
    const waitUntil = Date.now() + MAX_HOLD_MS;
    while (state.started
           && state.loaded.size > 1
           && !video.paused
           && state.streamer.hasTime(video.currentTime)
           && state.streamer.bufferedAhead() > TARGET_BUFFER_SECONDS
           && Date.now() < waitUntil) {
      await sleep(120);
    }

    markSegment(segment.index, 'fetching');
    await pull(segment, `fragment ${segment.index}`);
    state.loaded.add(segment.index);
    markSegment(segment.index, 'done');

    // Only autoplay the very first time; after that the viewer owns the play state.
    if (video.paused && video.readyState >= 2 && state.loaded.size <= 2 && video.currentTime === 0) {
      video.play().catch(() => { /* autoplay policy: the controls are there */ });
    }
    renderGauges();
  }

  await state.streamer.end();
  state.complete = true;
  renderGauges();

  $('net-status').textContent = 'whole clip buffered — replay and seek work offline now';
  $('race-note').textContent =
    'Every fragment came out of the ledger. The clip is now fully buffered, so replaying or ' +
    'scrubbing costs nothing more.';
}

async function pull(piece, label) {
  renderNetStatus({ endpoint: state.client.endpoint, status: 'connected' });
  $('net-status').textContent = `fetching ${label} — ${piece.transactions} transactions`;

  const result = await fetchPiece(piece, state.hashes, state.client, state.manifest.ledger.chunkSize);
  await state.streamer.append(result.bytes);

  state.fetched.transactions += result.sources.length;
  state.fetched.bytes += result.bytes.length;
  state.fetched.seconds += result.seconds;

  if (piece.index !== undefined) {
    const row = document.querySelector(`[data-segment="${piece.index}"] .segment-rate`);
    if (row) row.textContent = `${result.txPerSecond.toFixed(0)} tx/s`;
  }
  renderGauges();
  return result;
}

// ─────────────────────────── rendering ───────────────────────────

function renderGauges() {
  const ahead = state.streamer?.bufferedAhead() ?? 0;
  $('g-buffer').textContent = `${ahead.toFixed(1)}s`;
  $('g-tx').textContent = state.fetched.transactions.toLocaleString('en-US');
  $('g-bytes').textContent = `${(state.fetched.bytes / 1024).toFixed(0)} KB`;

  const rate = state.fetched.seconds > 0 ? state.fetched.transactions / state.fetched.seconds : 0;
  $('g-rate').textContent = rate ? `${rate.toFixed(0)} tx/s` : '—';

  const needed = state.manifest.ledger.requiredTxPerSecond;
  const race = $('race');
  if (rate > 0) {
    race.hidden = false;
    const ratio = Math.min(rate / needed, 4);
    $('race-fill').style.width = `${(ratio / 4) * 100}%`;
    $('race-fill').className = rate >= needed ? 'is-ahead' : 'is-behind';
    $('race-note').textContent = rate >= needed
      ? `Reading ${rate.toFixed(0)} tx/s against ${needed} tx/s of playback — ${(rate / needed).toFixed(1)}× faster than the video is consumed.`
      : `Reading ${rate.toFixed(0)} tx/s against ${needed} tx/s of playback — the ledger is not keeping up, so the buffer will drain.`;
  }
}

function renderSegments() {
  const { init, segments } = state.segments;
  $('segments-hint').textContent =
    `init ${init.transactions} tx · ${segments.length} fragments · ${segments.reduce((n, s) => n + s.transactions, 0)} transactions`;

  $('segment-list').innerHTML = segments.map((s) => `
    <li class="segment" data-segment="${s.index}">
      <span class="segment-index">${String(s.index).padStart(2, '0')}</span>
      <span class="segment-bar"><i></i></span>
      <span class="segment-tx">${s.transactions} tx</span>
      <span class="segment-rate"></span>
      <a class="segment-link" href="${txUrl(s.firstChunk)}" target="_blank" rel="noopener">first tx ↗</a>
    </li>`).join('');
}

function markSegment(index, state_) {
  const row = document.querySelector(`[data-segment="${index}"]`);
  if (row) row.className = `segment is-${state_}`;
}

function renderChrome() {
  $('net-account').href = state.manifest.accountUrl;
  $('net-account').textContent = state.manifest.account;
  $('net-status').textContent = 'ready';
}

function renderNetStatus({ endpoint, status }) {
  $('net-dot').className = `net-dot is-${status}`;
  if (status !== 'connected') $('net-status').textContent = `${status} — ${endpoint}`;
}

function renderAbout() {
  const { video, ledger, network, verification } = state.manifest;

  $('about-lede').textContent =
    `${video.bytes.toLocaleString('en-US')} bytes of H.264 were cut into ${ledger.transactions} pieces of ${ledger.chunkSize} bytes ` +
    `and written into transaction memos on ${network}. Playing the clip means pulling them back at ` +
    `${ledger.requiredTxPerSecond} transactions per second of video.`;

  $('chunk-size').textContent = String(ledger.chunkSize);
  $('credit').textContent = `${video.title} — ${video.credit}. ${video.hasAudio ? '' : 'This encode carries no audio track.'}`;

  $('facts').innerHTML = [
    fact('Network', network),
    fact('Account', `<a href="${state.manifest.accountUrl}" target="_blank" rel="noopener">${state.manifest.account}</a>`),
    fact('Clip', `${video.width}×${video.height}, ${video.durationSeconds}s, ${video.mimeCodec}`),
    fact('Transactions', `${ledger.transactions.toLocaleString('en-US')} — ${ledger.chunkSize} bytes of payload each`),
    fact('Ledgers used', `${ledger.ledgersUsed} — <a href="${state.manifest.explorer}/ledgers/${ledger.firstLedger}" target="_blank" rel="noopener">${ledger.firstLedger}</a> to <a href="${state.manifest.explorer}/ledgers/${ledger.lastLedger}" target="_blank" rel="noopener">${ledger.lastLedger}</a>`),
    fact('Written with', `tickets, ${ledger.submitMinutes} minutes — sequence numbers would have taken far longer and dropped transactions`),
    fact('Fees burned', `${ledger.feeBurnedXrp} XRP at ${ledger.feeDropsPerTx} drops each`),
    fact('Playback needs', `${ledger.requiredTxPerSecond} tx/s sustained`),
    fact('Round trip', verification.byteForByteMatch ? 'byte-for-byte identical to the encoded file' : 'MISMATCH'),
  ].join('');
}

const fact = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
const txUrl = (chunk) => `${state.manifest.explorer}/transactions/${state.hashes[chunk]}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showFailure(error) {
  $('overlay').hidden = false;
  $('start').hidden = true;
  $('overlay-note').innerHTML =
    `<strong>Streaming stopped.</strong><br>${escapeHtml(error.message)}`;
  $('net-status').textContent = 'stopped';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`cannot load ${path}: HTTP ${response.status}`);
  return response.json();
}

boot().catch((error) => {
  document.body.innerHTML = `<div class="fatal"><h1>Could not start</h1><p>${escapeHtml(error.message)}</p></div>`;
});
