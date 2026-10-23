package com.saevond.sweatyobs

import android.app.ApplicationExitInfo
import org.junit.Assert.assertTrue
import org.junit.Test

class ProcessExitDiagnosticsTest {
  @Test fun reasonMappingSeparatesSystemKillFromCrashAndUserRequestedStop() {
    assertTrue(ProcessExitDiagnostics.reasonLabel(ApplicationExitInfo.REASON_LOW_MEMORY).contains("low-memory"))
    assertTrue(ProcessExitDiagnostics.reasonLabel(ApplicationExitInfo.REASON_CRASH).contains("crash"))
    assertTrue(ProcessExitDiagnostics.reasonLabel(ApplicationExitInfo.REASON_USER_REQUESTED).contains("user-requested"))
  }
}
