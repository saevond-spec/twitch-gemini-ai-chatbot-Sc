package com.saevond.sweatyobs

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLExt
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLUtils
import com.saevond.sweatyobs.ingest.AvcFlv
import com.saevond.sweatyobs.ingest.AvcFlvConfig
import com.saevond.sweatyobs.ingest.ReliableRtmpOutput
import com.saevond.sweatyobs.ingest.RtmpMessage
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

/** Shared overlay encode profiles; all selected destinations receive this same video stream. */
internal enum class OverlayEncodingProfile(
  val maxWidth: Int,
  val maxHeight: Int,
  val videoBitrateMbps: Double
) {
  STABLE_720P(1280, 720, 4.5),
  HIGH_1080P(1920, 1080, 8.0),
  LOW_LOAD_540P(960, 540, 1.8),
  SLEIPNIR_720P(1280, 720, 3.2),
  SLEIPNIR_LOW_LOAD_540P(960, 540, 1.8);

  val isSleipnirCapped: Boolean
    get() = this == SLEIPNIR_720P || this == SLEIPNIR_LOW_LOAD_540P

  fun forSleipnir(): OverlayEncodingProfile =
    if (this == LOW_LOAD_540P) SLEIPNIR_LOW_LOAD_540P else SLEIPNIR_720P

  companion object {
    fun fromPreference(value: String?): OverlayEncodingProfile = when (value) {
      "high_1080" -> HIGH_1080P
      "low_load_540" -> LOW_LOAD_540P
      else -> STABLE_720P
    }
  }
}

/**
 * Optional live H.264 compositor. It decodes the incoming AVC feed, renders a
 * full-screen transparent @saevond esports HUD with GLES, and re-encodes one
 * shared feed at up to 1080p for the selected RTMPS destinations.
 *
 * Network ingest never waits for codec or GPU work. Input is bounded and stale
 * frames are discarded until a keyframe when the device falls behind.
 */
internal class BrandVideoOverlay(
  private val onOutput: (RtmpMessage) -> Unit,
  private val onStatus: (String) -> Unit,
  private val onFailure: (String) -> Unit,
  private val encodingProfile: OverlayEncodingProfile = OverlayEncodingProfile.STABLE_720P,
  private val showBrandOverlay: Boolean = true,
  private val rotateVideo180: Boolean = false
) : Closeable {
  private data class Work(val message: RtmpMessage, val isKeyframe: Boolean)
  private val worker = HandlerThread("SweatyOBS-brand-overlay").apply { start() }
  private val handler = Handler(worker.looper)
  private val lock = Any()
  private val pending = ArrayDeque<Work>()
  private val chatLock = Any()
  private val pendingChatMessages = BoundedLatestQueue<TwitchChatMessage>(TwitchChatProtocol.MAX_CHAT_LINES)
  private val chatDrainScheduled = AtomicBoolean(false)
  private var pendingBytes = 0
  private val closed = AtomicBoolean(false)
  @Volatile private var liveChatEnabled = false
  @Volatile private var liveChatStatus = "OFFLINE"
  @Volatile private var overlayCanvas: BrandOverlayCanvas? = null
  private var configMessage: RtmpMessage? = null
  private var config: AvcFlvConfig? = null
  private var decoder: MediaCodec? = null
  private var encoder: MediaCodec? = null
  private var encoderInputSurface: Surface? = null
  private var compositor: GlBrandCompositor? = null
  private var awaitingKeyframe = true
  private var flushDecoder = false
  private var scheduled = false
  @Volatile private var outputWidth = 0
  @Volatile private var outputHeight = 0
  @Volatile private var outputFps = 0
  @Volatile private var outputBitrateBps = 0
  @Volatile private var outputCodecName = "unknown"
  @Volatile private var lastOutputTimestampMs = -1L
  private var announcedConfig = false
  private var lastStatusAt = 0L

  fun diagnosticsSummary(): String {
    val dimensions = if (outputWidth > 0 && outputHeight > 0) "${outputWidth}x${outputHeight}@$outputFps" else "not-configured"
    val bitrate = if (outputBitrateBps > 0) "${outputBitrateBps / 1_000}kbps" else "unknown-bitrate"
    val queue = synchronized(lock) { "${pending.size}frames/${pendingBytes}bytes" }
    return "codec=$outputCodecName encoded=$dimensions bitrate=$bitrate queue=$queue"
  }

  fun setConfiguration(message: RtmpMessage) {
    if (closed.get()) return
    synchronized(lock) {
      configMessage = message.copy(data = message.data.copyOf())
      pending.clear()
      pendingBytes = 0
      awaitingKeyframe = true
      flushDecoder = false
    }
    schedulePump()
  }

  fun setLiveChatEnabled(enabled: Boolean) {
    synchronized(chatLock) {
      liveChatEnabled = enabled
      liveChatStatus = if (enabled) "CONNECTING" else "OFFLINE"
      if (!enabled) pendingChatMessages.clear()
    }
    handler.post {
      overlayCanvas?.let { canvas ->
        canvas.setLiveChatEnabled(liveChatEnabled)
        canvas.setLiveChatStatus(liveChatStatus)
      }
    }
  }

  fun setLiveChatStatus(status: String) {
    liveChatStatus = status.take(24)
    handler.post { overlayCanvas?.setLiveChatStatus(liveChatStatus) }
  }

  fun offerLiveChatMessage(message: TwitchChatMessage) {
    synchronized(chatLock) {
      if (!liveChatEnabled || closed.get()) return
      pendingChatMessages.offer(message)
    }
    scheduleChatDrain()
  }

  /** Coalesces bursts into at most 20 worker callbacks per second; pending rows stay capped at eight. */
  private fun scheduleChatDrain() {
    if (!chatDrainScheduled.compareAndSet(false, true)) return
    if (!handler.postDelayed({
        val batch = synchronized(chatLock) {
          val canvas = overlayCanvas
          if (canvas == null) {
            chatDrainScheduled.set(false)
            null
          } else {
            val messages = pendingChatMessages.drain()
            chatDrainScheduled.set(false)
            canvas to messages
          }
        }
        batch?.let { (canvas, messages) ->
          messages.forEach { if (liveChatEnabled && !closed.get()) canvas.addLiveChatMessage(it) }
        }
        val morePending = synchronized(chatLock) {
          !pendingChatMessages.isEmpty() && overlayCanvas != null && liveChatEnabled && !closed.get()
        }
        if (morePending) scheduleChatDrain()
      }, CHAT_DRAIN_INTERVAL_MS)) {
      chatDrainScheduled.set(false)
    }
  }

  /** Nonblocking; keyframe-gated queue bounded by frame count and bytes. */
  fun offer(message: RtmpMessage) {
    if (closed.get() || message.type != 9 || message.data.size !in 6..2_097_152) return
    val keyframe = ReliableRtmpOutput.isAvcKeyframe(message)
    synchronized(lock) {
      if (pending.size >= MAX_PENDING_FRAMES || pendingBytes + message.data.size > MAX_PENDING_BYTES) {
        pending.clear()
        pendingBytes = 0
        awaitingKeyframe = true
        flushDecoder = true
        throttledStatus("Overlay encoder fell behind; waiting for a fresh keyframe")
      }
      if (awaitingKeyframe && !keyframe) return
      if (keyframe) awaitingKeyframe = false
      val copied = message.copy(data = message.data.copyOf())
      pending.addLast(Work(copied, keyframe))
      pendingBytes += copied.data.size
    }
    schedulePump()
  }

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    synchronized(lock) { pending.clear(); pendingBytes = 0; configMessage = null }
    synchronized(chatLock) { pendingChatMessages.clear(); overlayCanvas = null }
    handler.post {
      releaseCodecs()
      worker.quitSafely()
    }
    if (Thread.currentThread() !== worker) runCatching { worker.join(2_000) }
  }

  private fun schedulePump(delayMs: Long = 0L) {
    synchronized(lock) {
      if (scheduled || closed.get()) return
      scheduled = true
    }
    handler.postDelayed({ pump() }, delayMs)
  }

  private fun pump() {
    if (closed.get()) return
    var submittedInput = false
    var moreDecoderOutput = false
    try {
      val nextConfig = synchronized(lock) { configMessage.also { configMessage = null } }
      if (nextConfig != null) configure(nextConfig)
      val shouldFlush = synchronized(lock) { flushDecoder.also { flushDecoder = false } }
      if (shouldFlush) {
        decoder?.flush()
      }
      for (index in 0 until MAX_FEED_PER_PUMP) {
        val next = synchronized(lock) {
          pending.pollFirst()?.also { pendingBytes -= it.message.data.size }
        } ?: break
        if (!feedDecoder(next)) {
          synchronized(lock) { pending.addFirst(next); pendingBytes += next.message.data.size }
          break
        }
        submittedInput = true
      }
      moreDecoderOutput = drainDecoder()
      drainEncoder()
    } catch (error: Exception) {
      fail("Brand overlay video processing failed (${error.javaClass.simpleName})")
      return
    }
    synchronized(lock) { scheduled = false }
    if (hasWork() || submittedInput || moreDecoderOutput) schedulePump(PUMP_DELAY_MS)
  }

  private fun hasWork(): Boolean = synchronized(lock) {
    pending.isNotEmpty() || configMessage != null || flushDecoder
  }

  private fun configure(message: RtmpMessage) {
    releaseCodecs()
    val parsed = AvcFlv.parseConfig(message)
    val decoderInfo = findDecoder(parsed.width, parsed.height)
    val profile = chooseEncoderProfile(parsed.width, parsed.height, encodingProfile)
    outputWidth = profile.first
    outputHeight = profile.second
    outputFps = profile.third
    val outputBitrate = bitrateFor(outputWidth, outputHeight, encodingProfile)
    outputBitrateBps = outputBitrate

    val encoderInfo = findEncoder(outputWidth, outputHeight, outputFps, outputBitrate)
    val videoEncoder = MediaCodec.createByCodecName(encoderInfo.name)
    var createdInputSurface: Surface? = null
    var createdCompositor: GlBrandCompositor? = null
    try {
      val encodeFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, outputWidth, outputHeight).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, outputBitrate)
        setInteger(MediaFormat.KEY_FRAME_RATE, outputFps)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
        setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
        if (android.os.Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
      }
      videoEncoder.configure(encodeFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      val encoderSurface = videoEncoder.createInputSurface()
      createdInputSurface = encoderSurface
      val overlayCanvas = BrandOverlayCanvas(outputWidth, outputHeight, showBrandOverlay)
      synchronized(chatLock) {
        overlayCanvas.setLiveChatEnabled(liveChatEnabled)
        overlayCanvas.setLiveChatStatus(liveChatStatus)
        pendingChatMessages.drain().forEach(overlayCanvas::addLiveChatMessage)
        this.overlayCanvas = overlayCanvas
      }
      val gl = try {
        GlBrandCompositor(
          encoderSurface, parsed.width, parsed.height, outputWidth, outputHeight,
          rotateVideo180, overlayCanvas, handler,
          onFrame = { drainEncoder() },
          onFailure = { error -> fail("Brand overlay compositor failed (${error.javaClass.simpleName})") }
        )
      } catch (error: Exception) {
        synchronized(chatLock) { this.overlayCanvas = null }
        overlayCanvas.close()
        throw error
      }
      createdCompositor = gl
      val videoDecoder = MediaCodec.createByCodecName(decoderInfo.name)
      try {
        val decodeFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, parsed.width, parsed.height)
        decodeFormat.setByteBuffer("csd-0", ByteBuffer.wrap(byteArrayOf(0, 0, 0, 1) + parsed.sps))
        decodeFormat.setByteBuffer("csd-1", ByteBuffer.wrap(byteArrayOf(0, 0, 0, 1) + parsed.pps))
        videoDecoder.configure(decodeFormat, gl.decoderSurface, null, 0)
        videoEncoder.start()
        videoDecoder.start()
      } catch (error: Exception) {
        runCatching { videoDecoder.stop() }
        videoDecoder.release()
        throw error
      }
      decoder = videoDecoder
      encoder = videoEncoder
      outputCodecName = encoderInfo.name
      encoderInputSurface = encoderSurface
      createdInputSurface = null
      compositor = gl
      createdCompositor = null
      config = parsed
      announcedConfig = false
      lastOutputTimestampMs = -1L
      val cbrAdvertised = runCatching {
        encoderInfo.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).encoderCapabilities
          .isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
      }.getOrDefault(false)
      val status = if (encodingProfile.isSleipnirCapped) {
        val estimatedTotal = SleipnirRelay.projectedIngestBitrate(outputBitrate)
        val rateControl = if (cbrAdvertised) "CBR" else "CBR compatibility probe (not advertised)"
        "Sleipnir encoder ready · ${encoderInfo.name} · ${outputWidth}×${outputHeight}@$outputFps · " +
          "$rateControl · ${outputBitrate / 1_000} kb/s target video · est ${estimatedTotal / 1_000} kb/s total " +
          "(AAC + assumed 10% overhead) · output peak unverified · " +
          SleipnirRelay.youtube720p30BitrateNote(outputWidth, outputHeight, outputFps, outputBitrate) +
          (if (rotateVideo180) " · PS5 video rotated 180°; overlay remains upright" else "") +
          (if (!showBrandOverlay) " · HUD off" else "")
      } else {
        "@saevond overlay active · ${outputWidth}×${outputHeight} · up to ${outputFps} fps · H.264 hardware encode"
      }
      runCatching { onStatus(status) }
    } catch (error: Exception) {
      runCatching { createdCompositor?.close() }
      runCatching { videoEncoder.stop() }
      runCatching { videoEncoder.release() }
      runCatching { createdInputSurface?.release() }
      throw error
    }
  }

  private fun feedDecoder(work: Work): Boolean {
    val codec = decoder ?: return false
    val cfg = config ?: return false
    val payload = AvcFlv.sample(work.message, cfg) ?: return true
    val index = codec.dequeueInputBuffer(0L)
    if (index < 0) return false
    val pts = (work.message.timestamp + signed24(work.message.data, 2)).coerceAtLeast(0L) * 1_000L
    val buffer = codec.getInputBuffer(index)
    if (buffer == null) {
      codec.queueInputBuffer(index, 0, 0, pts, 0)
      throw IllegalStateException("Decoder input buffer was unavailable")
    }
    if (payload.size > buffer.capacity()) {
      codec.queueInputBuffer(index, 0, 0, pts, 0)
      throw IllegalArgumentException("Input AVC frame exceeds decoder buffer")
    }
    buffer.clear(); buffer.put(payload)
    val flags = if (work.isKeyframe) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
    codec.queueInputBuffer(index, 0, payload.size, pts, flags)
    return true
  }

  private fun drainDecoder(): Boolean {
    val codec = decoder ?: return false
    val info = MediaCodec.BufferInfo()
    repeat(MAX_DECODER_OUTPUT_PER_PUMP) {
      val index = codec.dequeueOutputBuffer(info, 0L)
      when {
        index >= 0 -> {
          codec.releaseOutputBuffer(index, info.size > 0)
          if (info.size > 0) return true
        }
        index == MediaCodec.INFO_TRY_AGAIN_LATER -> return false
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED || index == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> Unit
        else -> return false
      }
    }
    return false
  }

  private fun drainEncoder() {
    val codec = encoder ?: return
    val info = MediaCodec.BufferInfo()
    repeat(MAX_DRAIN_PER_PUMP) {
      val index = codec.dequeueOutputBuffer(info, 0L)
      when {
        index == MediaCodec.INFO_TRY_AGAIN_LATER -> return
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          val fmt = codec.outputFormat
          val sps = findNal(fmt.getByteBuffer("csd-0"), 7)
          val pps = findNal(fmt.getByteBuffer("csd-1"), 8)
          if (sps != null && pps != null) emitConfig(sps, pps)
        }
        index == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> Unit
        index >= 0 -> {
          val outputBuffer = codec.getOutputBuffer(index)
          try {
            if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
              if (announcedConfig) {
                val bytes = ByteArray(info.size)
                outputBuffer?.duplicate()?.apply { position(info.offset); limit(info.offset + info.size); get(bytes) }
                val key = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                val timestamp = (info.presentationTimeUs / 1_000L).coerceAtLeast(lastOutputTimestampMs + 1L)
                lastOutputTimestampMs = timestamp
                val packet = AvcFlv.toFlvFrame(bytes, key, timestamp)
                onOutput(packet)
              }
            } else if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0 && !announcedConfig) {
              val bytes = ByteArray(info.size)
              outputBuffer?.duplicate()?.apply { position(info.offset); limit(info.offset + info.size); get(bytes) }
              val sps = findNal(ByteBuffer.wrap(bytes), 7)
              val pps = findNal(ByteBuffer.wrap(bytes), 8)
              if (sps != null && pps != null) emitConfig(sps, pps)
            }
          } finally { codec.releaseOutputBuffer(index, false) }
        }
        else -> return
      }
    }
  }

  private fun emitConfig(sps: ByteArray, pps: ByteArray) {
    if (announcedConfig) return
    val avcc = AvcFlv.encoderConfig(sps, pps)
    onOutput(RtmpMessage(9, 0L, 1, byteArrayOf(0x17, 0, 0, 0, 0) + avcc))
    announcedConfig = true
  }

  private fun findDecoder(width: Int, height: Int): MediaCodecInfo =
    MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.firstOrNull { info ->
      !info.isEncoder && !info.isSoftwareOnly && info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) } &&
        runCatching { info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).videoCapabilities
          .let { it.areSizeAndRateSupported(width, height, 60.0) || it.areSizeAndRateSupported(width, height, 30.0) } }
          .getOrDefault(false)
    } ?: throw IllegalStateException("This phone has no hardware H.264 decoder for ${width}×${height}")

  private fun chooseEncoderProfile(
    sourceWidth: Int,
    sourceHeight: Int,
    requested: OverlayEncodingProfile
  ): Triple<Int, Int, Int> {
    fun fit(maxWidth: Int, maxHeight: Int): Pair<Int, Int> {
      val scale = minOf(1.0, maxWidth.toDouble() / sourceWidth, maxHeight.toDouble() / sourceHeight)
      return maxOf(16, (sourceWidth * scale).toInt() and -2) to
        maxOf(16, (sourceHeight * scale).toInt() and -2)
    }
    val targetSizes = when (requested) {
      OverlayEncodingProfile.HIGH_1080P ->
        listOf(1920 to 1080, 1280 to 720, 960 to 540, 854 to 480)
      OverlayEncodingProfile.STABLE_720P ->
        listOf(1280 to 720, 960 to 540, 854 to 480)
      OverlayEncodingProfile.LOW_LOAD_540P, OverlayEncodingProfile.SLEIPNIR_LOW_LOAD_540P ->
        listOf(960 to 540, 854 to 480, 640 to 360)
      OverlayEncodingProfile.SLEIPNIR_720P ->
        listOf(1280 to 720, 960 to 540, 854 to 480, 640 to 360)
    }
    val candidates = targetSizes.map { fit(it.first, it.second) }.distinct()
    val codecs = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { info ->
      info.isEncoder && !info.isSoftwareOnly && info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) }
    }
    val fpsTargets = if (requested.isSleipnirCapped || requested == OverlayEncodingProfile.LOW_LOAD_540P)
      listOf(30) else listOf(60, 30)
    for ((w, h) in candidates) {
      val bitrate = bitrateFor(w, h, requested)
      for (fps in fpsTargets) {
        if (codecs.any { info -> runCatching {
            val caps = info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
            caps.videoCapabilities.areSizeAndRateSupported(w, h, fps.toDouble()) &&
              bitrate in caps.videoCapabilities.bitrateRange &&
              (requested.isSleipnirCapped ||
                caps.encoderCapabilities.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR))
          }.getOrDefault(false) }) return Triple(w, h, fps)
      }
    }
    throw IllegalStateException("This phone has no supported H.264 hardware encoder profile for the selected quality")
  }

  private fun bitrateFor(width: Int, height: Int, requested: OverlayEncodingProfile): Int {
    if (requested.isSleipnirCapped) {
      return SleipnirRelay.videoBitrate(width, height, SleipnirRelay.MAX_VIDEO_BITRATE_BPS)
    }
    if (requested == OverlayEncodingProfile.LOW_LOAD_540P) {
      return SleipnirRelay.videoBitrate(width, height, 1_800_000)
    }
    return when {
      width >= 1920 && height >= 1080 -> 8_000_000
      width >= 1280 && height >= 720 && requested == OverlayEncodingProfile.HIGH_1080P -> 6_000_000
      width >= 1280 && height >= 720 -> 4_500_000
      else -> 3_000_000
    }
  }

  private fun findEncoder(width: Int, height: Int, fps: Int, bitrate: Int): MediaCodecInfo =
    MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.firstOrNull { info ->
      info.isEncoder && !info.isSoftwareOnly && info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) } &&
        runCatching {
          val caps = info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
          caps.videoCapabilities.areSizeAndRateSupported(width, height, fps.toDouble()) &&
            bitrate in caps.videoCapabilities.bitrateRange &&
            (encodingProfile.isSleipnirCapped ||
              caps.encoderCapabilities.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR))
        }.getOrDefault(false)
    } ?: throw IllegalStateException("H.264 hardware encoder is unavailable for this profile")

  private fun findNal(buffer: ByteBuffer?, kind: Int): ByteArray? {
    if (buffer == null) return null
    val copy = buffer.duplicate()
    val bytes = ByteArray(copy.remaining()); copy.get(bytes)
    return AvcFlv.splitNals(bytes).firstOrNull { it.isNotEmpty() && (it[0].toInt() and 31) == kind }
  }

  private fun signed24(data: ByteArray, offset: Int): Long {
    if (offset + 3 > data.size) return 0L
    val value = ((data[offset].toInt() and 255) shl 16) or ((data[offset + 1].toInt() and 255) shl 8) or
      (data[offset + 2].toInt() and 255)
    return if ((value and 0x800000) != 0) (value - 0x1000000).toLong() else value.toLong()
  }

  private fun throttledStatus(message: String) {
    val now = System.currentTimeMillis()
    if (now - lastStatusAt > 2_000) { lastStatusAt = now; onStatus(message) }
  }

  private fun fail(message: String) {
    if (!closed.compareAndSet(false, true)) return
    synchronized(chatLock) { pendingChatMessages.clear(); overlayCanvas = null }
    releaseCodecs()
    onFailure(message)
    worker.quitSafely()
  }

  private fun releaseCodecs() {
    runCatching { decoder?.stop() }; runCatching { decoder?.release() }; decoder = null
    runCatching { compositor?.close() }; compositor = null
    synchronized(chatLock) { overlayCanvas = null }
    runCatching { encoder?.stop() }; runCatching { encoder?.release() }; encoder = null
    runCatching { encoderInputSurface?.release() }; encoderInputSurface = null
    config = null
  }

  companion object {
    private const val CHAT_DRAIN_INTERVAL_MS = 50L
    private const val MAX_PENDING_FRAMES = 12
    private const val MAX_PENDING_BYTES = 6 * 1024 * 1024
    private const val MAX_FEED_PER_PUMP = 2
    private const val MAX_DECODER_OUTPUT_PER_PUMP = 1
    private const val MAX_DRAIN_PER_PUMP = 12
    private const val PUMP_DELAY_MS = 8L

  }
}

/** EGL compositor that draws decoded video and the transparent @saevond HUD to the encoder surface. */
private class GlBrandCompositor(
  encoderSurface: Surface,
  private val inputWidth: Int,
  private val inputHeight: Int,
  private val width: Int,
  private val height: Int,
  rotateVideo180: Boolean,
  private val overlay: BrandOverlayCanvas,
  handler: Handler,
  private val onFrame: () -> Unit,
  private val onFailure: (Exception) -> Unit
) : Closeable, SurfaceTexture.OnFrameAvailableListener {
  private val display: android.opengl.EGLDisplay
  private val context: android.opengl.EGLContext
  private val eglSurface: android.opengl.EGLSurface
  private val externalTexture: Int
  private val overlayTexture: Int
  private val program: Int
  private val overlayProgram: Int
  private val videoOutputTransform = OutputFrameTransform.videoGlMatrix(rotateVideo180)
  private val overlayOutputTransform = OutputFrameTransform.overlayGlMatrix()
  private lateinit var videoSurfaceTexture: SurfaceTexture
  private val rendererClosed = AtomicBoolean(false)
  val decoderSurface: Surface
  private val vertexData = floatBuffer(floatArrayOf(
    -1f,-1f, 0f,1f,  1f,-1f, 1f,1f,  -1f,1f, 0f,0f,  1f,1f, 1f,0f
  ))
  private val overlayData = floatBuffer(floatArrayOf(
    -1f,-1f, 0f,1f,  1f,-1f, 1f,1f,
    -1f,1f, 0f,0f,  1f,1f, 1f,0f
  ))

  init {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    require(display != EGL14.EGL_NO_DISPLAY && EGL14.eglInitialize(display, IntArray(2), 0, IntArray(2), 0))
    val configAttributes = intArrayOf(EGL14.EGL_SURFACE_TYPE,EGL14.EGL_WINDOW_BIT,
      EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
      EGL14.EGL_RED_SIZE,8, EGL14.EGL_GREEN_SIZE,8, EGL14.EGL_BLUE_SIZE,8, EGL14.EGL_ALPHA_SIZE,8,
      EGL_RECORDABLE_ANDROID,1,
      EGL14.EGL_NONE)
    val configs = arrayOfNulls<android.opengl.EGLConfig>(1)
    val count = IntArray(1)
    require(EGL14.eglChooseConfig(display, configAttributes, 0, configs, 0, configs.size, count, 0) && count[0] > 0)
    val eglConfig = configs[0]!!
    context = EGL14.eglCreateContext(display, eglConfig, EGL14.EGL_NO_CONTEXT,
      intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE),0)
    require(context != EGL14.EGL_NO_CONTEXT)
    eglSurface = EGL14.eglCreateWindowSurface(display, eglConfig, encoderSurface, intArrayOf(EGL14.EGL_NONE),0)
    require(eglSurface != EGL14.EGL_NO_SURFACE)
    makeCurrent()
    program = createProgram(VIDEO_VERTEX, VIDEO_FRAGMENT)
    overlayProgram = createProgram(OVERLAY_VERTEX, OVERLAY_FRAGMENT)
    externalTexture = createTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES)
    overlayTexture = createTexture(GLES20.GL_TEXTURE_2D)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, overlayTexture)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_WRAP_S,GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_WRAP_T,GLES20.GL_CLAMP_TO_EDGE)
    overlay.redrawIfDue()
    GLUtils.texImage2D(GLES20.GL_TEXTURE_2D,0,overlay.bitmap,0)
    videoSurfaceTexture = SurfaceTexture(externalTexture).apply {
      setDefaultBufferSize(inputWidth,inputHeight)
      setOnFrameAvailableListener(this@GlBrandCompositor,handler)
    }
    decoderSurface = Surface(videoSurfaceTexture)
  }

  override fun onFrameAvailable(surfaceTexture: SurfaceTexture) {
    if (rendererClosed.get()) return
    try {
      makeCurrent()
      surfaceTexture.updateTexImage()
      if (overlay.redrawIfDue()) {
        GLES20.glActiveTexture(GLES20.GL_TEXTURE1)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D,overlayTexture)
        GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D,0,0,0,overlay.bitmap)
      }
      val textureMatrix = FloatArray(16)
      surfaceTexture.getTransformMatrix(textureMatrix)
      GLES20.glViewport(0,0,width,height)
      GLES20.glDisable(GLES20.GL_BLEND)
      GLES20.glUseProgram(program)
      val position = GLES20.glGetAttribLocation(program,"aPosition")
      val texCoord = GLES20.glGetAttribLocation(program,"aTexCoord")
      val textureMatrixLocation = GLES20.glGetUniformLocation(program,"uTextureMatrix")
      val textureLocation = GLES20.glGetUniformLocation(program,"uTexture")
      bindAttributes(vertexData,position,texCoord)
      GLES20.glUniformMatrix4fv(textureMatrixLocation,1,false,textureMatrix,0)
      GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program,"uOutputMatrix"),1,false,videoOutputTransform,0)
      GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,externalTexture)
      GLES20.glUniform1i(textureLocation,0)
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4)
      GLES20.glUseProgram(overlayProgram)
      GLES20.glEnable(GLES20.GL_BLEND)
      GLES20.glBlendFunc(GLES20.GL_ONE,GLES20.GL_ONE_MINUS_SRC_ALPHA)
      val overlayPosition = GLES20.glGetAttribLocation(overlayProgram,"aPosition")
      val overlayTexCoord = GLES20.glGetAttribLocation(overlayProgram,"aTexCoord")
      bindAttributes(overlayData,overlayPosition,overlayTexCoord)
      GLES20.glActiveTexture(GLES20.GL_TEXTURE1)
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D,overlayTexture)
      GLES20.glUniform1i(GLES20.glGetUniformLocation(overlayProgram,"uTexture"),1)
      GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(overlayProgram,"uOutputMatrix"),1,false,overlayOutputTransform,0)
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4)
      GLES20.glDisable(GLES20.GL_BLEND)
      val pts = surfaceTexture.timestamp.coerceAtLeast(1L)
      EGLExt.eglPresentationTimeANDROID(display,eglSurface,pts)
      check(EGL14.eglSwapBuffers(display,eglSurface)) { "Encoder surface rejected a composed frame" }
      onFrame()
    } catch (error: Exception) {
      if (!rendererClosed.get()) onFailure(error)
    }
  }

  override fun close() {
    if (!rendererClosed.compareAndSet(false,true)) return
    runCatching { videoSurfaceTexture.setOnFrameAvailableListener(null) }
    runCatching { decoderSurface.release() }
    runCatching { videoSurfaceTexture.release() }
    runCatching {
      makeCurrent()
      GLES20.glDeleteTextures(2,intArrayOf(externalTexture,overlayTexture),0)
      GLES20.glDeleteProgram(program)
      GLES20.glDeleteProgram(overlayProgram)
    }
    EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT)
    EGL14.eglDestroySurface(display,eglSurface)
    EGL14.eglDestroyContext(display,context)
    EGL14.eglTerminate(display)
    overlay.close()
  }

  private fun makeCurrent() { check(EGL14.eglMakeCurrent(display,eglSurface,eglSurface,context)) { "Could not bind encoder EGL surface" } }

  private fun createTexture(target: Int): Int {
    val value=IntArray(1); GLES20.glGenTextures(1,value,0); GLES20.glBindTexture(target,value[0])
    GLES20.glTexParameteri(target,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_LINEAR)
    GLES20.glTexParameteri(target,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_LINEAR)
    GLES20.glTexParameteri(target,GLES20.GL_TEXTURE_WRAP_S,GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(target,GLES20.GL_TEXTURE_WRAP_T,GLES20.GL_CLAMP_TO_EDGE)
    return value[0]
  }

  private fun bindAttributes(data: FloatBuffer, positionLocation: Int, texLocation: Int) {
    data.position(0); GLES20.glEnableVertexAttribArray(positionLocation)
    GLES20.glVertexAttribPointer(positionLocation,2,GLES20.GL_FLOAT,false,16,data)
    data.position(2); GLES20.glEnableVertexAttribArray(texLocation)
    GLES20.glVertexAttribPointer(texLocation,2,GLES20.GL_FLOAT,false,16,data)
  }

  companion object {
    private const val EGL_RECORDABLE_ANDROID = 0x3142
    private const val VIDEO_VERTEX = """
      attribute vec4 aPosition; attribute vec4 aTexCoord;
      uniform mat4 uTextureMatrix; uniform mat4 uOutputMatrix; varying vec2 vTexCoord;
      void main(){ gl_Position=uOutputMatrix*aPosition; vTexCoord=(uTextureMatrix*aTexCoord).xy; }
    """
    private const val VIDEO_FRAGMENT = """
      #extension GL_OES_EGL_image_external : require
      precision mediump float; uniform samplerExternalOES uTexture; varying vec2 vTexCoord;
      void main(){ gl_FragColor=texture2D(uTexture,vTexCoord); }
    """
    private const val OVERLAY_VERTEX = """
      attribute vec4 aPosition; attribute vec2 aTexCoord; uniform mat4 uOutputMatrix; varying vec2 vTexCoord;
      void main(){ gl_Position=uOutputMatrix*aPosition; vTexCoord=aTexCoord; }
    """
    private const val OVERLAY_FRAGMENT = """
      precision mediump float; uniform sampler2D uTexture; varying vec2 vTexCoord;
      void main(){ gl_FragColor=texture2D(uTexture,vTexCoord); }
    """
    private fun floatBuffer(values: FloatArray): FloatBuffer =
      ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(values); position(0) }
    private fun createProgram(vertex: String, fragment: String): Int {
      fun shader(type: Int, source: String): Int {
        val shader=GLES20.glCreateShader(type); GLES20.glShaderSource(shader,source); GLES20.glCompileShader(shader)
        val status=IntArray(1); GLES20.glGetShaderiv(shader,GLES20.GL_COMPILE_STATUS,status,0)
        check(status[0] == GLES20.GL_TRUE) { GLES20.glGetShaderInfoLog(shader) }; return shader
      }
      val vs=shader(GLES20.GL_VERTEX_SHADER,vertex); val fs=shader(GLES20.GL_FRAGMENT_SHADER,fragment)
      val program=GLES20.glCreateProgram(); GLES20.glAttachShader(program,vs); GLES20.glAttachShader(program,fs); GLES20.glLinkProgram(program)
      val status=IntArray(1); GLES20.glGetProgramiv(program,GLES20.GL_LINK_STATUS,status,0)
      check(status[0] == GLES20.GL_TRUE) { GLES20.glGetProgramInfoLog(program) }
      GLES20.glDeleteShader(vs); GLES20.glDeleteShader(fs); return program
    }
  }
}
