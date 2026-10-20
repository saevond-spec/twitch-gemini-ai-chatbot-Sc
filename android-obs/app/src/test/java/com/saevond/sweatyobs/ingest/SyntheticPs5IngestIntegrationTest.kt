package com.saevond.sweatyobs.ingest

import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

/**
 * Test against a real bound TCP listener, not mocked packet-count methods.
 * CI adds 10.233.31.1 (receiver) and 10.233.31.2 (synthetic PS5) to lo.
 * This proves RTMP protocol compatibility for this synthetic source, NOT real PS5 firmware.
 */
class SyntheticPs5IngestIntegrationTest {
  @Test fun receivesRtmpPublishWithAvcAacAndKeyframe() {
    val gate = MediaRelayGate()
    val latch = CountDownLatch(4)
    val forwarded = mutableListOf<RtmpMessage>()
    val receiver = LanRtmpIngest("10.233.31.1", "10.233.31.2") { packet ->
      synchronized(forwarded) { forwarded.addAll(gate.process(packet)) }
      latch.countDown()
    }
    receiver.start()
    try {
      val sock = Socket()
      sock.bind(InetSocketAddress("10.233.31.2", 0))
      sock.connect(InetSocketAddress("10.233.31.1", 1935), 3000)
      sock.soTimeout = 5000
      sock.use { client ->
        val input = client.getInputStream()
        val output = client.getOutputStream()
        val c1 = ByteArray(1536)
        SecureRandom().nextBytes(c1)
        output.write(3)
        output.write(c1)
        output.flush()
        assertEquals(3, input.read())
        val s1 = input.readRequired(1536)
        input.readRequired(1536)
        output.write(s1)
        output.flush()
        rtmpCommand(output, 0, amfString("connect") + amfNumber(1.0) +
          amfObject("app" to amfString("app")))
        rtmpCommand(output, 0, amfString("createStream") + amfNumber(2.0) + amfNull())
        rtmpCommand(output, 1, amfString("publish") + amfNumber(0.0) + amfNull() +
          amfString("live_test_mock") + amfString("live"))
        sendRtmpMedia(output, RtmpMessage(9, 100, 1,
          byteArrayOf(0x17,0,0,0,0,1,2,3)))
        sendRtmpMedia(output, RtmpMessage(8, 100, 1,
          byteArrayOf(0xaf.toByte(),0,0x12,0x10)))
        sendRtmpMedia(output, RtmpMessage(9, 200, 1,
          byteArrayOf(0x17,1,0,0,0,7)))
        sendRtmpMedia(output, RtmpMessage(8, 225, 1,
          byteArrayOf(0xaf.toByte(),1,6,5)))
        output.flush()
        assertTrue("Synthetic PS5 RTMP media never reached onMedia", latch.await(7, TimeUnit.SECONDS))
      }
      assertEquals(2L, receiver.videoPackets)
      assertEquals(2L, receiver.audioPackets)
      synchronized(forwarded) {
        assertEquals(listOf(9,8,9,8), forwarded.map { it.type })
        assertEquals(listOf(0L,0L,0L,25L), forwarded.map { it.timestamp })
      }
    } finally { receiver.stop() }
  }
}
