package com.saevond.sweatyobs

/** Conservative safeguards for the owner's everyday phone. Not a medical/battery guarantee. */
enum class SafetyLevel { OK, WARN, STOP }

data class SafetySample(
  val thermalStatus: Int,
  val batteryTempDeciC: Int?,
  val batteryPercent: Int?,
  val charging: Boolean
)

data class SafetyDecision(val level: SafetyLevel, val message: String)

object PowerSafetyPolicy {
  const val WARM_BATTERY_DECI_C = 390
  const val STOP_BATTERY_DECI_C = 420
  const val LOW_BATTERY_WARN_PERCENT = 25
  const val LOW_BATTERY_STOP_PERCENT = 15
  const val WARM_TIMEOUT_MS = 5 * 60 * 1000L

  /** Android thermal statuses 0..6: MODERATE=2, SEVERE=3. */
  fun isWarm(sample: SafetySample): Boolean =
    sample.thermalStatus >= 2 || (sample.batteryTempDeciC ?: 0) >= WARM_BATTERY_DECI_C

  fun assess(sample: SafetySample, warmDurationMs: Long = 0): SafetyDecision {
    if (sample.thermalStatus >= 3)
      return SafetyDecision(SafetyLevel.STOP, "Android reports severe thermal stress")
    if (sample.batteryTempDeciC != null && sample.batteryTempDeciC >= STOP_BATTERY_DECI_C)
      return SafetyDecision(SafetyLevel.STOP, "Battery reached the conservative heat cutoff")
    if (sample.batteryPercent != null && sample.batteryPercent <= 8)
      return SafetyDecision(SafetyLevel.STOP, "Battery critically low")
    if (!sample.charging && sample.batteryPercent != null &&
      sample.batteryPercent <= LOW_BATTERY_STOP_PERCENT)
      return SafetyDecision(SafetyLevel.STOP, "Low battery: keeping phone available for chat")
    if (sample.batteryTempDeciC == null && sample.batteryPercent == null)
      return SafetyDecision(SafetyLevel.STOP, "Battery telemetry unavailable")
    if (isWarm(sample) && warmDurationMs >= WARM_TIMEOUT_MS)
      return SafetyDecision(SafetyLevel.STOP, "Phone stayed warm for five minutes")
    if (isWarm(sample))
      return SafetyDecision(SafetyLevel.WARN, "Phone warming up; cool it before continuing")
    if (!sample.charging && sample.batteryPercent != null &&
      sample.batteryPercent <= LOW_BATTERY_WARN_PERCENT)
      return SafetyDecision(SafetyLevel.WARN, "Battery getting low")
    return SafetyDecision(SafetyLevel.OK, "Phone safety checks normal")
  }
}
