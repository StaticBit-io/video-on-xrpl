# Video, streamed out of the XRP Ledger

Ten seconds of H.264 live inside the memo fields of 692 XRPL transactions. This page pulls them
back fragment by fragment and feeds them to the browser's decoder **while the clip plays** — not
a download that finishes and then starts, but a stream whose source happens to be a blockchain.

**No video is stored in this repository.** `data/` holds byte ranges, transaction hashes and
checksums. Every frame you see arrived as transaction memos.

## The numbers

| | |
|---|---|
| Clip | Big Buck Bunny, 640×360, 10 s, `avc1.4D401F` (no audio track in the source) |
| Payload | 704,445 bytes → 692 transactions of 1,019 bytes |
| Written in | **47 seconds**, across **5 ledgers**, 0 failures |
| Fees | 0.008352 XRP |
| Network | XRPL Testnet |
| Playback needs | 69.2 transactions per second, sustained |
| Measured read rate | 85–208 tx/s per fragment, ~110 tx/s overall |

The clip plays because reading beats watching: pulling 69 transactions per second of video costs
less than the ledger will give you.

## What tickets changed

The first version of this experiment — [a novel in the ledger](https://github.com/StaticBit-io/war-and-peace-on-xrpl) —
wrote transactions one at a time, awaiting each. That capped the upload at **3.6 tx/s**, because
every transaction paid a full network round trip.

Submitting sequence-numbered transactions in parallel is faster but lossy: they arrive out of
order, and any transaction whose predecessor has not landed is rejected with `terPRE_SEQ`.
Measured on testnet, 200 transactions in flight lost 17 of them — and a lost chunk is a hole in
the video.

Tickets ([XLS-16](https://github.com/XRPLF/XRPL-Standards/discussions/16)) remove the ordering
constraint: each transaction carries a `TicketSequence` instead of a sequence number and stands
on its own. Order is still recoverable, because tickets are handed out consecutively — chunk *i*
rides ticket *first + i* exactly as it used to ride *sequence + i*.

| strategy | 200 transactions | rate | lost |
|---|---|---|---|
| sequence, serial | 74.3 s | 2.7 tx/s | 0 |
| sequence, parallel | 2.02 s | 90.7 tx/s | **17** |
| **tickets, parallel** | **2.01 s** | **99.7 tx/s** | **0** |

An account may hold 250 live tickets and mint at most 250 per `TicketCreate`
(`kMaxValidCount`, `kMaxTicketThreshold`), and each one holds 0.2 XRP of reserve until spent.
So a long upload is a pipeline: mint a batch, spend it, mint the next. That pushed this clip in
at 47 seconds for 692 transactions, against roughly 3 minutes and 20 seconds the old way.

## Live streaming is still out of reach — almost

Peak submission was ~118 tx/s, about 960 kbps. A 360p encode needs 69 tx/s, so **writing runs
faster than real time**. The wall is elsewhere: with only 250 tickets at a time, sustaining the
stream means minting continuously, and a `TicketCreate` needs a ledger to validate. That caps
sustained throughput near 20 tx/s — enough to broadcast 144p into the ledger as it happens,
not enough for 360p.

## How a fragment is rebuilt

1. `data/segments.json` gives the fragment's byte range — never its bytes.
2. The range maps to a run of chunks: `floor(start / 1019)` … `floor((end - 1) / 1019)`.
3. `data/tx-hashes.json` turns those indices into transaction hashes.
4. The browser fetches them from a public node with `tx`, in parallel.
5. Payloads are concatenated, trimmed, and checked against SHA-256.
6. The fragment goes into a `SourceBuffer` and the decoder plays it.

Fragments must reach the decoder in order, so the loop is sequential — but it stays only a few
seconds ahead of the playhead rather than downloading everything, which is what makes this a
stream rather than a slow download.

## Pause, seek, replay

The clip behaves like a normal video, which took three things beyond simply appending bytes.

The duration is declared to MediaSource **before the first fragment arrives**, taken from the
index. Without that, `seekable` is only what has been buffered so far, and a jump past the loaded
part silently snaps back to the end of the buffer instead of loading what was asked for.

The SourceBuffer runs in `segments` mode rather than `sequence`, so fragments carry their own
timestamps and may be appended out of order — which is exactly what a seek produces.

The fetch loop picks the next fragment from **where the playhead is**, not from file order
(`js/schedule.mjs`). Seek to 0:08 with only the first seconds loaded and the loop fetches the
fragment covering 0:08 next, then continues forward, and only afterwards goes back to fill the
skipped stretch. Once everything is buffered, replaying and scrubbing touch the network not at
all — the ledger has already handed over every byte.

## Running locally

```bash
npx serve -l 4174 .
```

Then open <http://localhost:4174> and press **Stream from the ledger**.

## Tests

```bash
npm test
```

Two things are tested because a silent bug there produces plausible-but-broken output: the byte
arithmetic that maps ranges to chunks, and the MP4 box parser that decides where a fragment
begins and ends. Splitting a fragmented MP4 anywhere except a `moof` boundary yields a
`SourceBuffer` error with no useful message, so the boundaries come from the boxes themselves.

## Preparing another clip

```bash
# 1. encode to fragmented MP4 (one-second fragments, keyframe at each boundary)
docker run --rm -v "$PWD:/w" -w /w jrottenberg/ffmpeg:6-alpine \
  -i input.mp4 -t 10 -vf scale=-2:360 -c:v libx264 -profile:v main -b:v 550k \
  -g 30 -keyint_min 30 -sc_threshold 0 \
  -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000 out.mp4

# 2. turn it into the exact byte stream that will live in the ledger
node tools/prepare-payload.mjs out.mp4 .

# 3. upload video-payload.bin with the ticketed uploader, then
node tools/build-video-index.mjs payload-map.json path/to/run-dataset.json data
```

The uploader lives in the [war-and-peace project](https://github.com/StaticBit-io/war-and-peace-on-xrpl/tree/main/tools/uploader);
run it with `--tickets`.

## Limits worth knowing

- **iOS Safari before 17 has no MediaSource at all**, and 17+ exposes it only as
  `ManagedMediaSource`. The page checks support up front and says so rather than failing midway.
- **A test network gets reset.** When that happens these transactions vanish and the player will
  report it instead of showing a broken frame.
- **This is video-on-demand**, not broadcast — see the section above.

## Credits

*Big Buck Bunny* © Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/),
re-encoded to 360p. Site code: MIT.
