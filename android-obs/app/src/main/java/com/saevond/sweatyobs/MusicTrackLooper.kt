package com.saevond.sweatyobs

/**
 * Live-only in-memory music PCM cursor. 48 kHz stereo s16le.
 * Decoding is done separately; this class never downloads audio or captures Android audio.
 */
class MusicTrackLooper {
  private var pcm = ByteArray(0)
  private var offset = 0
  @Volatile var playing: Boolean = false
    private set
  val ready: Boolean get() = synchronized(this) { pcm.isNotEmpty() }

  @Synchronized fun load(track: ByteArray) {
    require(track.size in 4..(60 * 1024 * 1024) && track.size % 4 == 0)
    // Ownership of the decoded PCM transfers to this single-stream looper.
    // Avoid doubling up to 60 MB on a 4 GB Android phone.
    pcm = track
    offset = 0
    playing = false
  }
  @Synchronized fun command(action: String) {
    when (action) {
      "play" -> playing = pcm.isNotEmpty()
      "pause" -> playing = false
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
    }
    return out
  }
  @Synchronized fun clear() { pcm = ByteArray(0); playing = false; offset = 0 }
}
