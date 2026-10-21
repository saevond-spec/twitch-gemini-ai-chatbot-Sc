package com.saevond.sweatyobs.ingest
import org.junit.Assert.*
import org.junit.Test

class MediaRelayGateTest {
  private val v = RtmpMessage(9, 100, 1, byteArrayOf(0x17, 0, 0, 0, 0, 1, 2, 3))
  private val a = RtmpMessage(8, 100, 1, byteArrayOf(0xaf.toByte(), 0, 0x12, 0x10))
  private val key = RtmpMessage(9, 200, 1, byteArrayOf(0x17, 1, 0, 0, 0, 7))
  @Test fun onlyStartsAfterHeadersAndKeyframe() {
    val g = MediaRelayGate()
    assertTrue(g.process(key).isEmpty())
    assertTrue(g.process(v).isEmpty())
    assertTrue(g.process(key).isEmpty())
    assertTrue(g.process(a).isEmpty())
    val out = g.process(key)
    assertEquals(listOf(9,8,9), out.map { it.type })
    assertEquals(listOf(0L,0L,0L), out.map { it.timestamp })
    assertEquals(1L, g.frames)
  }
  @Test fun forwardsAudioAndVideoOnSharedTimeline() {
    val g = MediaRelayGate()
    g.process(v); g.process(a); g.process(key)
    assertEquals(30L, g.process(RtmpMessage(8,230,1,byteArrayOf(0xaf.toByte(),1,2))).single().timestamp)
    assertEquals(40L, g.process(RtmpMessage(9,240,1,byteArrayOf(0x27,1,0))).single().timestamp)
    assertEquals(40L, g.process(RtmpMessage(9,238,1,byteArrayOf(0x27,1,0))).single().timestamp)
  }
  @Test fun rejectsUnsupportedVideoAndAudioPackets() {
    val g = MediaRelayGate()
    assertTrue(g.process(RtmpMessage(9,0,1,byteArrayOf(0x1c,1,2))).isEmpty())
    assertTrue(g.process(RtmpMessage(8,0,1,byteArrayOf(0x20,1,2))).isEmpty())
  }
  @Test fun repeatedIdenticalCodecHeadersDoNotInterruptLiveRelay() {
    val g = MediaRelayGate()
    g.process(v); g.process(a); g.process(key)

    assertTrue(g.process(v.copy(timestamp = 210)).isEmpty())
    assertFalse(g.consumeOutputReconnectRequest())
    assertTrue(g.process(a.copy(timestamp = 215)).isEmpty())
    assertFalse(g.consumeOutputReconnectRequest())
    assertEquals(30L, g.process(RtmpMessage(9,230,1,byteArrayOf(0x27,1,0))).single().timestamp)
  }
  @Test fun changedVideoConfigWaitsForKeyframeAndRequestsOutputReconnect() {
    val g = MediaRelayGate()
    val changed = RtmpMessage(9, 210, 1, byteArrayOf(0x17, 0, 0, 0, 0, 4, 5, 6))
    g.process(v); g.process(a); g.process(key)

    assertTrue(g.process(changed).isEmpty())
    assertTrue(g.consumeOutputReconnectRequest())
    assertFalse(g.consumeOutputReconnectRequest())
    assertTrue(g.process(RtmpMessage(9,220,1,byteArrayOf(0x27,1,0))).isEmpty())

    val resumed = g.process(key.copy(timestamp = 300))
    assertEquals(listOf(9, 8, 9), resumed.map { it.type })
    assertArrayEquals(changed.data, resumed.first().data)
    assertEquals(listOf(1L, 1L, 1L), resumed.map { it.timestamp })
    assertEquals(11L, g.process(RtmpMessage(9,310,1,byteArrayOf(0x27,1,0))).single().timestamp)
  }
  @Test fun changedAudioConfigAlsoRequestsCleanOutputRestart() {
    val g = MediaRelayGate()
    g.process(v); g.process(a); g.process(key)
    val changedAudio = RtmpMessage(8, 210, 1, byteArrayOf(0xaf.toByte(), 0, 0x13, 0x10))

    assertTrue(g.process(changedAudio).isEmpty())
    assertTrue(g.consumeOutputReconnectRequest())
    val resumed = g.process(key.copy(timestamp = 300))
    assertArrayEquals(changedAudio.data, resumed[1].data)
    assertEquals(listOf(1L, 1L, 1L), resumed.map { it.timestamp })
  }
  @Test fun sourceReconnectResetsCodecHeadersButKeepsOutputTimestampsMonotonic() {
    val g = MediaRelayGate()
    g.process(v); g.process(a); g.process(key)
    assertEquals(100L, g.process(RtmpMessage(9,300,1,byteArrayOf(0x27,1,0))).single().timestamp)
    g.resetForSourceReconnect()
    g.process(v.copy(timestamp = 0))
    g.process(a.copy(timestamp = 0))
    val restarted = g.process(key.copy(timestamp = 10))
    assertEquals(listOf(9,8,9), restarted.map { it.type })
    assertEquals(listOf(101L,101L,101L), restarted.map { it.timestamp })
    assertEquals(111L, g.process(RtmpMessage(9,20,1,byteArrayOf(0x27,1,0))).single().timestamp)
  }
}
