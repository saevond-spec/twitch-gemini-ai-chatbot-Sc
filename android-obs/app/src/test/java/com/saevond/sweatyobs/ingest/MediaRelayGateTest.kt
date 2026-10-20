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
  @Test fun rejectsUnsupportedVideoAudioAndCodecChange() {
    val g = MediaRelayGate()
    assertTrue(g.process(RtmpMessage(9,0,1,byteArrayOf(0x1c,1,2))).isEmpty())
    assertTrue(g.process(RtmpMessage(8,0,1,byteArrayOf(0x20,1,2))).isEmpty())
    g.process(v);g.process(a);g.process(key)
    try { g.process(a); fail("codec change should stop relay") } catch (_: IllegalStateException) {}
  }
}
