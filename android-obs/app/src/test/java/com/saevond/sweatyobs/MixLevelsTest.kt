package com.saevond.sweatyobs
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.abs
class MixLevelsTest {
  @Test fun normalizationBoundsEveryPossibleAudioPeak() {
    for (game in 0..100 step 5) for (music in 0..100 step 5) {
      val levels = MixLevels(game, music)
      val (a,b)=levels.gains(true)
      assertTrue(a >= 0.0 && b >= 0.0)
      assertTrue("gain sum exceeded headroom", a+b <= 0.98000000000001)
      val intense = ByteArray(4000){ 0x7f }
      val output=PcmMixer.mix(intense,intense,a,b)
      assertEquals(intense.size,output.size)
    }
  }
  @Test fun fullScaleGameAndMusicDoNotClip() {
    val levels=MixLevels(100,100)
    val (game,music)=levels.gains(true)
    val fullPos=byteArrayOf(0xff.toByte(),0x7f)
    val fullNeg=byteArrayOf(0x00,0x80.toByte())
    val out=PcmMixer.mix(fullPos+fullNeg,fullPos+fullNeg,game,music)
    val a=((out[1].toInt() shl 8) or (out[0].toInt() and 255)).toShort().toInt()
    val b=((out[3].toInt() shl 8) or (out[2].toInt() and 255)).toShort().toInt()
    assertTrue(a in 32000..32200)
    assertTrue(b in -32200..-32000)
  }
  @Test fun independentMuteAndPause() {
    val levels=MixLevels(80,60)
    assertEquals(0.0,levels.gains(false).second,0.0)
    val (g,m)=levels.gains(true)
    assertTrue(g+m<=.98)
    levels.update(0,100)
    assertEquals(0.0,levels.gains(true).first,0.0)
    assertTrue(levels.gains(true).second>0.9)
  }
  @Test fun invalidLiveGainUpdateFailsClosed() {
    val levels=MixLevels()
    try{ levels.update(101,10);fail("invalid gain") }catch(_: IllegalArgumentException){}
    assertEquals(85,levels.gamePercent)
  }
}
