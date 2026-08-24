import assert from 'node:assert/strict';
import test from 'node:test';

import { splitFragmented, topLevelBoxes } from '../tools/mp4.mjs';

/** Builds a box: [4-byte size][4-byte type][payload]. */
function box(type, payloadLength = 0) {
  const buf = Buffer.alloc(8 + payloadLength);
  buf.writeUInt32BE(8 + payloadLength, 0);
  buf.write(type, 4, 'latin1');
  return buf;
}

test('reads a flat list of boxes', () => {
  const file = Buffer.concat([box('ftyp', 16), box('moov', 32)]);
  assert.deepEqual(topLevelBoxes(file).map((b) => b.type), ['ftyp', 'moov']);
});

test('handles the 64-bit size form', () => {
  const large = Buffer.alloc(24);
  large.writeUInt32BE(1, 0);            // size == 1 means "read the 64-bit size"
  large.write('mdat', 4, 'latin1');
  large.writeUInt32BE(0, 8);            // high word
  large.writeUInt32BE(24, 12);          // low word
  const boxes = topLevelBoxes(large);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].end, 24);
});

test('rejects a box that claims more bytes than the file holds', () => {
  const bad = Buffer.alloc(12);
  bad.writeUInt32BE(999, 0);
  bad.write('moov', 4, 'latin1');
  assert.throws(() => topLevelBoxes(bad), /malformed box/);
});

test('splits init from fragments', () => {
  const file = Buffer.concat([
    box('ftyp', 8), box('moov', 40),
    box('moof', 24), box('mdat', 100),
    box('moof', 24), box('mdat', 120),
  ]);

  const { init, fragments } = splitFragmented(file);

  assert.equal(init.start, 0);
  assert.equal(init.end, 16 + 48);                 // ftyp + moov
  assert.equal(fragments.length, 2);
  assert.equal(fragments[0].start, init.end);      // fragment 0 begins where init ends
  assert.equal(fragments[0].end, fragments[1].start);
  assert.equal(fragments.at(-1).end, file.length);
});

test('a fragment is moof plus its mdat, never a bare moof', () => {
  const file = Buffer.concat([box('ftyp', 8), box('moov', 8), box('moof', 8), box('moof', 8)]);
  assert.throws(() => splitFragmented(file), /not followed by mdat/);
});

test('ignores a trailing index box rather than treating it as media', () => {
  const file = Buffer.concat([
    box('ftyp', 8), box('moov', 8),
    box('moof', 8), box('mdat', 40),
    box('mfra', 24),                                  // tail index — playback never needs it
  ]);

  const { fragments } = splitFragmented(file);

  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].end, file.length - 32);   // stops before mfra
});

test('refuses a plain, unfragmented MP4', () => {
  const file = Buffer.concat([box('ftyp', 8), box('moov', 8), box('mdat', 64)]);
  assert.throws(() => splitFragmented(file), /not fragmented/);
});
