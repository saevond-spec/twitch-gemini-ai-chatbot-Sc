package com.saevond.sweatyobs

/** Sleipnir's documented RTMPS ingest and conservative free-tier encode budget. */
internal object SleipnirRelay {
  const val DEFAULT_INGEST_URL = "rtmps://ingest.sleipnir.tv/live"
  const val MAX_VIDEO_BITRATE_BPS = 4_700_000

  fun videoBitrate(width: Int, height: Int, maxBitrate: Int = Int.MAX_VALUE): Int {
    require(width > 0 && height > 0)
    require(maxBitrate > 0)
    val normalTarget = when {
      width >= 1920 && height >= 1080 -> 8_000_000
      width >= 1280 && height >= 720 -> 6_000_000
      else -> 4_000_000
    }
    return minOf(normalTarget, maxBitrate)
  }
}
