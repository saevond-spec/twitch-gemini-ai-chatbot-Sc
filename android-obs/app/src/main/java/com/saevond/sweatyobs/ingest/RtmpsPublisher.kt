package com.saevond.sweatyobs.ingest

import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** User-provided secure RTMPS endpoint and private platform stream key. */
data class RtmpDestination(val id: String, val label: String, val serverUrl: String, val key: String) {
  fun isValid(): Boolean = id in setOf("twitch", "youtube", "kick", "sleipnir") &&
    label.length in 1..40 && RtmpsPublisher.endpointValid(serverUrl) && RtmpsPublisher.keyValid(key)
}

/** RTMPS publisher shared by Twitch, YouTube, and Kick. */
class RtmpsPublisher(serverUrl: String, private val key: String) : MediaPublisher {
  companion object {
    fun isPublicDestination(address: InetAddress): Boolean =
      !address.isSiteLocalAddress && !address.isLoopbackAddress &&
        !address.isLinkLocalAddress && !address.isAnyLocalAddress && !address.isMulticastAddress

    fun keyValid(value: String): Boolean =
      value.length in 8..256 && value.all { it.isLetterOrDigit() || it == '_' || it == '-' }

    fun endpointValid(value: String): Boolean = parseEndpoint(value) != null

    private fun parseEndpoint(value: String): Endpoint? {
      return try {
        val uri = URI(value.trim())
        val host = uri.host ?: return null
        val path = uri.rawPath ?: return null
        if (uri.scheme != "rtmps" || uri.rawUserInfo != null || uri.rawQuery != null ||
          uri.rawFragment != null || path.length !in 2..256 || path.any { it.isWhitespace() || it.isISOControl() } ||
          path.split('/').any { it == ".." }) return null
        val port = if (uri.port == -1) 443 else uri.port
        if (port !in 1..65535) return null
        Endpoint(host, port, path, "rtmps://$host:$port$path")
      } catch (_: Exception) { null }
    }

    private data class Endpoint(val host: String, val port: Int, val path: String, val tcUrl: String)
  }

  private val endpoint = parseEndpoint(serverUrl) ?: throw IllegalArgumentException("Use the RTMPS server URL from the streaming platform")
  @Volatile private var socket: SSLSocket? = null
  @Volatile private var output: OutputStream? = null
  @Volatile private var initialized = false
  @Volatile private var stopped = false
  private var lastTimestamp = 0L

  override fun connect() {
    require(keyValid(key)) { "Invalid stream key format" }
    check(!stopped && !initialized) { "Publisher already used" }
    val destinations = InetAddress.getAllByName(endpoint.host)
    check(destinations.isNotEmpty() && destinations.all(::isPublicDestination)) {
      "Streaming server DNS points to a private address"
    }
    val plain = Socket()
    try {
      plain.tcpNoDelay = true
      plain.keepAlive = true
      plain.connect(InetSocketAddress(destinations.first(), endpoint.port), 10000)
      val tls = (SSLSocketFactory.getDefault() as SSLSocketFactory)
        .createSocket(plain, endpoint.host, endpoint.port, true) as SSLSocket
      socket = tls
      tls.soTimeout = 12000
      tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
      tls.startHandshake()
      val input = tls.inputStream
      val out = tls.outputStream
      val c1 = ByteArray(1536)
      java.security.SecureRandom().nextBytes(c1)
      out.write(3)
      out.write(c1)
      out.flush()
      require(input.read() == 3) { "Streaming server rejected RTMP handshake" }
      val s1 = input.readRequired(1536)
      input.readRequired(1536)
      out.write(s1)
      out.flush()
      val reader = RtmpChunkReader(input)
      val app = endpoint.path.removePrefix("/")
      val connect = amfString("connect") + amfNumber(1.0) +
        amfObject(
          "app" to amfString(app),
          "type" to amfString("nonprivate"),
          "flashVer" to amfString("SweatyOBS/0.1"),
          "tcUrl" to amfString(endpoint.tcUrl),
          "fpad" to byteArrayOf(1, 0),
          "capabilities" to amfNumber(15.0),
          "audioCodecs" to amfNumber(4071.0),
          "videoCodecs" to amfNumber(252.0),
          "videoFunction" to amfNumber(1.0)
        )
      rtmpCommand(out, 0, connect)
      awaitResult(reader, 1.0)
      rtmpCommand(out, 0, amfString("createStream") + amfNumber(2.0) + amfNull())
      awaitResult(reader, 2.0)
      rtmpCommand(out, 1, amfString("publish") + amfNumber(0.0) + amfNull() +
        amfString(key) + amfString("live"))
      var accepted = false
      var attempts = 0
      while (!accepted && attempts++ < 60) {
        val message = reader.nextMessage()
        if (message.type == 20) {
          val amf = RtmpAmf0Reader(message.data)
          val command = amf.string()
          if (command == "_error") error("Streaming server rejected publish request")
          if (command == "onStatus") {
            amf.number()
            amf.skip()
            val code = amf.objectStringField("code")
            if (code != "NetStream.Publish.Start") {
              error("Streaming server rejected publish: " + (code ?: "unknown status"))
            }
            accepted = true
          }
        }
      }
      check(accepted) { "No publish acknowledgement from streaming server" }
      output = out
      initialized = true
    } catch (error: Exception) {
      runCatching { plain.close() }
      close()
      throw error
    }
  }

  private fun awaitResult(reader: RtmpChunkReader, id: Double) {
    repeat(80) {
      val message = reader.nextMessage()
      if (message.type == 20) {
        val amf = RtmpAmf0Reader(message.data)
        val name = amf.string()
        val transaction = amf.number()
        if (transaction == id) {
          require(name == "_result") { "Streaming server rejected RTMP command" }
          return
        }
      }
    }
    error("Timed out waiting for RTMP reply")
  }

  @Synchronized override fun publish(media: RtmpMessage) {
    check(initialized && !stopped) { "RTMPS publisher is not ready" }
    require(media.type == 8 || media.type == 9)
    require(media.data.size in 3..2_097_152)
    val out = output ?: error("Output unavailable")
    lastTimestamp = maxOf(lastTimestamp, media.timestamp)
    sendRtmpMedia(out, media.copy(timestamp = lastTimestamp, streamId = 1))
  }

  override fun close() {
    stopped = true
    initialized = false
    output = null
    runCatching { socket?.close() }
    socket = null
  }
}

/** Compatibility wrapper retained for the existing Twitch settings and tests. */
class TwitchRtmpsPublisher(private val key: String) : AutoCloseable {
  companion object {
    private const val TWITCH_SERVER = "rtmps://live.twitch.tv:443/app"
    fun isPublicDestination(address: InetAddress) = RtmpsPublisher.isPublicDestination(address)
    fun keyValid(value: String) = value.length in 15..160 && RtmpsPublisher.keyValid(value)
  }
  private val delegate = RtmpsPublisher(TWITCH_SERVER, key)
  fun connect() = delegate.connect()
  fun publish(media: RtmpMessage) = delegate.publish(media)
  override fun close() = delegate.close()
}

/** RTMP type-8 AAC or type-9 AVC message, chunked to default 128 bytes. */
fun sendRtmpMedia(output: OutputStream, media: RtmpMessage) {
  require(media.type == 8 || media.type == 9)
  require(media.data.size in 1..2_097_152)
  val csid = if (media.type == 8) 4 else 6
  val stamp = media.timestamp.coerceIn(0, 0xffffffffL)
  val extended = stamp >= 0xffffff
  val field = if (extended) 0xffffff else stamp.toInt()
  output.write(csid)
  output.write(byteArrayOf((field shr 16).toByte(), (field shr 8).toByte(), field.toByte()))
  val size = media.data.size
  output.write(byteArrayOf((size shr 16).toByte(), (size shr 8).toByte(), size.toByte()))
  output.write(media.type)
  output.write(byteArrayOf(1, 0, 0, 0))
  if (extended) output.write(byteArrayOf((stamp shr 24).toByte(), (stamp shr 16).toByte(), (stamp shr 8).toByte(), stamp.toByte()))
  var offset = 0
  while (offset < size) {
    if (offset > 0) {
      output.write(0xc0 or csid)
      if (extended) output.write(byteArrayOf((stamp shr 24).toByte(), (stamp shr 16).toByte(), (stamp shr 8).toByte(), stamp.toByte()))
    }
    val amount = minOf(128, size - offset)
    output.write(media.data, offset, amount)
    offset += amount
  }
}
