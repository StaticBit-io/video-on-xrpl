/**
 * Feeds ledger-sourced bytes into a <video> element through MediaSource.
 *
 * SourceBuffer accepts one append at a time — calling appendBuffer while `updating` is true
 * throws — so every append goes through a queue. The player above this layer never has to
 * think about that: it awaits append() and gets back a promise that settles when the buffer
 * has actually taken the bytes.
 */

export class StreamerError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = 'StreamerError';
    this.cause = cause;
  }
}

export class Streamer {
  /**
   * @param {HTMLVideoElement} video
   * @param {string} mimeCodec e.g. video/mp4; codecs="avc1.4D401F"
   * @param {number} [durationSeconds] total length, known from the index before any byte arrives
   */
  constructor(video, mimeCodec, durationSeconds = 0) {
    if (!('MediaSource' in window)) {
      throw new StreamerError('this browser has no MediaSource — streaming from the ledger needs it');
    }
    if (!MediaSource.isTypeSupported(mimeCodec)) {
      throw new StreamerError(`this browser cannot decode ${mimeCodec}`);
    }

    this.video = video;
    this.mimeCodec = mimeCodec;
    this.durationSeconds = durationSeconds;
    this.mediaSource = new MediaSource();
    this.sourceBuffer = null;
    this.queue = Promise.resolve();
    this.ended = false;
  }

  /** Attaches the MediaSource to the video element and waits for it to open. */
  async open() {
    this.video.src = URL.createObjectURL(this.mediaSource);

    await new Promise((resolve, reject) => {
      this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
      this.mediaSource.addEventListener('error', () => reject(new StreamerError('MediaSource failed to open')), { once: true });
    });

    this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeCodec);

    // 'segments' honours each fragment's own timestamps, so fragments may be appended out of
    // order — which is what a seek does. 'sequence' would stack them back to back and put a
    // fragment fetched after a jump in the wrong place on the timeline.
    this.sourceBuffer.mode = 'segments';

    // Declaring the duration up front makes the whole timeline seekable immediately. Without
    // it `seekable` is only what has been buffered, so a jump past the loaded part snaps back
    // instead of asking for the fragment that covers it.
    if (this.durationSeconds > 0) this.mediaSource.duration = this.durationSeconds;
  }

  /**
   * Appends one piece — the init segment or a media fragment.
   * Appends are serialised: each waits for the previous to finish.
   * @param {Uint8Array} bytes
   */
  append(bytes) {
    this.queue = this.queue.then(() => new Promise((resolve, reject) => {
      if (this.ended) return resolve();

      const onDone = () => { cleanup(); resolve(); };
      const onFail = () => {
        cleanup();
        reject(new StreamerError('the decoder rejected these bytes — the fragment is damaged or out of order'));
      };
      const cleanup = () => {
        this.sourceBuffer.removeEventListener('updateend', onDone);
        this.sourceBuffer.removeEventListener('error', onFail);
      };

      this.sourceBuffer.addEventListener('updateend', onDone);
      this.sourceBuffer.addEventListener('error', onFail);

      try {
        this.sourceBuffer.appendBuffer(bytes);
      } catch (error) {
        cleanup();
        reject(new StreamerError(`appendBuffer refused the data: ${error.message}`, { cause: error }));
      }
    }));

    return this.queue;
  }

  /** True when the given moment already sits in the buffer. */
  hasTime(seconds) {
    const buffered = this.sourceBuffer?.buffered;
    if (!buffered?.length) return false;
    for (let i = 0; i < buffered.length; i++) {
      if (seconds >= buffered.start(i) - 0.05 && seconds < buffered.end(i)) return true;
    }
    return false;
  }

  /** Seconds of media buffered ahead of the playhead. */
  bufferedAhead() {
    const buffered = this.sourceBuffer?.buffered;
    if (!buffered?.length) return 0;

    const at = this.video.currentTime;
    for (let i = 0; i < buffered.length; i++) {
      if (at >= buffered.start(i) - 0.1 && at <= buffered.end(i)) return buffered.end(i) - at;
    }
    return 0;
  }

  /** Total seconds of media handed to the decoder so far. */
  bufferedEnd() {
    const buffered = this.sourceBuffer?.buffered;
    return buffered?.length ? buffered.end(buffered.length - 1) : 0;
  }

  /** Tells the decoder no more fragments are coming, so duration settles and playback can end. */
  async end() {
    await this.queue;
    if (this.ended || this.mediaSource.readyState !== 'open') return;
    this.ended = true;
    this.mediaSource.endOfStream();
  }
}
