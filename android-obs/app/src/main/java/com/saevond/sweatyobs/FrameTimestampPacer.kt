package com.saevond.sweatyobs

/**
 * Selects source frames against an absolute output-rate timeline.
 *
 * PS5 RTMP timestamps are millisecond-quantized. A small one-millisecond
 * tolerance prevents normal timestamp rounding (for example 33 ms at 30 fps)
 * from pushing every boundary to the next input frame.
 */
internal class FrameTimestampPacer(targetFrameRate: Int) {
  private val targetFps = targetFrameRate.toLong()
  private var epochTimestampNs: Long? = null
  private var lastSourceTimestampNs = -1L
  private var lastOutputBucket = 0L

  init {
    require(targetFrameRate > 0)
  }

  /** Returns the source timestamp when its output-rate bucket is new, otherwise null. */
  fun nextTimestampNs(sourceTimestampNs: Long): Long? {
    val timestamp = sourceTimestampNs.coerceAtLeast(0L)
    val epoch = epochTimestampNs
    if (epoch == null) {
      epochTimestampNs = timestamp
      lastSourceTimestampNs = timestamp
      lastOutputBucket = 0L
      return timestamp
    }
    if (timestamp <= lastSourceTimestampNs) return null
    lastSourceTimestampNs = timestamp

    val elapsed = timestamp - epoch
    val wholeSeconds = elapsed / NANOS_PER_SECOND
    val remainderNs = elapsed % NANOS_PER_SECOND
    val bucket = wholeSeconds * targetFps +
      ((remainderNs + RTMP_TIMESTAMP_RESOLUTION_NS) * targetFps / NANOS_PER_SECOND)
    if (bucket <= lastOutputBucket) return null

    // If timestamps jump, skip missed buckets instead of outputting a burst.
    lastOutputBucket = bucket
    return timestamp
  }

  private companion object {
    const val NANOS_PER_SECOND = 1_000_000_000L
    const val RTMP_TIMESTAMP_RESOLUTION_NS = 1_000_000L
  }
}
