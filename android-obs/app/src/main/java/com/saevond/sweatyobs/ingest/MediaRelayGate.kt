package com.saevond.sweatyobs.ingest

/** Live-only H.264+AAC FLV packet pass-through with two decoder config packets cached in RAM. */
class MediaRelayGate {
  private var videoConfig: RtmpMessage? = null
  private var audioConfig: RtmpMessage? = null
  private var live = false
  private var baseTime = 0L
  private var videoTime = 0L
  private var audioTime = 0L
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
          if (live) throw IllegalStateException("Video configuration changed during relay")
          if (bytes.size >= 8) videoConfig = message.copy(data = bytes.copyOf())
          return emptyList()
        }
        1 -> {}
        else -> return emptyList()
      }
    } else {
      if ((bytes[0].toInt() and 240) != 0xa0) return emptyList() // AAC only
      when (bytes[1].toInt() and 255) {
        0 -> {
          if (live) throw IllegalStateException("Audio configuration changed during relay")
          if (bytes.size >= 4) audioConfig = message.copy(data = bytes.copyOf())
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
      return listOf(
        videoConfig!!.copy(timestamp = 0L, streamId = 1),
        audioConfig!!.copy(timestamp = 0L, streamId = 1),
        message.copy(timestamp = 0L, streamId = 1)
      )
    }
    val delta = (message.timestamp - baseTime).coerceAtLeast(0L)
    val timestamp = if (video) delta.coerceAtLeast(videoTime) else delta.coerceAtLeast(audioTime)
    if (video) videoTime = timestamp else audioTime = timestamp
    frames++
    return listOf(message.copy(timestamp = timestamp, streamId = 1))
  }
}
