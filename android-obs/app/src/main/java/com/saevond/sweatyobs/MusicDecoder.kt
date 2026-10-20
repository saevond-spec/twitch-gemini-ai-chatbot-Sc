package com.saevond.sweatyobs

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.ByteArrayOutputStream
import kotlin.math.floor
import kotlin.math.min

/**
 * Decodes a user-selected, rights-cleared audio track. PCM is capped at 5 minutes
 * and ~60 MB before resampling, to prevent arbitrary remote files exhausting memory.
 * No network downloads, no DRM bypass, no YouTube extraction.
 */
class MusicDecoder(private val context: Context) {
  fun decode(uri: Uri): ByteArray {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      extractor.setDataSource(context, uri, null)
      var track = -1
      var mime = ""
      for (index in 0 until extractor.trackCount) {
        val type = extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME) ?: ""
        if (type.startsWith("audio/")) { track = index; mime = type; break }
      }
      require(track >= 0) { "No supported audio track" }
      extractor.selectTrack(track)
      val sourceFormat = extractor.getTrackFormat(track)
      var sampleRate = sourceFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channels = sourceFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      require(sampleRate in 8000..96000 && channels in 1..2) { "Only mono/stereo audio at 8-96 kHz is supported" }
      codec = MediaCodec.createDecoderByType(mime)
      codec.configure(sourceFormat, null, null, 0)
      codec.start()
      val out = ByteArrayOutputStream()
      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var outputDone = false
      val maxDecodedBytes = 60 * 1024 * 1024
      val deadlineNs = System.nanoTime() + 30_000_000_000L
      while (!outputDone) {
        check(System.nanoTime() < deadlineNs) { "Audio decoding timed out" }
        if (!inputDone) {
          val index = codec.dequeueInputBuffer(10_000)
          if (index >= 0) {
            val input = codec.getInputBuffer(index) ?: throw IllegalStateException("Missing decoder input")
            input.clear()
            val size = extractor.readSampleData(input, 0)
            if (size < 0) {
              codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }
        when (val index = codec.dequeueOutputBuffer(info, 10_000)) {
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val format = codec.outputFormat
            sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val encoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING))
              format.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
            require(encoding == AudioFormat.ENCODING_PCM_16BIT && sampleRate in 8000..96000 && channels in 1..2) {
              "Decoder must output 16-bit mono/stereo PCM"
            }
          }
          in 0..Int.MAX_VALUE -> {
            if (info.size > 0) {
              require(out.size() + info.size <= maxDecodedBytes) { "Track exceeds 5-minute memory budget" }
              val bytes = ByteArray(info.size)
              (codec.getOutputBuffer(index) ?: throw IllegalStateException("Missing decoder output"))
                .apply { position(info.offset); limit(info.offset + info.size) }.get(bytes)
              out.write(bytes)
            }
            outputDone = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            codec.releaseOutputBuffer(index, false)
          }
        }
      }
      return resampleStereo48k(out.toByteArray(), sampleRate, channels)
    } finally {
      runCatching { codec?.stop() }
      runCatching { codec?.release() }
      extractor.release()
    }
  }

  companion object {
    fun resampleStereo48k(raw: ByteArray, sampleRate: Int, channels: Int): ByteArray {
      require(channels == 1 || channels == 2)
      require(sampleRate in 8000..96000)
      require(raw.size % (channels * 2) == 0)
      val frames = raw.size / (channels * 2)
      if (frames == 0) return ByteArray(0)
      val outputFrames = (frames.toLong() * 48000 / sampleRate).toInt()
      require(outputFrames <= 48000 * 300) { "Decoded music is too long" }
      val result = ByteArray(outputFrames * 4)
      for (frame in 0 until outputFrames) {
        val position = frame.toDouble() * sampleRate / 48000.0
        val first = floor(position).toInt().coerceAtMost(frames - 1)
        val second = min(first + 1, frames - 1)
        val ratio = position - first
        for (channel in 0..1) {
          val sourceChannel = if (channels == 1) 0 else channel
          val a = read16(raw, (first * channels + sourceChannel) * 2)
          val b = read16(raw, (second * channels + sourceChannel) * 2)
          val sample = (a + (b - a) * ratio).toInt().coerceIn(-32768, 32767)
          val offset = frame * 4 + channel * 2
          result[offset] = sample.toByte()
          result[offset + 1] = (sample shr 8).toByte()
        }
      }
      return result
    }
    private fun read16(data: ByteArray, offset: Int): Int =
      (((data[offset + 1].toInt() and 255) shl 8) or (data[offset].toInt() and 255)).toShort().toInt()
  }
}
