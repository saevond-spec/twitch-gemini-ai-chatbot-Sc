package com.saevond.sweatyobs

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import com.saevond.sweatyobs.ingest.RtmpMessage
import kotlin.math.sin

/** Runs actual Android AAC encoder -> live mixer -> Android AAC encoder on emulator. */
@RunWith(AndroidJUnit4::class)
class LicensedMusicCodecSmokeTest {
  @Test fun gameAacIsDecodedMusicMixedAndReencodedToAac() {
    val music = MusicTrackLooper()
    // Synthetic licensed-safe fixture, not a copyrighted track: 440 Hz tone.
    val sample = ByteArray(48_000 * 4)
    for (i in 0 until 48_000) {
      val s = (sin(2.0 * Math.PI * 440.0 * i / 48_000) * 9000).toInt().toShort()
      sample[4*i] = s.toByte()
      sample[4*i+1] = (s.toInt() shr 8).toByte()
      sample[4*i+2] = s.toByte()
      sample[4*i+3] = (s.toInt() shr 8).toByte()
    }
    music.load(sample)
    music.command("play")
    val mixer = LiveAacMusicMixer(music)
    val upstream = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    val fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 48000, 2)
    fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
    fmt.setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
    upstream.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    upstream.start()
    val packetTypes = mutableListOf<Int>()
    val info = MediaCodec.BufferInfo()
    try {
      var configFound = false
      repeat(42) { frame ->
        val idx = upstream.dequeueInputBuffer(60_000)
        assertTrue("Test encoder blocked", idx >= 0)
        val pcm = ByteArray(4096) // blank gameplay so the output is music only
        upstream.getInputBuffer(idx)!!.apply { clear(); put(pcm) }
        upstream.queueInputBuffer(idx,0,pcm.size,frame * 1024L * 1_000_000L / 48_000L,0)
        repeat(12) {
          when (val outIdx = upstream.dequeueOutputBuffer(info,3_000)) {
            MediaCodec.INFO_TRY_AGAIN_LATER -> return@repeat
            MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              val asc = upstream.outputFormat.getByteBuffer("csd-0")!!
              val config = ByteArray(asc.remaining())
              asc.get(config)
              mixer.onAudio(RtmpMessage(8,0,1,byteArrayOf(0xaf.toByte(),0) + config))
              configFound = true
            }
            in 0..Int.MAX_VALUE -> {
              try {
                if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                  val bytes = ByteArray(info.size)
                  upstream.getOutputBuffer(outIdx)!!.apply {
                    position(info.offset); limit(info.offset + info.size)
                  }.get(bytes)
                  val output = mixer.onAudio(RtmpMessage(8,info.presentationTimeUs/1000L,1,
                    byteArrayOf(0xaf.toByte(),1) + bytes))
                  packetTypes.addAll(output.map { it.data[1].toInt() and 255 })
                }
              } finally { upstream.releaseOutputBuffer(outIdx,false) }
            }
          }
        }
      }
      assertTrue("Game codec config missing", configFound)
      assertTrue("Mixer never decoded game audio", mixer.mixedPackets > 5)
      assertTrue("Mixer never encoded AAC music", mixer.audioOutputPackets > 5)
      assertTrue("Missing output AAC codec config", 0 in packetTypes)
      assertTrue("Missing actual encoded AAC audio frames", 1 in packetTypes)
    } finally {
      mixer.close()
      upstream.stop()
      upstream.release()
      music.clear()
    }
  }
}
