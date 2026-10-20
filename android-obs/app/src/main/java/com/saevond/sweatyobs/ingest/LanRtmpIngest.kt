package com.saevond.sweatyobs.ingest

import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import kotlin.concurrent.thread

/** Owner-controlled private Wi-Fi receiver for a single PS5 source. */
class LanRtmpIngest(
  private val listenAddress: String,
  private val permittedPs5Address: String,
  private val onMedia: (RtmpMessage) -> Unit
) {
  @Volatile var active = false
    private set
  @Volatile var connected = false
    private set
  @Volatile var audioPackets = 0L
    private set
  @Volatile var videoPackets = 0L
    private set
  @Volatile private var listener: ServerSocket? = null
  @Volatile private var peer: Socket? = null
  @Volatile var lastFailure: String? = null
    private set

  /** Bind before returning: occupied/unavailable port is a synchronous failure, not a thread crash. */
  @Synchronized fun start() {
    check(!active) { "Receiver already started" }
    val host = InetAddress.getByName(listenAddress)
    val source = InetAddress.getByName(permittedPs5Address)
    require(host is Inet4Address && host.isSiteLocalAddress)
    require(source is Inet4Address && source.isSiteLocalAddress && source != host)
    val server = ServerSocket()
    try {
      server.reuseAddress = false
      server.bind(InetSocketAddress(host, 1935), 1)
      server.soTimeout = 1000
    } catch (e: Exception) {
      runCatching { server.close() }
      throw IllegalStateException("Private RTMP listener unavailable", e)
    }
    listener = server
    lastFailure = null
    active = true
    try {
      thread(name = "SweatyOBS-ingest") {
        try {
          server.use {
            while (active) {
              val socket = try { it.accept() } catch (_: SocketTimeoutException) { continue }
              if (!active) { socket.close(); break }
              if (socket.inetAddress != source) { socket.close(); continue }
              connected = true
              peer = socket
              try { socket.use { client -> session(client) } } catch (_: Exception) {
                // One malformed peer must not crash the phone or restart the stream.
              } finally {
                connected = false
                peer = null
              }
            }
          }
        } catch (_: Exception) {
          if (active) lastFailure = "Listener closed unexpectedly"
        } finally {
          active = false
          connected = false
          listener = null
          peer = null
        }
      }
    } catch (e: Exception) {
      active = false
      listener = null
      runCatching { server.close() }
      throw IllegalStateException("RTMP worker unavailable", e)
    }
  }

  private fun session(socket: Socket) {
    socket.soTimeout = 12000
    val input = socket.getInputStream()
    val output = socket.getOutputStream()
    rtmpHandshake(input, output)
    val reader = RtmpChunkReader(input)
    var conn = false
    var created = false
    var published = false
    while (active) {
      val msg = reader.nextMessage()
      when (msg.type) {
        20, 17 -> {
          val data = if (msg.type == 17) {
            require(msg.data.isNotEmpty() && msg.data[0] == 0.toByte())
            msg.data.copyOfRange(1, msg.data.size)
          } else msg.data
          val amf = RtmpAmf0Reader(data)
          val command = amf.string()
          val transaction = amf.number()
          when (command) {
            "connect" -> { require(!conn); conn = true; respondConnect(output, transaction) }
            "releaseStream", "FCPublish" -> require(conn)
            "createStream" -> { require(conn); created = true; respondCreateStream(output, transaction) }
            "publish" -> {
              require(conn && created && msg.streamId == 1)
              if (amf.hasNext()) amf.skip()
              val name = amf.string()
              require(name.length in 1..120 && name.matches(Regex("[A-Za-z0-9_./-]+")))
              published = true
              respondPublish(output)
            }
            "closeStream", "deleteStream", "FCUnpublish" -> return
          }
        }
        8 -> if (published && msg.streamId == 1) {
          audioPackets++
          onMedia(msg)
        }
        9 -> if (published && msg.streamId == 1) {
          videoPackets++
          onMedia(msg)
        }
      }
    }
  }

  @Synchronized fun stop() {
    active = false
    runCatching { peer?.close() }
    runCatching { listener?.close() }
  }
}
