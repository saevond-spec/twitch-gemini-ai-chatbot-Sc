package com.saevond.sweatyobs.ingest

/** Live-only H.264+AAC FLV packet pass-through with two decoder config packets cached in RAM. */
class MediaRelayGate {
  private var videoConfig: RtmpMessage? = null
  private var audioConfig: RtmpMessage? = null
  private var live = false
  private var baseTime: Long? = null
  private var timelineOffset = 0L
  private var videoTime = 0L
  private var audioTime = 0L
  private var outputReconnectRequested = false
  var frames = 0L
    private set

  fun process(message: RtmpMessage): List<RtmpMessage> {
    if (message.type !in listOf(8, 9) || message.data.size < 3) return emptyList()
    val bytes = message.data
    val video = message.type == 9
    if (video) {
      if ((bytes[0].toInt() and 15) != 7) return emptyList() // AVC only
      when (bytes[1].toInt() and 255) {
        0 -> {
          if (bytes.size >= 8) updateVideoConfig(message)
          return emptyList()
        }
        1 -> {}
        else -> return emptyList()
      }
    } else {
      if ((bytes[0].toInt() and 240) != 0xa0) return emptyList() // AAC only
      when (bytes[1].toInt() and 255) {
        0 -> {
          if (bytes.size >= 4) updateAudioConfig(message)
          return emptyList()
        }
        1 -> {}
        else -> return emptyList()
      }
    }
    if (!live) {
      if (!video || videoConfig == null || audioConfig == null) return emptyList()
      if ((bytes[0].toInt() and 0xf0) != 0x10) return emptyList() // first AVC frame must be IDR-class keyframe
      baseTime = message.timestamp
      live = true
      frames++
      videoTime = maxOf(videoTime, timelineOffset)
      audioTime = maxOf(audioTime, timelineOffset)
      return listOf(
        videoConfig!!.copy(timestamp = timelineOffset, streamId = 1),
        audioConfig!!.copy(timestamp = timelineOffset, streamId = 1),
        message.copy(timestamp = timelineOffset, streamId = 1)
      )
    }
    val delta = (message.timestamp - (baseTime ?: message.timestamp)).coerceAtLeast(0L)
    val timestamp = timelineOffset + delta
    val monotonic = if (video) timestamp.coerceAtLeast(videoTime) else timestamp.coerceAtLeast(audioTime)
    if (video) videoTime = monotonic else audioTime = monotonic
    frames++
    return listOf(message.copy(timestamp = monotonic, streamId = 1))
  }

  /** True once after a changed codec header invalidates the current output session. */
  fun consumeOutputReconnectRequest(): Boolean {
    val requested = outputReconnectRequested
    outputReconnectRequested = false
    return requested
  }

  private fun updateVideoConfig(message: RtmpMessage) {
    val next = message.copy(data = message.data.copyOf())
    val previous = videoConfig
    if (live && previous != null && !previous.data.contentEquals(next.data)) {
      beginCodecReconfiguration()
    }
    videoConfig = next
  }

  private fun updateAudioConfig(message: RtmpMessage) {
    val next = message.copy(data = message.data.copyOf())
    val previous = audioConfig
    if (live && previous != null && !previous.data.contentEquals(next.data)) {
      beginCodecReconfiguration()
    }
    audioConfig = next
  }

  private fun beginCodecReconfiguration() {
    // Drop deltas until a keyframe arrives, then begin a fresh RTMPS session
    // with new headers on a monotonic output timeline.
    timelineOffset = maxOf(videoTime, audioTime, timelineOffset) + 1L
    baseTime = null
    live = false
    outputReconnectRequested = true
  }

  /** Reset codec headers for a reconnected PS5 session while preserving output timestamps. */
  fun resetForSourceReconnect() {
    timelineOffset = maxOf(videoTime, audioTime, timelineOffset) + 1L
    videoConfig = null
    audioConfig = null
    live = false
    baseTime = null
    outputReconnectRequested = false
  }
}
