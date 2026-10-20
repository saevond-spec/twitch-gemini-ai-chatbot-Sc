package com.saevond.sweatyobs

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import com.saevond.sweatyobs.ingest.RtmpMessage
import java.nio.ByteBuffer

/**
 * Decodes actual game AAC audio, mixes a user-provided rights-cleared PCM track,
 * and encodes new AAC frames for the selected RTMP(S) outputs. No Android system capture.
 *
 * Single-thread ownership: called only on the LAN ingest worker. A new instance
 * must be created per stream. Requires incoming AAC-LC 48kHz stereo; failures
 * abort the public test rather than pretending the music was mixed.
 */
class LiveAacMusicMixer(private val music: MusicTrackLooper, private val volume: MixLevels = MixLevels()) : AutoCloseable {
  private var decoder: MediaCodec? = null
  private var encoder: MediaCodec? = null
  private var hasOutputConfig = false
  private var lastTimestamp = 0L
  var mixedPackets: Long = 0L
    private set
  var audioOutputPackets: Long = 0L
    private set

  companion object {
    /** AudioSpecificConfig for MPEG-4 AAC LC, 48 kHz stereo, as used by the mixer. */
    fun supportedAudioSpecificConfig(data: ByteArray): Boolean {
      if (data.size < 4 || (data[0].toInt() and 0xf0) != 0xa0 ||
          (data[1].toInt() and 255) != 0) return false
      val first = data[2].toInt() and 255
      val second = data[3].toInt() and 255
      val objectType = first shr 3
      val frequencyIndex = ((first and 7) shl 1) or (second shr 7)
      val channels = (second shr 3) and 15
      return objectType == 2 && frequencyIndex == 3 && channels == 2
    }
  }

  fun onAudio(message: RtmpMessage): List<RtmpMessage> {
    require(message.type == 8)
    val data = message.data
    require(data.size >= 3 && (data[0].toInt() and 255) == 0xaf) {
      "Only stereo AAC audio is supported for live music mixing"
    }
    if (data[1].toInt() == 0) {
      require(supportedAudioSpecificConfig(data)) {
        "Music mixing needs game AAC-LC 48 kHz stereo; incompatible PS5 audio"
      }
      check(decoder == null) { "Incoming game codec changed during live stream" }
      startCodecs(data.copyOfRange(2, data.size))
      return drainEncoder()
    }
    require(data[1].toInt() == 1 && decoder != null && encoder != null) {
      "Raw game AAC audio received before compatible codec headers"
    }

    val codec = decoder ?: error("Decoder not initialized")
    val index = codec.dequeueInputBuffer(15_000)
    check(index >= 0) { "Game AAC decoder backpressure; stopping instead of dropping audio" }
    val buffer = codec.getInputBuffer(index) ?: error("Missing game audio input")
    val size = data.size - 2
    check(size > 0 && size <= buffer.capacity()) { "Invalid AAC packet length" }
    buffer.clear()
    buffer.put(data, 2, size)
    codec.queueInputBuffer(index, 0, size, message.timestamp * 1000L, 0)

    val info = MediaCodec.BufferInfo()
    repeat(16) {
      when (val result = codec.dequeueOutputBuffer(info, 1_000)) {
        MediaCodec.INFO_TRY_AGAIN_LATER -> return@repeat
        MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          val format = codec.outputFormat
          check(format.getInteger(MediaFormat.KEY_SAMPLE_RATE) == 48000 &&
            format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) == 2) {
            "Game audio format changed: only 48k stereo supported"
          }
          if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
            check(format.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_16BIT) {
              "Game AAC decoder returned non-16bit PCM"
            }
          }
        }
        in 0..Int.MAX_VALUE -> {
          try {
            if (info.size > 0) {
              val raw = ByteArray(info.size)
              val output = codec.getOutputBuffer(result) ?: error("Missing game PCM")
              output.position(info.offset)
              output.limit(info.offset + info.size)
              output.get(raw)
              check(raw.size % 4 == 0 && raw.size <= 131072) { "Invalid PCM frame" }
              val playing = music.playing && music.ready
              val (gameGain, musicGain) = volume.gains(playing)
              // All coefficients are bounded so their worst-case sum stays under unity.
              val pcm = PcmMixer.mix(raw,
                if (playing && musicGain > 0.0) music.nextWindow(raw.size) else ByteArray(raw.size),
                gameGain, musicGain)
              val audioEncoder = encoder ?: error("Encoder unavailable")
              val writable = audioEncoder.dequeueInputBuffer(20_000)
              check(writable >= 0) { "AAC encoder backpressure" }
              val input = audioEncoder.getInputBuffer(writable) ?: error("Missing AAC encoder input")
              check(input.capacity() >= pcm.size) { "AAC encoder input too small" }
              input.clear()
              input.put(pcm)
              audioEncoder.queueInputBuffer(writable, 0, pcm.size, info.presentationTimeUs, 0)
              mixedPackets++
            }
          } finally {
            codec.releaseOutputBuffer(result, false)
          }
        }
      }
    }
    return drainEncoder()
  }

  private fun startCodecs(asc: ByteArray) {
    var d: MediaCodec? = null
    var e: MediaCodec? = null
    try {
      val inFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 48000, 2)
      inFormat.setByteBuffer("csd-0", ByteBuffer.wrap(asc))
      d = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
      d.configure(inFormat, null, null, 0)
      d.start()
      val outFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 48000, 2)
      outFormat.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      outFormat.setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
      outFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 32768)
      e = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
      e.configure(outFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      e.start()
      decoder = d
      encoder = e
    } catch (error: Exception) {
      runCatching { d?.stop() }
      runCatching { d?.release() }
      runCatching { e?.stop() }
      runCatching { e?.release() }
      throw error
    }
  }

  private fun drainEncoder(): List<RtmpMessage> {
    val codec = encoder ?: return emptyList()
    val packets = mutableListOf<RtmpMessage>()
    val info = MediaCodec.BufferInfo()
    repeat(24) {
      when (val result = codec.dequeueOutputBuffer(info, 0)) {
        MediaCodec.INFO_TRY_AGAIN_LATER -> return packets
        MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          val config = codec.outputFormat.getByteBuffer("csd-0")
            ?: error("Encoder AAC config missing")
          val bytes = ByteArray(config.remaining())
          config.get(bytes)
          check(bytes.size in 2..8)
          check(!hasOutputConfig)
          hasOutputConfig = true
          packets.add(RtmpMessage(8, 0, 1, byteArrayOf(0xaf.toByte(), 0) + bytes))
        }
        in 0..Int.MAX_VALUE -> {
          try {
            if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
              check(hasOutputConfig) { "AAC frame produced before codec config" }
              val out = codec.getOutputBuffer(result) ?: error("Missing AAC output buffer")
              out.position(info.offset)
              out.limit(info.offset + info.size)
              val bytes = ByteArray(info.size)
              out.get(bytes)
              val ts = (info.presentationTimeUs / 1000L).coerceAtLeast(lastTimestamp)
              lastTimestamp = ts
              packets.add(RtmpMessage(8, ts, 1, byteArrayOf(0xaf.toByte(), 1) + bytes))
              audioOutputPackets++
            }
          } finally {
            codec.releaseOutputBuffer(result, false)
          }
        }
      }
    }
    return packets
  }

  override fun close() {
    val d = decoder; decoder = null
    val e = encoder; encoder = null
    runCatching { d?.stop() }
    runCatching { d?.release() }
    runCatching { e?.stop() }
    runCatching { e?.release() }
  }
}
