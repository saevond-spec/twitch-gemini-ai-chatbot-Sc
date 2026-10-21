package com.saevond.sweatyobs

import org.junit.Assert.*
import org.junit.Test

class StartupAttemptGateTest {
  @Test fun onlyOneStartupCanBePendingAndStaleCallbacksCannotFinishANewerAttempt() {
    val gate = StartupAttemptGate()
    val first = gate.begin() ?: error("first start should be accepted")

    assertTrue(gate.isPending())
    assertTrue(gate.isCurrent(first))
    assertNull("a duplicate start should be rejected while decode is pending", gate.begin())
    assertTrue("cancelling the active token should invalidate it", gate.cancel(first))
    assertFalse(gate.isCurrent(first))

    val second = gate.begin() ?: error("a fresh start should be accepted after cancellation")
    assertTrue(first != second)
    assertFalse("a stale decoder callback must not finish the new start", gate.finish(first))
    assertTrue(gate.isCurrent(second))
    assertTrue(gate.finish(second))
    assertFalse(gate.isPending())
    assertFalse(gate.isCurrent(second))
  }

  @Test fun stopInvalidatesPendingStartup() {
    val gate = StartupAttemptGate()
    val token = gate.begin() ?: error("start should be accepted")

    gate.cancel()

    assertFalse(gate.isPending())
    assertFalse(gate.isCurrent(token))
    assertFalse(gate.finish(token))
  }
}
