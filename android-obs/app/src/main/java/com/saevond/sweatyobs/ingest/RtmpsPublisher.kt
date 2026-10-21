package com.saevond.sweatyobs.ingest

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.ConnectException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.concurrent.thread

/** User-provided secure RTMPS endpoint and private platform stream key. */
data class RtmpDestination(val id: String, val label: String, val serverUrl: String, val key: String) {
  fun isValid(): Boolean = id in setOf("twitch", "youtube", "kick") &&
    label.length in 1..40 && RtmpsPublisher.endpointValid(serverUrl) && RtmpsPublisher.keyValid(key)
}

/** RTMPS publisher shared by Twitch, YouTube, and Kick. */
class RtmpsPublisher(serverUrl: String, private val key: String) : MediaPublisher {
  companion object {
    const val KICK_RTMPS_URL = "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app"
    const val YOUTUBE_RTMPS_URL = "rtmps://a.rtmps.youtube.com:443/live2"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val MAX_ADDRESS_CANDIDATES = 8

    fun isPublicDestination(address: InetAddress): Boolean =
      !address.isSiteLocalAddress && !address.isLoopbackAddress &&
        !address.isLinkLocalAddress && !address.isAnyLocalAddress && !address.isMulticastAddress

    fun keyValid(value: String): Boolean =
      value.length in 8..256 && value.all { it.isLetterOrDigit() || it == '_' || it == '-' }

    fun endpointValid(value: String): Boolean = parseEndpoint(value) != null

    /** Repairs only the known legacy root-only Kick URL; custom endpoints are preserved. */
    fun normalizeKnownKickEndpoint(value: String): String {
      val uri = runCatching { URI(value.trim()) }.getOrNull() ?: return value
      val rootPath = uri.rawPath.isNullOrEmpty() || uri.rawPath == "/"
      return if (uri.scheme?.equals("rtmps", true) == true &&
        uri.host?.equals("fa723fc1b171.global-contribute.live-video.net", true) == true &&
        uri.userInfo == null && uri.query == null && uri.fragment == null &&
        uri.port in listOf(-1, 443) && rootPath) KICK_RTMPS_URL else value
    }

    /** Converts only YouTube's well-known insecure RTMP URLs to their RTMPS equivalents. */
    fun normalizeKnownYouTubeEndpoint(value: String): String {
      val uri = runCatching { URI(value.trim()) }.getOrNull() ?: return value
      val host = when {
        uri.host?.equals("a.rtmp.youtube.com", true) == true -> "a.rtmps.youtube.com"
        uri.host?.equals("b.rtmp.youtube.com", true) == true -> "b.rtmps.youtube.com"
        else -> return value
      }
      val recognizedBackupQuery = uri.query == null || uri.query == "backup=1"
      return if (uri.scheme?.equals("rtmp", true) == true && uri.path == "/live2" &&
        uri.userInfo == null && uri.fragment == null && recognizedBackupQuery &&
        uri.port in listOf(-1, 1935)) "rtmps://$host:443/live2" else value
    }

    /** TLS-only reachability probe: opens and closes a secure socket without a key or media. */
    fun testTlsEndpoint(serverUrl: String): String {
      val endpoint = parseEndpoint(serverUrl) ?: return "INVALID_URL"
      val addresses = try {
        InetAddress.getAllByName(endpoint.host)
      } catch (_: UnknownHostException) {
        return "DNS_FAILED"
      } catch (_: Exception) {
        return "DNS_FAILED"
      }
      if (addresses.isEmpty()) return "DNS_FAILED"
      if (addresses.any { !isPublicDestination(it) }) return "BLOCKED_ADDRESS"
      return try {
        val tls = tryResolvedAddresses(addresses) { address, remainingMs ->
          openTlsSocket(endpoint, address, remainingMs)
        }
        tls.close()
        "TLS_OK"
      } catch (error: Exception) {
        var root: Throwable = error
        while (root.cause != null && root.cause !== root) root = root.cause!!
        when (root) {
          is SocketTimeoutException -> "CONNECT_TIMEOUT"
          is SSLException -> "TLS_FAILED"
          is ConnectException -> "CONNECTION_REFUSED"
          else -> "NETWORK_FAILED"
        }
      }
    }

    /** RTMP ping request user-control event 6; respond with event 7 and its timestamp. */
    internal fun pingResponsePayload(userControlPayload: ByteArray): ByteArray? {
      if (userControlPayload.size < 6 || (userControlPayload[0].toInt() and 255) != 0 ||
        (userControlPayload[1].toInt() and 255) != 6) return null
      return byteArrayOf(0, 7) + userControlPayload.copyOfRange(2, 6)
    }

    /** Attempt resolved addresses within a bounded total timeout, rather than pinning to DNS order. */
    internal fun <T> tryResolvedAddresses(
      addresses: Array<InetAddress>,
      timeoutMs: Int = CONNECT_TIMEOUT_MS,
      nowNanos: () -> Long = System::nanoTime,
      connect: (InetAddress, Int) -> T
    ): T {
      require(timeoutMs in 1..60_000)
      val candidates = addresses.take(MAX_ADDRESS_CANDIDATES)
      require(candidates.isNotEmpty()) { "No streaming server addresses found" }
      val deadline = nowNanos() + timeoutMs * 1_000_000L
      var lastFailure: Exception? = null
      for (address in candidates) {
        val remainingMs = ((deadline - nowNanos()) / 1_000_000L).toInt()
        if (remainingMs <= 0) break
        try {
          return connect(address, remainingMs)
        } catch (error: Exception) {
          lastFailure = error
        }
      }
      throw IOException("Could not connect to the streaming server", lastFailure)
    }

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

    private fun openTlsSocket(endpoint: Endpoint, address: InetAddress, remainingMs: Int): SSLSocket {
      val deadline = System.nanoTime() + remainingMs * 1_000_000L
      val plain = Socket()
      var tls: SSLSocket? = null
      try {
        plain.tcpNoDelay = true
        plain.keepAlive = true
        plain.connect(InetSocketAddress(address, endpoint.port), minOf(5_000, remainingMs))
        val tlsRemaining = ((deadline - System.nanoTime()) / 1_000_000L).toInt()
        if (tlsRemaining <= 0) throw SocketTimeoutException("RTMPS connect budget exhausted")
        tls = (SSLSocketFactory.getDefault() as SSLSocketFactory)
          .createSocket(plain, endpoint.host, endpoint.port, true) as SSLSocket
        tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
        tls.soTimeout = minOf(8_000, tlsRemaining)
        tls.startHandshake()
        tls.soTimeout = 12_000
        return tls
      } catch (error: Exception) {
        runCatching { tls?.close() }
        runCatching { plain.close() }
        throw error
      }
    }
  }

  private val endpoint = parseEndpoint(serverUrl) ?: throw IllegalArgumentException("Use the RTMPS server URL from the streaming platform")
  @Volatile private var socket: SSLSocket? = null
  @Volatile private var output: OutputStream? = null
  @Volatile private var initialized = false
  @Volatile private var stopped = false
  @Volatile private var controlReaderThread: Thread? = null
  private val writeLock = Any()
  @Volatile private var acknowledgementWindow = 0L
  @Volatile private var lastAcknowledgementAt = 0L
  private var lastTimestamp = 0L

  override fun connect() {
    require(keyValid(key)) { "Invalid stream key format" }
    check(!stopped && !initialized) { "Publisher already used" }
    val resolved = InetAddress.getAllByName(endpoint.host)
    check(resolved.isNotEmpty() && resolved.all(::isPublicDestination)) {
      "Streaming server DNS points to a private address"
    }
    val tls = tryResolvedAddresses(resolved) { address, remainingMs ->
      check(!stopped) { "Publisher stopped while connecting" }
      openTlsSocket(endpoint, address, remainingMs)
    }
    socket = tls
    if (stopped) {
      close()
      error("Publisher stopped while connecting")
    }
    try {
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
      val countedInput = CountingInputStream(input)
      val reader = RtmpChunkReader(countedInput)
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
      awaitResult(reader, 1.0, out, countedInput)
      rtmpCommand(out, 0, amfString("createStream") + amfNumber(2.0) + amfNull())
      awaitResult(reader, 2.0, out, countedInput)
      rtmpCommand(out, 1, amfString("publish") + amfNumber(0.0) + amfNull() +
        amfString(key) + amfString("live"))
      var accepted = false
      var attempts = 0
      while (!accepted && attempts++ < 60) {
        val message = reader.nextMessage()
        processServerControl(message, out, countedInput)
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
      check(!stopped) { "Publisher stopped while connecting" }
      // The control reader must stay blocked during quiet periods; socket timeouts
      // are only for connection setup and RTMP negotiation.
      tls.soTimeout = 0
      output = out
      initialized = true
      startControlReader(reader, out, countedInput)
    } catch (error: Exception) {
      close()
      throw error
    }
  }

  private fun awaitResult(reader: RtmpChunkReader, id: Double, out: OutputStream,
                          countedInput: CountingInputStream) {
    repeat(80) {
      val message = reader.nextMessage()
      processServerControl(message, out, countedInput)
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

  private fun startControlReader(reader: RtmpChunkReader, out: OutputStream, countedInput: CountingInputStream) {
    controlReaderThread = thread(name = "SweatyOBS-RTMPS-control", isDaemon = true) {
      try {
        while (!stopped && initialized) processServerControl(reader.nextMessage(), out, countedInput)
      } catch (_: Exception) {
        // The next media write observes the closed socket and enters the output retry path.
        if (!stopped) runCatching { socket?.close() }
      }
    }
  }

  private fun processServerControl(message: RtmpMessage, out: OutputStream, countedInput: CountingInputStream) {
    if (message.type == 5 && message.data.size >= 4) {
      acknowledgementWindow = ByteBuffer.wrap(message.data, 0, 4).order(ByteOrder.BIG_ENDIAN)
        .int.toLong() and 0xffffffffL
    }
    if (message.type == 4) {
      val response = pingResponsePayload(message.data)
      if (response != null) synchronized(writeLock) { rtmpControl(out, 4, response) }
    }
    val window = acknowledgementWindow
    val bytesRead = countedInput.bytesRead
    if (window > 0 && bytesRead - lastAcknowledgementAt >= window) {
      val payload = ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(bytesRead.toInt()).array()
      synchronized(writeLock) { rtmpControl(out, 3, payload) }
      lastAcknowledgementAt = bytesRead
    }
  }

  override fun publish(media: RtmpMessage) {
    check(initialized && !stopped) { "RTMPS publisher is not ready" }
    require(media.type == 8 || media.type == 9)
    require(media.data.size in 3..2_097_152)
    val out = output ?: error("Output unavailable")
    lastTimestamp = maxOf(lastTimestamp, media.timestamp)
    synchronized(writeLock) {
      check(initialized && !stopped) { "RTMPS publisher is not ready" }
      sendRtmpMedia(out, media.copy(timestamp = lastTimestamp, streamId = 1))
    }
  }

  override fun close() {
    stopped = true
    initialized = false
    output = null
    runCatching { socket?.close() }
    socket = null
    controlReaderThread = null
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
  val size = media.data.size
  val chunksAfterFirst = (size - 1 + 127) / 128
  val packet = ByteArrayOutputStream(size + 12 + chunksAfterFirst * (if (extended) 5 else 1) + if (extended) 4 else 0)
  fun int24(value: Int) {
    packet.write(value shr 16)
    packet.write(value shr 8)
    packet.write(value)
  }
  fun int32(value: Long) {
    packet.write((value shr 24).toInt())
    packet.write((value shr 16).toInt())
    packet.write((value shr 8).toInt())
    packet.write(value.toInt())
  }
  packet.write(csid)
  int24(field)
  int24(size)
  packet.write(media.type)
  packet.write(1); packet.write(0); packet.write(0); packet.write(0)
  if (extended) int32(stamp)
  var offset = 0
  while (offset < size) {
    if (offset > 0) {
      packet.write(0xc0 or csid)
      if (extended) int32(stamp)
    }
    val amount = minOf(128, size - offset)
    packet.write(media.data, offset, amount)
    offset += amount
  }
  // Preserve RTMP's default 128-byte chunk framing while coalescing this whole
  // media message into one TLS socket write instead of hundreds of tiny writes.
  packet.writeTo(output)
}
