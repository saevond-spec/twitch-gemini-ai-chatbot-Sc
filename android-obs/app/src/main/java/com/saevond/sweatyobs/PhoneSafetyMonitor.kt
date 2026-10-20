package com.saevond.sweatyobs

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager

/** Polling Android signals; owner must still monitor physical device comfort. */
class PhoneSafetyMonitor(private val context: Context) {
  private val power = context.getSystemService(PowerManager::class.java)
  private var warmSinceMs: Long? = null

  fun assess(): SafetyDecision {
    val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val rawLevel = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
    val percent = if (rawLevel >= 0 && scale > 0) rawLevel * 100 / scale else null
    val rawTemp = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1
    val temp = if (rawTemp in 0..900) rawTemp else null
    val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
      status == BatteryManager.BATTERY_STATUS_FULL
    val thermal = power?.currentThermalStatus ?: PowerManager.THERMAL_STATUS_NONE
    val sample = SafetySample(thermal, temp, percent, charging)
    val now = android.os.SystemClock.elapsedRealtime()
    if (PowerSafetyPolicy.isWarm(sample)) {
      if (warmSinceMs == null) warmSinceMs = now
    } else warmSinceMs = null
    return PowerSafetyPolicy.assess(sample, warmSinceMs?.let { now - it } ?: 0)
  }
}
