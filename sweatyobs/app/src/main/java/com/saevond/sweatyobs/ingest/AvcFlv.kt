package com.saevond.sweatyobs.ingest

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** AVC configuration and packet helpers for FLV/RTMP video tags. */
internal data class AvcFlvConfig(
  val nalLengthBytes: Int,
  val sps: ByteArray,
  val pps: ByteArray,
  val width: Int,
  val height: Int
)

internal object AvcFlv {
  private val startCode = byteArrayOf(0, 0, 0, 1)

  fun parseConfig(message: RtmpMessage): AvcFlvConfig {
    require(message.type == 9 && message.data.size >= 16)
    val data = message.data
    require((data[0].toInt() and 15) == 7 && (data[1].toInt() and 255) == 0)
    var offset = 5
    require((data[offset++].toInt() and 255) == 1) { "Unsupported AVC configuration record" }
    offset += 3 // profile, compatibility, level
    val nalLengthBytes = (data[offset++].toInt() and 3) + 1
    val spsCount = data[offset++].toInt() and 31
    require(spsCount in 1..31)
    val spsList = ArrayList<ByteArray>(spsCount)
    repeat(spsCount) {
      require(offset + 2 <= data.size)
      val length = u16(data, offset); offset += 2
      require(length in 4..65_536 && offset + length <= data.size)
      spsList += data.copyOfRange(offset, offset + length)
      offset += length
    }
    require(offset < data.size)
    val ppsCount = data[offset++].toInt() and 255
    require(ppsCount in 1..31)
    val ppsList = ArrayList<ByteArray>(ppsCount)
    repeat(ppsCount) {
      require(offset + 2 <= data.size)
      val length = u16(data, offset); offset += 2
      require(length in 1..65_536 && offset + length <= data.size)
      ppsList += data.copyOfRange(offset, offset + length)
      offset += length
    }
    val sps = spsList.first()
    val pps = ppsList.first()
    val dimensions = H264Sps.dimensions(sps)
    require(dimensions.first in 16..7680 && dimensions.second in 16..4320)
    return AvcFlvConfig(nalLengthBytes, sps, pps, dimensions.first, dimensions.second)
  }

  /** Returns a copy of the AVC NAL-unit sample, or null for an empty/end tag. */
  fun sample(message: RtmpMessage, config: AvcFlvConfig): ByteArray? {
    if (message.type != 9 || message.data.size < 6) return null
    if ((message.data[0].toInt() and 15) != 7 || (message.data[1].toInt() and 255) != 1) return null
    val source = message.data
    val out = ByteArrayOutputStream(source.size + 16)
    var offset = 5
    var count = 0
    while (offset < source.size) {
      require(offset + config.nalLengthBytes <= source.size) { "Truncated AVC NAL length" }
      var length = 0
      repeat(config.nalLengthBytes) { length = (length shl 8) or (source[offset++].toInt() and 255) }
      require(length in 1..source.size - offset) { "Invalid AVC NAL length" }
      out.write(startCode)
      out.write(source, offset, length)
      offset += length
      count++
      require(count <= 256) { "Too many AVC NAL units in one frame" }
    }
    return out.toByteArray().takeIf { it.isNotEmpty() }
  }

  fun decoderConfig(message: RtmpMessage, config: AvcFlvConfig): Pair<ByteArray, ByteArray> {
    // Android's decoder accepts Annex-B codec-specific data with a four-byte prefix.
    return (startCode + config.sps) to (startCode + config.pps)
  }

  fun encoderConfig(sps: ByteArray, pps: ByteArray): ByteArray {
    require(sps.size in 4..65_535 && pps.size in 1..65_535)
    val out = ByteArrayOutputStream(11 + sps.size + pps.size)
    out.write(byteArrayOf(1, sps[1], sps[2], sps[3], 0xff.toByte(), 0xe1.toByte()))
    out.write(u16Bytes(sps.size)); out.write(sps)
    out.write(1); out.write(u16Bytes(pps.size)); out.write(pps)
    return out.toByteArray()
  }

  /** Convert Android encoder output (Annex-B or AVCC) into an FLV AVC access unit. */
  fun toFlvFrame(sample: ByteArray, keyframe: Boolean, timestampMs: Long, streamId: Int = 1): RtmpMessage {
    val nals = splitNals(sample)
    require(nals.isNotEmpty() && nals.all { it.size <= 2_097_152 })
    val payload = ByteArrayOutputStream(sample.size + nals.size * 4 + 5)
    payload.write(if (keyframe) 0x17 else 0x27)
    payload.write(1) // AVC NALU packet
    payload.write(byteArrayOf(0, 0, 0)) // composition time; encoder is configured without B-frames
    for (nal in nals) {
      payload.write(ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(nal.size).array())
      payload.write(nal)
    }
    return RtmpMessage(9, timestampMs.coerceAtLeast(0L), streamId, payload.toByteArray())
  }

  fun splitNals(data: ByteArray): List<ByteArray> {
    val starts = ArrayList<Pair<Int, Int>>()
    var i = 0
    while (i + 3 < data.size) {
      val length = when {
        data[i] == 0.toByte() && data[i + 1] == 0.toByte() && data[i + 2] == 0.toByte() && data[i + 3] == 1.toByte() -> 4
        data[i] == 0.toByte() && data[i + 1] == 0.toByte() && data[i + 2] == 1.toByte() -> 3
        else -> 0
      }
      if (length > 0) { starts += i to length; i += length } else i++
    }
    if (starts.isNotEmpty()) {
      return starts.mapIndexedNotNull { index, (start, length) ->
        val end = starts.getOrNull(index + 1)?.first ?: data.size
        if (end <= start + length) null else data.copyOfRange(start + length, end)
      }.filter { it.isNotEmpty() }
    }
    // MediaCodec may emit AVCC access units with four-byte big-endian lengths.
    val avcc = ArrayList<ByteArray>()
    var offset = 0
    while (offset + 4 <= data.size) {
      val size = ByteBuffer.wrap(data, offset, 4).order(ByteOrder.BIG_ENDIAN).int
      offset += 4
      if (size <= 0 || size > data.size - offset) { avcc.clear(); break }
      avcc += data.copyOfRange(offset, offset + size)
      offset += size
    }
    if (avcc.isNotEmpty() && offset == data.size) return avcc
    // A single raw NAL unit is valid encoder output too.
    return if (data.isNotEmpty()) listOf(data.copyOf()) else emptyList()
  }

  private fun u16(data: ByteArray, offset: Int): Int =
    ((data[offset].toInt() and 255) shl 8) or (data[offset + 1].toInt() and 255)

  private fun u16Bytes(value: Int) = byteArrayOf((value shr 8).toByte(), value.toByte())
}

/** Minimal bounded H.264 SPS parser used only to size the decoder surface. */
private object H264Sps {
  fun dimensions(nal: ByteArray): Pair<Int, Int> {
    require(nal.size >= 4 && (nal[0].toInt() and 31) == 7)
    val rbsp = ByteArrayOutputStream(nal.size)
    var zeros = 0
    for (i in 1 until nal.size) {
      val value = nal[i].toInt() and 255
      if (zeros >= 2 && value == 3) { zeros = 0; continue }
      rbsp.write(value)
      zeros = if (value == 0) zeros + 1 else 0
    }
    val bits = BitReader(rbsp.toByteArray())
    val profile = bits.read(8)
    bits.read(8); bits.read(8); bits.ue() // constraint flags, level, seq id
    var chroma = 1
    var separateColourPlane = false
    if (profile in setOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)) {
      chroma = bits.ue()
      require(chroma in 0..3)
      if (chroma == 3) separateColourPlane = bits.read(1) == 1
      bits.ue(); bits.ue(); bits.read(1)
      if (bits.read(1) == 1) {
        repeat(if (chroma == 3) 12 else 8) { index ->
          if (bits.read(1) == 1) skipScalingList(bits, if (index < 6) 16 else 64)
        }
      }
    }
    bits.ue() // log2_max_frame_num_minus4
    when (bits.ue()) {
      0 -> bits.ue()
      1 -> { bits.read(1); bits.se(); bits.se(); repeat(bits.ue().coerceAtMost(255)) { bits.se() } }
    }
    bits.ue(); bits.read(1)
    val widthMbs = bits.ue() + 1
    val heightMapUnits = bits.ue() + 1
    val frameOnly = bits.read(1)
    if (frameOnly == 0) bits.read(1)
    bits.read(1)
    val crop = if (bits.read(1) == 1) intArrayOf(bits.ue(), bits.ue(), bits.ue(), bits.ue()) else intArrayOf(0,0,0,0)
    val frameHeight = 2 - frameOnly
    val codedWidth = widthMbs * 16
    val codedHeight = heightMapUnits * 16 * frameHeight
    val chromaArray = if (separateColourPlane) 0 else chroma
    val subWidth = if (chromaArray == 1 || chromaArray == 2) 2 else 1
    val subHeight = if (chromaArray == 1) 2 else 1
    val cropUnitX = if (chromaArray == 0) 1 else subWidth
    val cropUnitY = if (chromaArray == 0) frameHeight else subHeight * frameHeight
    val width = codedWidth - (crop[0] + crop[1]) * cropUnitX
    val height = codedHeight - (crop[2] + crop[3]) * cropUnitY
    require(width > 0 && height > 0)
    return width to height
  }

  private fun skipScalingList(bits: BitReader, count: Int) {
    var last = 8
    var next = 8
    repeat(count) {
      if (next != 0) next = (last + bits.se() + 256) % 256
      last = if (next == 0) last else next
    }
  }

  private class BitReader(private val data: ByteArray) {
    private var position = 0
    fun read(count: Int): Int {
      require(count in 0..32 && position + count <= data.size * 8)
      var value = 0
      repeat(count) {
        value = (value shl 1) or ((data[position / 8].toInt() ushr (7 - position % 8)) and 1)
        position++
      }
      return value
    }
    fun ue(): Int {
      var zeros = 0
      while (read(1) == 0) { require(++zeros <= 31) }
      return if (zeros == 0) 0 else ((1 shl zeros) - 1) + read(zeros)
    }
    fun se(): Int {
      val value = ue()
      return if (value % 2 == 0) -(value / 2) else (value + 1) / 2
    }
  }
}
