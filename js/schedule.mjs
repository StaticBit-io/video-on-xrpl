/**
 * Decides which fragment to fetch next.
 *
 * Order matters more than it looks. Fetching strictly front-to-back is fine until the viewer
 * seeks: then they are staring at a spinner while the loop dutifully fills in a stretch they
 * have already skipped past. So the playhead wins — fetch what covers it, then what follows,
 * and only afterwards go back and fill the gaps left behind.
 */

/**
 * @param {Set<number>} loaded indices already in the buffer
 * @param {number} total number of fragments
 * @param {number} currentIndex fragment under the playhead
 * @returns {number|null} index to fetch next, or null when everything is loaded
 */
export function nextFragment(loaded, total, currentIndex) {
  if (!Number.isInteger(total) || total <= 0) throw new RangeError(`total must be a positive integer, got ${total}`);

  const from = Math.min(total - 1, Math.max(0, currentIndex || 0));

  for (let i = from; i < total; i++) if (!loaded.has(i)) return i;
  for (let i = 0; i < from; i++) if (!loaded.has(i)) return i;
  return null;
}

/**
 * Which fragment covers a moment in the timeline?
 * @param {number} seconds playhead position
 * @param {number} fragmentSeconds duration of one fragment
 * @param {number} total number of fragments
 */
export function fragmentAt(seconds, fragmentSeconds, total) {
  if (!(fragmentSeconds > 0)) throw new RangeError(`fragmentSeconds must be positive, got ${fragmentSeconds}`);
  const index = Math.floor((seconds || 0) / fragmentSeconds);
  return Math.min(total - 1, Math.max(0, index));
}
