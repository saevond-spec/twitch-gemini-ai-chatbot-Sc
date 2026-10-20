package com.saevond.sweatyobs

/**
 * Live-only in-memory music PCM cursor. 48 kHz stereo s16le.
 * Decoding is done separately; this class never downloads audio or captures Android audio.
 */
class MusicTrackLooper {
  private var pcm = ByteArray(0)
  private var offset = 0
  private var autoStartArmed = false
  /** Called after a local track wraps. Only schedule asynchronous decoding here. */
  @Volatile var onTrackEnd: (() -> Unit)? = null
  @Volatile var playing: Boolean = false
    private set
  val ready: Boolean get() = synchronized(this) { pcm.isNotEmpty() }

  @Synchronized fun load(track: ByteArray, autoStart: Boolean = true) {
    require(track.size in 4..(60 * 1024 * 1024) && track.size % 4 == 0)
    // Ownership of the decoded PCM transfers to this single-stream looper.
    // Avoid doubling up to 60 MB on a 4 GB Android phone.
    pcm = track
    offset = 0
    playing = false
    autoStartArmed = autoStart
  }

  /**
   * Invoked ONLY after Twitch has acknowledged RTMP publishing and the first
   * usable PS5 media batch exists. Never during receiver diagnostics or arming.
   * An explicit pause/play command before this point overrides auto-start.
   */
  @Synchronized fun onBroadcastStarted(): Boolean {
    if (autoStartArmed && pcm.isNotEmpty()) playing = true
    autoStartArmed = false
    return playing
  }

  /** Seamless in-memory replacement; leaves user Play/Pause choice unchanged. */
  @Synchronized fun replace(track: ByteArray) {
    require(track.size in 4..(60 * 1024 * 1024) && track.size % 4 == 0)
    pcm = track
    offset = 0
  }

  @Synchronized fun command(action: String) {
    when (action) {
      "play" -> { autoStartArmed = false; playing = pcm.isNotEmpty() }
      "pause" -> { autoStartArmed = false; playing = false }
      "skip" -> offset = 0  // one local rights-cleared track; restart it
      else -> throw IllegalArgumentException("Unsupported music action")
    }
  }
  @Synchronized fun nextWindow(size: Int): ByteArray {
    require(size in 4..131072 && size % 4 == 0)
    val out = ByteArray(size)
    if (!playing || pcm.isEmpty()) return out
    var written = 0
    while (written < size) {
      val n = minOf(size - written, pcm.size - offset)
      System.arraycopy(pcm, offset, out, written, n)
      written += n
      offset = (offset + n) % pcm.size
      if (offset == 0) onTrackEnd?.invoke()
    }
    return out
  }
  @Synchronized fun clear() { pcm = ByteArray(0); playing = false; offset = 0; autoStartArmed = false }
}
