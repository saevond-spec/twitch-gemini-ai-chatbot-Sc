package com.saevond.sweatyobs

/** Drops decoded frames above the encoder's selected output cadence. */
internal class FrameTimestampPacer(targetFrameRate: Int) {
  private val minimumIntervalNs: Long
  private var lastOutputTimestampNs = 0L

  init {
    require(targetFrameRate > 0)
    minimumIntervalNs = 1_000_000_000L / targetFrameRate
  }

  /** Returns the source timestamp when a frame fits the cadence, otherwise null. */
  fun nextTimestampNs(sourceTimestampNs: Long): Long? {
    val timestamp = sourceTimestampNs.coerceAtLeast(1L)
    if (lastOutputTimestampNs > 0L &&
      (timestamp <= lastOutputTimestampNs || timestamp - lastOutputTimestampNs < minimumIntervalNs)
    ) return null
    lastOutputTimestampNs = timestamp
    return timestamp
  }
}
