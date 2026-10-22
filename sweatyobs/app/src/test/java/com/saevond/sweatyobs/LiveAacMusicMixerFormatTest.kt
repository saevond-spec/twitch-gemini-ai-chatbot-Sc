package com.saevond.sweatyobs
import org.junit.Assert.*
import org.junit.Test

class LiveAacMusicMixerFormatTest {
 @Test fun onlyAacLcStereo48000IsAccepted() {
   assertTrue(LiveAacMusicMixer.supportedAudioSpecificConfig(byteArrayOf(0xaf.toByte(),0,0x11,0x90.toByte())))
   assertFalse(LiveAacMusicMixer.supportedAudioSpecificConfig(byteArrayOf(0xaf.toByte(),0,0x12,0x10))) // 44.1 kHz stereo
   assertFalse(LiveAacMusicMixer.supportedAudioSpecificConfig(byteArrayOf(0xaf.toByte(),0,0x11,0x88.toByte()))) // mono
   assertFalse(LiveAacMusicMixer.supportedAudioSpecificConfig(byteArrayOf(0xaf.toByte(),1,0x11,0x90.toByte())))
 }

 @Test fun repeatedAudioHeadersAreDistinguishedFromRealCodecChanges() {
   val first = byteArrayOf(0x11, 0x90.toByte())
   assertEquals(AudioSpecificConfigChange.INITIAL, classifyAudioSpecificConfig(null, first))
   assertEquals(AudioSpecificConfigChange.IDENTICAL,
     classifyAudioSpecificConfig(first, first.copyOf()))
   assertEquals(AudioSpecificConfigChange.DIFFERENT,
     classifyAudioSpecificConfig(first, byteArrayOf(0x12, 0x10)))
 }
}
