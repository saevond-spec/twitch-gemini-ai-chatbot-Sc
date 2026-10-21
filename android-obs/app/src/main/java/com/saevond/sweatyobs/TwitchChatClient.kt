package com.saevond.sweatyobs

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.util.ArrayDeque
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

internal data class TwitchChatMessage(val login: String, val displayName: String, val text: String)

/** Caller synchronizes access; overload drops the oldest item so pending work stays bounded. */
internal class BoundedLatestQueue<T>(private val limit: Int) {
  private val items = ArrayDeque<T>()

  init { require(limit > 0) }

  fun offer(item: T) {
    while (items.size >= limit) items.removeFirst()
    items.addLast(item)
  }

  fun drain(): List<T> = buildList {
    while (items.isNotEmpty()) add(items.removeFirst())
  }

  fun clear() = items.clear()
  fun isEmpty(): Boolean = items.isEmpty()
}

internal enum class TwitchChatState(val overlayLabel: String) {
  CONNECTING("CONNECTING"),
  AUTHENTICATED("JOINING"),
  CONNECTED("LIVE"),
  RECONNECTING("RETRYING"),
  AUTH_FAILED("AUTH ERROR"),
  CONNECTION_ERROR("NETWORK"),
  STOPPED("OFFLINE")
}

/** Pure Twitch IRC formatting and parsing; kept separate for synthetic tests. */
internal object TwitchChatProtocol {
  const val HOST = "irc.chat.twitch.tv"
  const val PORT = 6697
  const val MAX_LINE_BYTES = 8192
  const val MAX_MESSAGE_CHARS = 180
  const val MAX_CHAT_LINES = 8
  const val MAX_RETRY_DELAY_MS = 60_000L
  private const val BASE_RETRY_DELAY_MS = 1_000L

  fun normalizeLogin(value: String): String? {
    val login = value.trim().lowercase(Locale.ROOT)
    return login.takeIf { it.matches(Regex("[a-z0-9_]{1,25}")) }
  }

  /** Accepts a pasted raw user access token or an IRC-style `oauth:` prefix. */
  fun normalizeAccessToken(value: String): String? {
    val candidate = value.trim().replaceFirst(Regex("(?i)^oauth:"), "").trim()
    if (candidate.length !in 8..4096 || candidate.any { it.isWhitespace() || it.isISOControl() }) return null
    return candidate
  }

  fun authCommands(loginInput: String, channelInput: String, tokenInput: String): List<String>? {
    val login = normalizeLogin(loginInput) ?: return null
    val channel = normalizeLogin(channelInput) ?: return null
    val token = normalizeAccessToken(tokenInput) ?: return null
    return listOf(
      "PASS oauth:$token",
      "NICK $login",
      "CAP REQ :twitch.tv/tags twitch.tv/commands",
      "JOIN #$channel"
    )
  }

  fun pongLine(line: String): String? {
    if (!line.startsWith("PING ")) return null
    val payload = line.substring(5).take(MAX_LINE_BYTES - 16)
      .takeIf { it.isNotBlank() && it.none(Char::isISOControl) } ?: return null
    return "PONG $payload"
  }

  fun parsePrivmsg(line: String, channelInput: String? = null): TwitchChatMessage? {
    if (!fitsUtf8ByteLimit(line, MAX_LINE_BYTES)) return null
    var payload = line
    var tagText = ""
    if (payload.startsWith("@")) {
      val separator = payload.indexOf(" :")
      if (separator < 0 || separator > MAX_LINE_BYTES) return null
      tagText = payload.substring(1, separator)
      payload = payload.substring(separator + 2)
    }
    if (!payload.startsWith(":")) return null
    val commandStart = payload.indexOf(" PRIVMSG ")
    if (commandStart < 2) return null
    val prefix = payload.substring(1, commandStart)
    val login = normalizeLogin(prefix.substringBefore('!')) ?: return null
    val messageStart = payload.indexOf(" :", commandStart + 9)
    if (messageStart < 0) return null
    if (channelInput != null) {
      val channel = normalizeLogin(channelInput) ?: return null
      val target = payload.substring(commandStart + 9, messageStart).trim()
      if (!target.equals("#$channel", ignoreCase = true)) return null
    }
    val message = cleanVisibleText(payload.substring(messageStart + 2), MAX_MESSAGE_CHARS)
    if (message.isEmpty()) return null
    val tags = tagText.split(';').mapNotNull { tag ->
      val separator = tag.indexOf('=')
      if (separator <= 0) null else tag.substring(0, separator) to unescapeTag(tag.substring(separator + 1))
    }.toMap()
    val name = cleanVisibleText(tags["display-name"].orEmpty(), 25).ifBlank { login }
    return TwitchChatMessage(login, name, message)
  }

  fun isJoinedConfirmation(line: String, channelInput: String, loginInput: String): Boolean {
    val channel = normalizeLogin(channelInput) ?: return false
    val login = normalizeLogin(loginInput) ?: return false
    val withoutTags = if (line.startsWith("@")) line.substringAfter(' ', "") else line
    val fields = withoutTags.substringBefore(" :", withoutTags).trim().split(Regex("\\s+"))
      .filter(String::isNotEmpty)
    if (fields.isEmpty()) return false
    val hasPrefix = fields[0].startsWith(":")
    val prefix = if (hasPrefix) fields[0].drop(1) else ""
    val commandIndex = if (hasPrefix) 1 else 0
    if (fields.size <= commandIndex + 1) return false
    val command = fields[commandIndex].uppercase(Locale.ROOT)
    val target = fields[commandIndex + 1].removePrefix("#").lowercase(Locale.ROOT)
    if (target != channel) return false
    if (command == "ROOMSTATE") return true
    if (command != "JOIN") return false
    return normalizeLogin(prefix.substringBefore('!')) == login
  }

  fun isAuthenticationFailure(line: String): Boolean {
    if (!line.contains(" NOTICE ", ignoreCase = true)) return false
    val lower = line.lowercase(Locale.ROOT)
    return listOf("login authentication failed", "improperly formatted auth", "invalid nick", "authentication failed")
      .any(lower::contains)
  }

  /** Full-jitter exponential retry, capped at one minute to limit reconnect bursts. */
  fun retryDelayMillis(attempt: Int, jitter: Double): Long {
    val exponent = attempt.coerceIn(0, 16)
    val cap = (BASE_RETRY_DELAY_MS shl exponent).coerceAtMost(MAX_RETRY_DELAY_MS)
    return (jitter.coerceIn(0.0, 1.0) * cap).toLong().coerceIn(0L, cap)
  }

  private fun unescapeTag(value: String): String = value
    .replace("\\s", " ")
    .replace("\\:", ";")
    .replace("\\\\", "\\")
    .replace("\\r", "\r")
    .replace("\\n", "\n")

  private fun fitsUtf8ByteLimit(value: String, maxBytes: Int): Boolean {
    var bytes = 0
    var index = 0
    while (index < value.length && bytes <= maxBytes) {
      val char = value[index++]
      bytes += when {
        char.code <= 0x7f -> 1
        char.code <= 0x7ff -> 2
        Character.isHighSurrogate(char) && index < value.length && Character.isLowSurrogate(value[index]) -> {
          index++
          4
        }
        else -> 3
      }
    }
    return bytes <= maxBytes
  }

  private fun cleanVisibleText(value: String, maxChars: Int): String = buildString {
    for (character in value) {
      if (length >= maxChars) break
      if (!character.isISOControl()) append(character)
    }
  }.trim()
}

/** Read-only, TLS-protected Twitch chat connection. Never sends PRIVMSG or stores chat text. */
internal class TwitchChatClient(
  loginInput: String,
  channelInput: String,
  tokenInput: String,
  private val verifyOnly: Boolean = false,
  private val onState: (TwitchChatState) -> Unit,
  private val onMessage: (TwitchChatMessage) -> Unit
) : Closeable {
  private val login = TwitchChatProtocol.normalizeLogin(loginInput)
    ?: throw IllegalArgumentException("Invalid Twitch login")
  private val channel = TwitchChatProtocol.normalizeLogin(channelInput)
    ?: throw IllegalArgumentException("Invalid Twitch channel")
  private val token = TwitchChatProtocol.normalizeAccessToken(tokenInput)
    ?: throw IllegalArgumentException("Invalid Twitch chat token")
  private val closed = AtomicBoolean(false)
  private val started = AtomicBoolean(false)
  @Volatile private var socket: SSLSocket? = null
  @Volatile private var worker: Thread? = null
  @Volatile private var lastState: TwitchChatState? = null
  private var joinedThisSession = false

  fun start() {
    if (closed.get() || !started.compareAndSet(false, true)) return
    worker = Thread({ runLoop() }, "SweatyOBS-twitch-chat").apply {
      isDaemon = true
      start()
    }
  }

  override fun close() {
    stop(notifyStopped = true)
  }

  private fun stop(notifyStopped: Boolean) {
    if (!closed.compareAndSet(false, true)) return
    runCatching { socket?.close() }
    worker?.interrupt()
    if (notifyStopped) notifyState(TwitchChatState.STOPPED)
  }

  private fun runLoop() {
    var attempt = 0
    notifyState(TwitchChatState.CONNECTING)
    while (!closed.get()) {
      joinedThisSession = false
      try {
        val joined = readSession()
        if (joined) attempt = 0
        if (joined && verifyOnly) {
          stop(notifyStopped = false)
          return
        }
        if (!closed.get()) throw IOException("Twitch chat connection ended")
      } catch (_: AuthenticationFailure) {
        notifyState(TwitchChatState.AUTH_FAILED)
        closeSocket()
        stop(notifyStopped = false)
        return
      } catch (_: Exception) {
        closeSocket()
        if (closed.get()) break
        if (joinedThisSession) attempt = 0
        notifyState(TwitchChatState.CONNECTION_ERROR)
        val delay = TwitchChatProtocol.retryDelayMillis(attempt++, Math.random())
        try {
          Thread.sleep(delay)
        } catch (_: InterruptedException) {
          if (closed.get()) break
        }
        if (!closed.get()) notifyState(TwitchChatState.RECONNECTING)
      }
    }
    notifyState(TwitchChatState.STOPPED)
  }

  /** Returns true once Twitch has confirmed joining the selected room. */
  private fun readSession(): Boolean {
    val current = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket() as SSLSocket
    socket = current
    if (closed.get()) {
      closeSocket()
      return false
    }
    current.sslParameters = current.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
    current.connect(InetSocketAddress(TwitchChatProtocol.HOST, TwitchChatProtocol.PORT), CONNECT_TIMEOUT_MS)
    current.soTimeout = READ_TIMEOUT_MS
    current.tcpNoDelay = true
    current.keepAlive = true
    current.startHandshake()
    val writer = OutputStreamWriter(current.outputStream, Charsets.UTF_8)
    val commands = TwitchChatProtocol.authCommands(login, channel, token) ?: throw AuthenticationFailure()
    for (command in commands) sendLine(writer, command)

    val input = current.inputStream
    var joined = false
    while (!closed.get()) {
      val line = readBoundedLine(input) ?: return joined
      if (line.isEmpty()) continue // Ignore an overlong protocol line after consuming it.
      TwitchChatProtocol.pongLine(line)?.let { sendLine(writer, it); continue }
      if (line.contains(" RECONNECT", ignoreCase = true)) return joined
      if (TwitchChatProtocol.isAuthenticationFailure(line)) throw AuthenticationFailure()
      if (line.contains(" 001 ")) notifyState(TwitchChatState.AUTHENTICATED)
      if (TwitchChatProtocol.isJoinedConfirmation(line, channel, login)) {
        joined = true
        joinedThisSession = true
        notifyState(TwitchChatState.CONNECTED)
        if (verifyOnly) return true
      }
      if (!verifyOnly) TwitchChatProtocol.parsePrivmsg(line, channel)?.let { message ->
        runCatching { onMessage(message) }
      }
    }
    return joined
  }

  private fun sendLine(writer: OutputStreamWriter, line: String) {
    writer.write(line)
    writer.write("\r\n")
    writer.flush()
  }

  /** Keeps server-controlled lines bounded even if a peer sends malformed data. */
  private fun readBoundedLine(input: InputStream): String? {
    val bytes = ByteArrayOutputStream()
    var tooLong = false
    while (!closed.get()) {
      val next = input.read()
      if (next < 0) return if (bytes.size() > 0 && !tooLong) bytes.toByteArray().toString(Charsets.UTF_8).trimEnd('\r') else null
      if (next == '\n'.code) return if (tooLong) "" else bytes.toByteArray().toString(Charsets.UTF_8).trimEnd('\r')
      if (bytes.size() < TwitchChatProtocol.MAX_LINE_BYTES) bytes.write(next) else tooLong = true
    }
    return null
  }

  private fun closeSocket() {
    val current = socket
    socket = null
    runCatching { current?.close() }
  }

  private fun notifyState(state: TwitchChatState) {
    if (lastState == state) return
    lastState = state
    runCatching { onState(state) }
  }

  private class AuthenticationFailure : IOException()

  companion object {
    private const val CONNECT_TIMEOUT_MS = 8_000
    // Twitch IRC sends regular PINGs; this leaves enough room for quiet rooms and flaky mobile Wi-Fi.
    private const val READ_TIMEOUT_MS = 360_000
  }
}
