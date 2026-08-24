/**
 * Just enough MP4 box parsing to split a fragmented file into the pieces MediaSource wants.
 *
 * A fragmented MP4 is a header followed by a run of fragments:
 *
 *   ftyp moov | moof mdat | moof mdat | ...
 *   └ init ──┘ └ fragment ┘ └ fragment ┘
 *
 * MediaSource needs the init appended first, then whole fragments. Splitting anywhere else
 * produces a SourceBuffer error, so the byte offsets have to come from the boxes themselves
 * rather than from arithmetic on a target size.
 */

/**
 * Reads the top-level box list.
 * @param {Buffer} buffer
 * @returns {{type: string, start: number, end: number}[]}
 */
export function topLevelBoxes(buffer) {
  const boxes = [];
  let at = 0;

  while (at + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    let headerSize = 8;

    if (size === 1) {
      // 64-bit size lives in the eight bytes after the type.
      const high = buffer.readUInt32BE(at + 8);
      const low = buffer.readUInt32BE(at + 12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - at;      // box runs to end of file
    }

    if (size < headerSize || at + size > buffer.length) {
      throw new Error(`malformed box "${type}" at ${at}: size ${size}`);
    }

    boxes.push({ type, start: at, end: at + size });
    at += size;
  }

  if (at !== buffer.length) throw new Error(`trailing ${buffer.length - at} bytes after the last box`);
  return boxes;
}

/**
 * Splits a fragmented MP4 into the init segment and the media fragments.
 * @param {Buffer} buffer
 * @returns {{init: {start: number, end: number}, fragments: {index: number, start: number, end: number}[]}}
 */
export function splitFragmented(buffer) {
  const boxes = topLevelBoxes(buffer);
  const firstMoof = boxes.findIndex((b) => b.type === 'moof');

  if (firstMoof < 0) {
    throw new Error('no moof box: this file is not fragmented — re-encode with -movflags frag_keyframe+empty_moov');
  }
  if (!boxes.some((b) => b.type === 'moov')) throw new Error('no moov box: the file has no init segment');

  const init = { start: 0, end: boxes[firstMoof].start };
  const fragments = [];

  for (let i = firstMoof; i < boxes.length; i++) {
    if (boxes[i].type !== 'moof') continue;

    const mdat = boxes[i + 1];
    if (!mdat || mdat.type !== 'mdat') {
      throw new Error(`moof at ${boxes[i].start} is not followed by mdat`);
    }
    fragments.push({ index: fragments.length, start: boxes[i].start, end: mdat.end });
  }

  return { init, fragments };
}

/**
 * Reads the media timescale and total duration out of moov, so segments can be labelled
 * with playback time rather than just an index.
 * @returns {{timescale: number, durationSeconds: number} | null}
 */
export function readDuration(buffer) {
  const boxes = topLevelBoxes(buffer);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return null;

  // mvhd is the first child of moov: [4 size][4 'mvhd'][1 version][3 flags]...
  const at = moov.start + 8;
  if (buffer.toString('latin1', at + 4, at + 8) !== 'mvhd') return null;

  const version = buffer.readUInt8(at + 8);
  const base = at + 12;

  const timescale = version === 1 ? buffer.readUInt32BE(base + 16) : buffer.readUInt32BE(base + 8);
  const duration = version === 1
    ? Number(buffer.readBigUInt64BE(base + 20))
    : buffer.readUInt32BE(base + 12);

  // A fragmented file usually reports duration 0 in mvhd — the real length lives in mehd or
  // has to be summed from the fragments, so treat 0 as "unknown" rather than as zero length.
  return { timescale, durationSeconds: duration === 0 ? 0 : duration / timescale };
}
