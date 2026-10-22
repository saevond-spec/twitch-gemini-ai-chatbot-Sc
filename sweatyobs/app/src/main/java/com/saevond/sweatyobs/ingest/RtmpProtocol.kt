package com.saevond.sweatyobs.ingest

import java.io.EOFException
import java.io.FilterInputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom

data class RtmpMessage(val type: Int, val timestamp: Long, val streamId: Int, val data: ByteArray)

/** Counts inbound RTMP bytes for protocol acknowledgements without retaining media or payloads. */
internal class CountingInputStream(input: InputStream) : FilterInputStream(input) {
  @Volatile var bytesRead: Long = 0L
    private set

  override fun read(): Int {
    val value = super.read()
    if (value >= 0) bytesRead++
    return value
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    val count = super.read(buffer, offset, length)
    if (count > 0) bytesRead += count
    return count
  }
}

internal fun InputStream.readRequired(length: Int): ByteArray {
  require(length in 0..4_194_304)
  val result = ByteArray(length)
  var pos = 0
  while (pos < length) {
    val count = read(result, pos, length - pos)
    if (count <= 0) throw EOFException("RTMP peer disconnected")
    pos += count
  }
  return result
}
internal fun be24(v: ByteArray, start: Int) =
  ((v[start].toInt() and 255) shl 16) or ((v[start + 1].toInt() and 255) shl 8) or (v[start + 2].toInt() and 255)
internal fun be32(v: ByteArray) = ByteBuffer.wrap(v).order(ByteOrder.BIG_ENDIAN).int
private fun bytes24(value: Int) = byteArrayOf((value shr 16).toByte(), (value shr 8).toByte(), value.toByte())
private fun bytes32(value: Int) = byteArrayOf((value shr 24).toByte(), (value shr 16).toByte(), (value shr 8).toByte(), value.toByte())

fun rtmpHandshake(input: InputStream, output: OutputStream, random: SecureRandom = SecureRandom()) {
  if (input.read() != 3) throw IllegalArgumentException("Only RTMP version 3 supported")
  val c1 = input.readRequired(1536)
  val s1 = ByteArray(1536)
  random.nextBytes(s1)
  val now = (System.currentTimeMillis() / 1000).toInt()
  bytes32(now).copyInto(s1, 0)
  s1.fill(0, 4, 8)
  output.write(3)
  output.write(s1)
  output.write(c1)
  output.flush()
  input.readRequired(1536) // C2
}

/** Bounded RTMP chunk reassembler. Only one ongoing message per chunk stream ID. */
class RtmpChunkReader(private val input: InputStream) {
  private data class Channel(
    var timestamp: Long = 0, var delta: Long = 0, var length: Int = 0,
    var type: Int = 0, var streamId: Int = 0, var extended: Boolean = false,
    var buffer: ByteArrayOutputStream = ByteArrayOutputStream(),
    var initialized: Boolean = false, var lastFmt: Int = 0
  )
  private val channels = HashMap<Int, Channel>()
  private var chunkSize = 128

  fun nextMessage(): RtmpMessage {
    while (true) {
      val first = input.read()
      if (first < 0) throw EOFException("RTMP disconnected")
      val fmt = first shr 6
      val rawId = first and 63
      val csid = when (rawId) {
        0 -> 64 + input.readRequired(1)[0].toUByte().toInt()
        1 -> { val ext = input.readRequired(2); 64 + (ext[0].toInt() and 255) + ((ext[1].toInt() and 255) shl 8) }
        else -> rawId
      }
      if (csid < 2 || csid > 65599) throw IllegalArgumentException("Invalid chunk stream")
      val c = channels.getOrPut(csid) {
        if (channels.size >= 64) throw IllegalArgumentException("Too many RTMP chunk streams")
        Channel()
      }
      if (fmt != 0 && !c.initialized) throw IllegalArgumentException("Missing RTMP prior chunk header")
      val continuing = c.buffer.size() > 0 && c.buffer.size() < c.length
      if (continuing && fmt != 3) throw IllegalArgumentException("RTMP interleaving error")
      var stampField = 0
      when (fmt) {
        0 -> {
          stampField = be24(input.readRequired(3), 0)
          c.length = be24(input.readRequired(3), 0)
          c.type = input.readRequired(1)[0].toInt() and 255
          c.streamId = ByteBuffer.wrap(input.readRequired(4)).order(ByteOrder.LITTLE_ENDIAN).int
          c.extended = stampField == 0xffffff
          c.delta = 0
          c.buffer.reset()
        }
        1 -> {
          stampField = be24(input.readRequired(3), 0)
          c.length = be24(input.readRequired(3), 0)
          c.type = input.readRequired(1)[0].toInt() and 255
          c.extended = stampField == 0xffffff
          c.buffer.reset()
        }
        2 -> {
          stampField = be24(input.readRequired(3), 0)
          c.extended = stampField == 0xffffff
          c.buffer.reset()
        }
        3 -> if (!continuing) c.buffer.reset()
      }
      if (c.length < 0 || c.length > 2_097_152) throw IllegalArgumentException("RTMP payload too large")
      val extendedValue = if (c.extended) be32(input.readRequired(4)).toLong() and 0xffffffffL else 0L
      if (fmt == 0) c.timestamp = if (c.extended) extendedValue else stampField.toLong()
      else if (fmt == 1 || fmt == 2) {
        c.delta = if (c.extended) extendedValue else stampField.toLong()
        c.timestamp += c.delta
      } else if (!continuing) c.timestamp += c.delta
      c.initialized = true
      c.lastFmt = fmt
      val needed = c.length - c.buffer.size()
      if (needed < 0) throw IllegalArgumentException("RTMP message overflow")
      c.buffer.write(input.readRequired(minOf(chunkSize, needed)))
      if (c.buffer.size() == c.length) {
        val message = RtmpMessage(c.type, c.timestamp, c.streamId, c.buffer.toByteArray())
        c.buffer.reset()
        if (message.type == 1 && message.data.size >= 4) {
          val value = be32(message.data) and 0x7fffffff
          if (value !in 1..65536) throw IllegalArgumentException("Invalid RTMP chunk size")
          chunkSize = value
        }
        return message
      }
    }
  }
}

fun amfString(value: String): ByteArray {
  val utf8 = value.toByteArray(Charsets.UTF_8)
  require(utf8.size < 65536)
  return byteArrayOf(2, (utf8.size shr 8).toByte(), utf8.size.toByte()) + utf8
}
fun amfNumber(value: Double) = byteArrayOf(0) +
  ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putDouble(value).array()
fun amfNull() = byteArrayOf(5)
fun amfObject(vararg entries: Pair<String, ByteArray>): ByteArray {
  val out = ByteArrayOutputStream()
  out.write(3)
  for ((name, value) in entries) {
    val bytes = name.toByteArray(Charsets.UTF_8)
    require(bytes.size < 65536)
    out.write(byteArrayOf((bytes.size shr 8).toByte(), bytes.size.toByte()))
    out.write(bytes)
    out.write(value)
  }
  out.write(byteArrayOf(0, 0, 9))
  return out.toByteArray()
}

class RtmpAmf0Reader(private val data: ByteArray) {
  private var offset = 0
  private fun requireBytes(count: Int) { require(count >= 0 && offset + count <= data.size) { "Truncated AMF command" } }
  fun string(): String {
    requireBytes(3)
    require(data[offset++].toInt() == 2) { "Expected AMF string" }
    val length = ((data[offset++].toInt() and 255) shl 8) or (data[offset++].toInt() and 255)
    requireBytes(length)
    val value = String(data, offset, length, Charsets.UTF_8)
    offset += length
    return value
  }
  fun number(): Double {
    requireBytes(9)
    require(data[offset++].toInt() == 0) { "Expected AMF number" }
    val value = ByteBuffer.wrap(data, offset, 8).order(ByteOrder.BIG_ENDIAN).double
    offset += 8
    return value
  }
  // Skip AMF0 objects, numbers and nulls without executing or trusting their fields.
  fun skip(depth: Int = 0) {
    require(depth < 8) { "AMF nesting too deep" }
    requireBytes(1)
    when (val kind = data[offset++].toInt() and 255) {
      0 -> { requireBytes(8); offset += 8 }
      1 -> { requireBytes(1); offset++ }
      2 -> { requireBytes(2); val size = ((data[offset++].toInt() and 255) shl 8) or (data[offset++].toInt() and 255); requireBytes(size); offset += size }
      3, 8 -> {
        if (kind == 8) { requireBytes(4); offset += 4 }
        var count = 0
        while (true) {
          requireBytes(3)
          if (data[offset] == 0.toByte() && data[offset + 1] == 0.toByte() && data[offset + 2] == 9.toByte()) {
            offset += 3; return
          }
          val size = ((data[offset++].toInt() and 255) shl 8) or (data[offset++].toInt() and 255)
          requireBytes(size)
          offset += size
          skip(depth + 1)
          require(++count <= 256) { "Too many AMF object keys" }
        }
      }
      5, 6 -> {}
      10 -> {
        requireBytes(4)
        val amount = be32(data.copyOfRange(offset, offset + 4))
        offset += 4
        require(amount in 0..256)
        repeat(amount) { skip(depth + 1) }
      }
      11 -> { requireBytes(10); offset += 10 }
      12 -> {
        requireBytes(4)
        val amount = be32(data.copyOfRange(offset, offset + 4))
        offset += 4; require(amount in 0..65536); requireBytes(amount); offset += amount
      }
      else -> throw IllegalArgumentException("Unsupported AMF type " + kind)
    }
  }
  /** Parse an AMF0 status object and return the selected string field, fail-closed. */
  fun objectStringField(target: String): String? {
    requireBytes(1)
    val marker = data[offset++].toInt() and 255
    require(marker == 3 || marker == 8) { "Expected AMF status object" }
    if (marker == 8) { requireBytes(4); offset += 4 }
    repeat(128) {
      requireBytes(3)
      if (data[offset] == 0.toByte() && data[offset + 1] == 0.toByte() &&
        data[offset + 2] == 9.toByte()) {
        offset += 3
        return null
      }
      val length = ((data[offset++].toInt() and 255) shl 8) or
        (data[offset++].toInt() and 255)
      requireBytes(length)
      val field = String(data, offset, length, Charsets.UTF_8)
      offset += length
      if (field == target) return string()
      skip()
    }
    error("Too many AMF status entries")
  }
  fun hasNext() = offset < data.size
}

fun rtmpCommand(output: OutputStream, streamId: Int, payload: ByteArray, type: Int = 20) {
  require(payload.size <= 2_097_152)
  val header = ByteArrayOutputStream()
  header.write(3) // fmt 0, csid 3
  header.write(bytes24(0))
  header.write(bytes24(payload.size))
  header.write(type)
  header.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(streamId).array())
  output.write(header.toByteArray())
  var offset = 0
  while (offset < payload.size) {
    if (offset > 0) output.write(0xc3)
    val length = minOf(128, payload.size - offset)
    output.write(payload, offset, length)
    offset += length
  }
  output.flush()
}

fun rtmpControl(output: OutputStream, type: Int, payload: ByteArray) {
  require(payload.size <= 128)
  output.write(byteArrayOf(2, 0, 0, 0, 0, 0, payload.size.toByte(), type.toByte(), 0, 0, 0, 0))
  output.write(payload)
  output.flush()
}

fun sendStreamBegin(output: OutputStream) {
  rtmpControl(output, 4, byteArrayOf(0, 0, 0, 0, 0, 1))
}
fun respondConnect(output: OutputStream, transaction: Double) {
  rtmpControl(output, 5, bytes32(5_000_000))
  rtmpControl(output, 6, bytes32(5_000_000) + byteArrayOf(2))
  val properties = amfObject("fmsVer" to amfString("FMS/3,5,7,7009"), "capabilities" to amfNumber(31.0))
  val information = amfObject(
    "level" to amfString("status"), "code" to amfString("NetConnection.Connect.Success"),
    "description" to amfString("Connection succeeded."), "objectEncoding" to amfNumber(0.0))
  rtmpCommand(output, 0, amfString("_result") + amfNumber(transaction) + properties + information)
}
fun respondCreateStream(output: OutputStream, transaction: Double) {
  rtmpCommand(output, 0, amfString("_result") + amfNumber(transaction) + amfNull() + amfNumber(1.0))
}
fun respondPublish(output: OutputStream) {
  sendStreamBegin(output)
  val information = amfObject(
    "level" to amfString("status"), "code" to amfString("NetStream.Publish.Start"),
    "description" to amfString("Publishing started."))
  rtmpCommand(output, 1, amfString("onStatus") + amfNumber(0.0) + amfNull() + information)
}
