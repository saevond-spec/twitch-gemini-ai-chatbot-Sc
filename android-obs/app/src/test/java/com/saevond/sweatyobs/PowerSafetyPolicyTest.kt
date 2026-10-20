package com.saevond.sweatyobs
import org.junit.Assert.*
import org.junit.Test

class PowerSafetyPolicyTest {
  private fun sample(thermal: Int = 0, temp: Int? = 350, battery: Int? = 70, charging: Boolean = false) =
    SafetySample(thermal, temp, battery, charging)
  @Test fun normalPhoneIsAllowed() = assertEquals(SafetyLevel.OK, PowerSafetyPolicy.assess(sample()).level)
  @Test fun warmPhoneWarns() = assertEquals(SafetyLevel.WARN, PowerSafetyPolicy.assess(sample(temp = 390)).level)
  @Test fun warmPhoneStopsAfterFiveMinutes() = assertEquals(SafetyLevel.STOP, PowerSafetyPolicy.assess(sample(temp = 390), 300_000).level)
  @Test fun hotPhoneStopsImmediately() = assertEquals(SafetyLevel.STOP, PowerSafetyPolicy.assess(sample(temp = 420)).level)
  @Test fun androidSevereThermalStopsImmediately() = assertEquals(SafetyLevel.STOP, PowerSafetyPolicy.assess(sample(thermal = 3)).level)
  @Test fun moderatelyThrottledPhoneWarns() = assertEquals(SafetyLevel.WARN, PowerSafetyPolicy.assess(sample(thermal = 2)).level)
  @Test fun batteryStopsWhenUnplugged() = assertEquals(SafetyLevel.STOP, PowerSafetyPolicy.assess(sample(battery = 15)).level)
  @Test fun batteryWarnsAtTwentyFive() = assertEquals(SafetyLevel.WARN, PowerSafetyPolicy.assess(sample(battery = 25)).level)
  @Test fun criticalBatteryStopsEvenCharging() = assertEquals(SafetyLevel.STOP, PowerSafetyPolicy.assess(sample(battery = 8, charging = true)).level)
  @Test fun unavailableTelemetryFailsClosed() = assertEquals(SafetyLevel.STOP, PowerSafetyPolicy.assess(sample(temp = null, battery = null)).level)
}
