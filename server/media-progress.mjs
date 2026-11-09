/**
 * Parses FFmpeg -progress pipe:1 without relying on stderr (which can contain
 * private RTMPS destination credentials).
 *
 * These numbers describe *locally processed* media, not PS5 identity, inbound
 * audio packet counts, or verified playback on any destination.
 */
export class MediaProgress {
  constructor({ now = Date.now, stallAfterMs = 20000 } = {}) {
    this.now = now;
    this.stallAfterMs = stallAfterMs;
    this.videoFrames = 0;
    this.outputBytes = 0;
    this.outputTimeMs = 0;
    this.speed = null;
    this.lastVideoAt = null;
    this.lastProgressAt = null;
    this.finished = false;
  }

  accept(line) {
    const split = line.indexOf('=');
    if (split === -1) return;
    const key = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    const number = Number(value);
    if (key === 'frame' && /^\\d+$/.test(value) && Number.isSafeInteger(number)) {
      if (number > this.videoFrames) this.lastVideoAt = this.now();
      this.videoFrames = Math.max(this.videoFrames, number);
    } else if (key === 'total_size' && /^\\d+$/.test(value) && Number.isSafeInteger(number)) {
      this.outputBytes = Math.max(this.outputBytes, number);
    } else if (key === 'out_time_us' && /^\\d+$/.test(value) && Number.isSafeInteger(number)) {
      this.outputTimeMs = Math.max(this.outputTimeMs, Math.floor(number / 1000));
    } else if (key === 'out_time_ms' && /^\\d+$/.test(value) && Number.isSafeInteger(number)) {
      // Older FFmpeg versions name this field _ms while its units are microseconds.
      this.outputTimeMs = Math.max(this.outputTimeMs, Math.floor(number / 1000));
    } else if (key === 'speed' && /^(?:\\d+(?:\\.\\d+)?)x$/.test(value)) {
      this.speed = value;
    } else if (key === 'progress' && (value === 'continue' || value === 'end')) {
      this.lastProgressAt = this.now();
      if (value === 'end') this.finished = true;
    }
  }

  snapshot() {
    const waiting = this.videoFrames === 0;
    const stalled = !waiting && this.lastVideoAt !== null &&
      this.now() - this.lastVideoAt >= this.stallAfterMs;
    return {
      videoFrames: this.videoFrames,
      outputBytes: this.outputBytes,
      outputTimeMs: this.outputTimeMs,
      speed: this.speed,
      lastVideoAt: this.lastVideoAt === null ? null : new Date(this.lastVideoAt).toISOString(),
      lastProgressAt: this.lastProgressAt === null ? null : new Date(this.lastProgressAt).toISOString(),
      sourceState: waiting ? 'WAITING_FOR_MEDIA' : stalled ? 'STALLED' : 'PROCESSING',
      // Important: FFmpeg progress does not give an audio packet counter.
      audioPackets: null,
      downstreamPlaybackVerified: false
    };
  }
}
