import assert from 'node:assert/strict';
import test from 'node:test';

import { fragmentAt, nextFragment } from '../js/schedule.mjs';

test('starts at the beginning when nothing is loaded', () => {
  assert.equal(nextFragment(new Set(), 10, 0), 0);
});

test('walks forward from the playhead', () => {
  assert.equal(nextFragment(new Set([0, 1, 2]), 10, 2), 3);
});

test('a seek forward fetches what covers the playhead, not the next unread fragment', () => {
  // The viewer jumped to fragment 8 with only 0-2 loaded: 8 is what they are waiting on.
  assert.equal(nextFragment(new Set([0, 1, 2]), 10, 8), 8);
});

test('fills the skipped gap only once the tail is covered', () => {
  const loaded = new Set([0, 1, 2, 8, 9]);
  assert.equal(nextFragment(loaded, 10, 8), 3);
});

test('returns null when every fragment is loaded', () => {
  assert.equal(nextFragment(new Set([0, 1, 2]), 3, 1), null);
});

test('clamps a playhead past the end instead of running off the array', () => {
  assert.equal(nextFragment(new Set([0]), 3, 99), 2);
  assert.equal(nextFragment(new Set([2]), 3, -5), 0);
});

test('rejects a nonsensical fragment count rather than looping forever', () => {
  assert.throws(() => nextFragment(new Set(), 0, 0), RangeError);
});

test('maps playback time onto a fragment', () => {
  assert.equal(fragmentAt(0, 1, 10), 0);
  assert.equal(fragmentAt(0.99, 1, 10), 0);
  assert.equal(fragmentAt(1, 1, 10), 1);
  assert.equal(fragmentAt(8.5, 1, 10), 8);
});

test('a time past the end maps to the last fragment', () => {
  assert.equal(fragmentAt(999, 1, 10), 9);
  assert.equal(fragmentAt(-3, 1, 10), 0);
});

test('handles fragments that are not one second long', () => {
  assert.equal(fragmentAt(5, 2, 10), 2);
  assert.throws(() => fragmentAt(5, 0, 10), RangeError);
});
