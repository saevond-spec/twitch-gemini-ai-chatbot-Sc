package com.saevond.sweatyobs.ingest

import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.*
import org.junit.Test

class RtmpsConnectivityTest {
  @Test fun officialKickServerIsAValidSecureEndpoint() {
    assertEquals(
      "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app",
      RtmpsPublisher.KICK_RTMPS_URL
    )
    assertTrue(RtmpsPublisher.endpointValid(RtmpsPublisher.KICK_RTMPS_URL))
  }

  @Test fun tlsProbeRejectsInvalidSchemesWithoutOpeningANetworkConnection() {
    assertEquals("INVALID_URL", RtmpsPublisher.testTlsEndpoint("rtmp://ingest.example.test/app"))
    assertEquals("INVALID_URL", RtmpsPublisher.testTlsEndpoint("https://ingest.example.test/app"))
  }

  @Test fun retriesAnotherDnsAddressWithinOneSharedTimeoutBudget() {
    val addresses = arrayOf(address(203, 0, 113, 10), address(203, 0, 113, 11))
    val time = AtomicLong(0L)
    val attempted = mutableListOf<InetAddress>()

    val selected = RtmpsPublisher.tryResolvedAddresses(
      addresses,
      timeoutMs = 100,
      nowNanos = { time.get() }
    ) { candidate, remainingMs ->
      attempted += candidate
      if (candidate == addresses[0]) {
        assertEquals(100, remainingMs)
        time.addAndGet(90_000_000L)
        throw IOException("synthetic first route unavailable")
      }
      assertTrue("fallback retains only the shared deadline's remaining time", remainingMs in 1..10)
      "reachable synthetic route"
    }

    assertEquals("reachable synthetic route", selected)
    assertEquals(addresses.toList(), attempted)
  }

  @Test fun addressFallbackStopsWhenTheTotalTimeoutExpires() {
    val addresses = arrayOf(address(203, 0, 113, 20), address(203, 0, 113, 21))
    val time = AtomicLong(0L)
    var attempts = 0

    try {
      RtmpsPublisher.tryResolvedAddresses(addresses, timeoutMs = 25, nowNanos = { time.get() }) { _, _ ->
        attempts++
        time.addAndGet(25_000_000L)
        throw IOException("synthetic timeout")
      }
      fail("all failed candidates must fail the probe")
    } catch (_: IOException) {
      assertEquals("must not try more addresses after the shared deadline", 1, attempts)
    }
  }

  @Test fun answersRtmpPingRequestsWithTheSameTimestamp() {
    val request = byteArrayOf(0, 6, 0x12, 0x34, 0x56, 0x78)
    assertArrayEquals(
      byteArrayOf(0, 7, 0x12, 0x34, 0x56, 0x78),
      RtmpsPublisher.pingResponsePayload(request)
    )
    assertNull(RtmpsPublisher.pingResponsePayload(byteArrayOf(0, 6, 1, 2)))
    assertNull(RtmpsPublisher.pingResponsePayload(byteArrayOf(0, 3, 1, 2, 3, 4)))
  }

  @Test fun byteCounterTracksBothSingleAndBufferedReads() {
    val input = CountingInputStream(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)))
    assertEquals(1, input.read())
    val tail = ByteArray(3)
    assertEquals(3, input.read(tail, 0, tail.size))
    assertArrayEquals(byteArrayOf(2, 3, 4), tail)
    assertEquals(4L, input.bytesRead)
  }

  private fun address(a: Int, b: Int, c: Int, d: Int) =
    InetAddress.getByAddress(byteArrayOf(a.toByte(), b.toByte(), c.toByte(), d.toByte()))
}
