package com.saevond.sweatyobs

/** Sleipnir's RTMPS route and conservative free-tier CBR target budget. */
internal object SleipnirRelay {
  const val DEFAULT_INGEST_URL = "rtmps://ingest.sleipnir.tv:1936/live"
  const val MAX_INGEST_BITRATE_BPS = 5_000_000
  const val AUDIO_BITRATE_BPS = 128_000
  const val NETWORK_OVERHEAD_PERCENT = 10
  const val MAX_VIDEO_BITRATE_BPS = 3_800_000


  enum class RateControl { CBR, CBR_FD }
  data class RateControlRequest(val mode: RateControl, val advertised: Boolean)

  /**
   * Prefer rate-control modes the phone advertises. If it reports neither capped
   * mode, probe CBR once as an OEM compatibility path. VBR is never a Sleipnir fallback.
   */
  fun cappedRateControlRequests(cbrSupported: Boolean, cbrFdSupported: Boolean): List<RateControlRequest> =
    buildList {
      if (cbrSupported) add(RateControlRequest(RateControl.CBR, advertised = true))
      if (cbrFdSupported) add(RateControlRequest(RateControl.CBR_FD, advertised = true))
      if (isEmpty()) add(RateControlRequest(RateControl.CBR, advertised = false))
    }

  private val LANDSCAPE_SIZE_LIMITS = listOf(
    1920 to 1080, 1280 to 720, 960 to 540, 854 to 480, 640 to 360, 426 to 240
  )

  /**
   * Returns a descending aspect-preserving size ladder without upscaling.
   * Codec-specific alignment is applied by rounding dimensions down.
   */
  fun candidateSizes(
    sourceWidth: Int,
    sourceHeight: Int,
    widthAlignment: Int = 2,
    heightAlignment: Int = 2
  ): List<Pair<Int, Int>> {
    require(sourceWidth > 0 && sourceHeight > 0)
    require(widthAlignment > 0 && heightAlignment > 0)
    val limits = if (sourceWidth >= sourceHeight) LANDSCAPE_SIZE_LIMITS
      else LANDSCAPE_SIZE_LIMITS.map { (width, height) -> height to width }
    return limits.mapNotNull { (maxWidth, maxHeight) ->
      val scale = minOf(
        1.0,
        maxWidth.toDouble() / sourceWidth,
        maxHeight.toDouble() / sourceHeight
      )
      val width = ((sourceWidth * scale).toInt() / widthAlignment) * widthAlignment
      val height = ((sourceHeight * scale).toInt() / heightAlignment) * heightAlignment
      if (width <= 0 || height <= 0 || width > sourceWidth || height > sourceHeight) null
      else width to height
    }.distinct()
  }

  /**
   * Video target ladder leaves room for 128 kb/s AAC and transport overhead
   * under Sleipnir Free's currently advertised 5 Mb/s ingest ceiling.
   */
  fun videoBitrate(width: Int, height: Int, maxBitrate: Int = Int.MAX_VALUE): Int {
    require(width > 0 && height > 0)
    require(maxBitrate > 0)
    val normalTarget = when {
      width >= 1920 && height >= 1080 -> 8_000_000
      width >= 1280 && height >= 720 -> 6_000_000
      else -> 4_000_000
    }
    if (maxBitrate == Int.MAX_VALUE) return normalTarget
    val longSide = maxOf(width, height)
    val relayTarget = when {
      longSide >= 1800 -> MAX_VIDEO_BITRATE_BPS
      longSide >= 1200 -> 2_800_000
      longSide >= 900 -> 1_800_000
      longSide >= 800 -> 1_400_000
      longSide >= 600 -> 900_000
      else -> 500_000
    }
    return minOf(relayTarget, maxBitrate)
  }

  /** Fits the requested target into the codec range and configured route target. */
  fun fitCodecBitrate(
    targetBps: Int,
    supportedMinBps: Int,
    supportedMaxBps: Int,
    maxAllowedBps: Int
  ): Int? {
    require(targetBps > 0 && supportedMinBps > 0 && supportedMaxBps > 0 && maxAllowedBps > 0)
    if (supportedMinBps > supportedMaxBps) return null
    val upper = minOf(supportedMaxBps, maxAllowedBps)
    if (supportedMinBps > upper) return null
    return targetBps.coerceIn(supportedMinBps, upper)
  }

  /** Ceiling estimate for video + AAC after a configurable transport allowance. */
  fun projectedIngestBitrate(
    videoBps: Int,
    audioBps: Int = AUDIO_BITRATE_BPS,
    overheadPercent: Int = NETWORK_OVERHEAD_PERCENT
  ): Long {
    require(videoBps >= 0 && audioBps >= 0)
    require(overheadPercent in 0..100)
    val payload = videoBps.toLong() + audioBps.toLong()
    val numerator = payload * (100 + overheadPercent)
    return (numerator + 99) / 100
  }
}
