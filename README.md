# Video, streamed out of the XRP Ledger

Eight seconds of 480p video **with sound** live inside the memo fields of 625 transactions on
**XRPL mainnet**.
This page pulls them back fragment by fragment and feeds them to the browser's decoder **while the
clip plays** — not a download that finishes and then starts, but a stream whose source happens to
be a blockchain.

**No video is stored in this repository.** `data/` holds byte ranges, transaction hashes and
checksums. Every frame and every sample arrived as transaction memos.

## Why this is worth a look

The XRPL community is currently debating a proposal to raise the memo limit from 1 KB to about
1.3 MB, and the argument in favour is that it would finally let a transaction carry
[music or a short video clip](https://en.coin-turk.com/xrpl-faces-debate-over-proposal-to-raise-memo-field-limit-by-1200-times/).
Both sides of that debate take for granted that video is impossible at today's limit.

It is not. This clip is in the ledger right now, at the 1 KB limit, and it plays. The obstacle was
never the size of a memo — it was how fast you can write, and that turned out to be a solved
problem once transactions stopped waiting for each other.

The part of that debate nobody is measuring is price. Today a gigabyte of memo payload costs about
12.6 XRP — not because bytes are priced, but because the 1 KB cap forces a whole transaction per
kilobyte. Raise the cap to 1.3 MB and the same gigabyte costs 0.0099 XRP, a factor of ~1,275, with
no change to the fee schedule at all. The numbers are in
[cost-of-data-on-xrpl](https://github.com/StaticBit-io/cost-of-data-on-xrpl).

## The numbers

| | |
|---|---|
| Clip | *I Love AI*, 854×480, 8 s, H.264 + AAC, `avc1.4D401F,mp4a.40.2` |
| Payload | 636,375 bytes → 625 transactions of 1,019 bytes |
| Network | **XRPL Mainnet** |
| Account | [rU1A1kuVpYHk3TZYWJxVtPUc94aXyteizy](https://livenet.xrpl.org/accounts/rU1A1kuVpYHk3TZYWJxVtPUc94aXyteizy) |
| Written in | 2.8 minutes, across 44 ledgers, 0 failures |
| Fees | **0.0075 XRP** — under two cents |
| Playback needs | 69.4 transactions per second, sustained |
| Measured read rate | ~115 tx/s in the browser, 1.7× faster than playback consumes it |
| Round trip | byte-for-byte identical to the encoded file |

This copy was written with plain sequence numbers, not tickets: the account holds just over the
base reserve, and every live ticket locks 0.2 XRP. Tickets are still the right tool — the numbers
below are measured — but they need an account funded to hold them.

## What tickets changed

The first version of this experiment — [a novel in the ledger](https://github.com/StaticBit-io/war-and-peace-on-xrpl) —
wrote transactions one at a time, awaiting each. That capped the upload at **3.6 tx/s**, because
every transaction paid a full network round trip. At that rate this clip would have taken about
three minutes; a feature film would have taken a week.

Submitting sequence-numbered transactions in parallel is faster but lossy: they arrive out of
order, and any transaction whose predecessor has not landed is rejected with `terPRE_SEQ`.
Measured on testnet, 200 transactions in flight lost 17 of them — and a lost chunk is a hole in
the video.

Tickets ([XLS-16](https://github.com/XRPLF/XRPL-Standards/discussions/16)) remove the ordering
constraint: each transaction carries a `TicketSequence` instead of a sequence number and stands
on its own. Order is still recoverable, because tickets are handed out consecutively — chunk *i*
rides ticket *first + i* exactly as it used to ride *sequence + i*.

Measured on testnet, where an account could be funded well past the reserve:

| strategy | 200 transactions | rate | lost |
|---|---|---|---|
| sequence, serial | 74.3 s | 2.7 tx/s | 0 |
| sequence, parallel | 2.02 s | 90.7 tx/s | **17** |
| **tickets, parallel** | **2.01 s** | **99.7 tx/s** | **0** |

An account may hold 250 live tickets and mint at most 250 per `TicketCreate`
(`kMaxValidCount`, `kMaxTicketThreshold`), and each one holds 0.2 XRP of reserve until spent.
So a long upload is a pipeline: mint a batch, spend it, mint the next — and a batch of 200 needs
40 XRP sitting on the account while it drains. That reserve, not the protocol, is what decided
how this particular copy went up.

The same clip took 42 seconds with tickets on testnet against 2.8 minutes with sequence numbers
here: a 4× difference in wall-clock, and the difference between 5 ledgers and 44.

## Live streaming is close, but not there

Peak submission was ~118 tx/s, about 960 kbps — **writing runs faster than real time** for a 480p
encode, which needs 69. The wall is elsewhere: with only 250 tickets at a time, sustaining a
broadcast means minting continuously, and every `TicketCreate` waits for a ledger to validate.
That caps sustained throughput near 20 tx/s: enough to broadcast 144p into the ledger as it
happens, not enough for 480p. So this is video-on-demand — for now.

## How a fragment is rebuilt

1. `data/segments.json` gives the fragment's byte range — never its bytes.
2. The range maps to a run of chunks: `floor(start / 1019)` … `floor((end - 1) / 1019)`.
3. `data/tx-hashes.json` turns those indices into transaction hashes.
4. The browser fetches them from a public node with `tx`, in parallel.
5. Payloads are concatenated, trimmed, and checked against SHA-256.
6. The fragment goes into a `SourceBuffer` and the decoder plays it.

Audio and video ride together in the same fragments, so one `SourceBuffer` carries both.

## Pause, seek, replay

The clip behaves like a normal video, which took three things beyond appending bytes.

The duration is declared to MediaSource **before the first fragment arrives**, taken from the
index. Without that, `seekable` covers only what has been buffered, and a jump past the loaded
part silently snaps back instead of loading what was asked for.

The SourceBuffer runs in `segments` mode rather than `sequence`, so fragments carry their own
timestamps and may be appended out of order — which is exactly what a seek produces.

The fetch loop picks the next fragment from **where the playhead is**, not from file order
(`js/schedule.mjs`). Seek to 0:06 with only the first seconds loaded and the loop fetches the
fragment covering 0:06 next, continues forward, and only afterwards fills the skipped stretch.
Once everything is buffered, replaying and scrubbing touch the network not at all.

## Running locally

```bash
npx serve -l 4174 .
```

Then open <http://localhost:4174> and press **Stream from the ledger**.

## Tests

```bash
npm test
```

Three things are tested, because a silent bug in any of them produces plausible-but-broken
output: the byte arithmetic that maps ranges to chunks, the MP4 box parser that decides where a
fragment begins and ends, and the scheduler that decides which fragment to fetch next. Splitting
a fragmented MP4 anywhere except a `moof` boundary yields a `SourceBuffer` error with no useful
message, so the boundaries come from the boxes themselves.

## Preparing another clip

```bash
# 1. encode to fragmented MP4 (one-second fragments, keyframe at each boundary)
docker run --rm -v "$PWD:/w" -w /w jrottenberg/ffmpeg:6-alpine \
  -i input.mp4 -vf scale=-2:480 -c:v libx264 -profile:v main -b:v 600k \
  -g 24 -keyint_min 24 -sc_threshold 0 -c:a aac -b:a 96k \
  -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000 out.mp4

# 2. turn it into the exact byte stream that will live in the ledger
node tools/prepare-payload.mjs out.mp4 .

# 3. upload video-payload.bin with the ticketed uploader, then
node tools/build-video-index.mjs payload-map.json path/to/run-dataset.json data \
  --title "Your clip" --credit "You, 2026"
```

Keep an eye on the bitrate: the required read rate is `bitrate / 8 / 1019` transactions per
second, and the browser sustains somewhere around 110–200 depending on the node.

The uploader lives in the [war-and-peace project](https://github.com/StaticBit-io/war-and-peace-on-xrpl/tree/main/tools/uploader);
run it with `--tickets`.

## Limits worth knowing

- **iOS Safari before 17 has no MediaSource at all**, and 17+ exposes it only as
  `ManagedMediaSource`. The page checks support up front and says so rather than failing midway.
- **The clip is on mainnet**, so it outlives test-network resets. An earlier copy was rehearsed on
  testnet, which is where the ticket measurements come from.
- **This is video-on-demand**, not broadcast — see above.
- We have not found a public precedent for streaming video out of XRPL memos, but absence of a
  search result is not proof of a first. The numbers here are measured; that claim would not be.

## Credits

*I Love AI* — StaticBit, 2026. Site code: MIT.
