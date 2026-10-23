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
  private val showBrandOverlay: Boolean = true,
  private val maxVideoBitrate: Int = Int.MAX_VALUE
) : Closeable {
  private data class Work(val message: RtmpMessage, val isKeyframe: Boolean)
  private class StageFailure(val operation: String, cause: Exception) : Exception(cause.message, cause)
  private val worker = HandlerThread("SweatyOBS-brand-overlay").apply { start() }
  private val handler = Handler(worker.looper)
  private val lock = Any()
  private val pending = ArrayDeque<Work>()
  private var pendingBytes = 0
  private val closed = AtomicBoolean(false)
  private var configMessage: RtmpMessage? = null
  private var config: AvcFlvConfig? = null
  private var decoder: MediaCodec? = null
  private var encoder: MediaCodec? = null
  private var encoderInputSurface: Surface? = null
  private var compositor: GlBrandCompositor? = null
  private var awaitingKeyframe = true
  private var flushDecoder = false
  private var scheduled = false
  private var outputWidth = 0
  private var outputHeight = 0
  private var outputFps = 0
  private var lastOutputTimestampMs = -1L
  private var announcedConfig = false
  private var lastStatusAt = 0L

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
    var stage = "configuration"
    try {
      val nextConfig = synchronized(lock) { configMessage.also { configMessage = null } }
      if (nextConfig != null) configure(nextConfig)
      val shouldFlush = synchronized(lock) { flushDecoder.also { flushDecoder = false } }
      if (shouldFlush) {
        stage = "decoder reset"
        decoder?.flush()
      }
      stage = "decoder input"
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
      stage = "decoder output"
      moreDecoderOutput = drainDecoder()
      stage = "encoder output"
      drainEncoder()
    } catch (error: Exception) {
      fail(processingFailure(stage, error))
      return
    }
    synchronized(lock) { scheduled = false }
    if (hasWork() || submittedInput || moreDecoderOutput) schedulePump(PUMP_DELAY_MS)
  }

  private fun hasWork(): Boolean = synchronized(lock) {
    pending.isNotEmpty() || configMessage != null || flushDecoder
  }

  private fun configure(message: RtmpMessage) {
    atStage("release previous codec state") { releaseCodecs() }
    val parsed = atStage("parse input H.264 configuration") { AvcFlv.parseConfig(message) }
    val decoderInfo = atStage("select hardware H.264 decoder") { findDecoder(parsed.width, parsed.height) }
    val setup = atStage("select and configure supported hardware H.264 profile") {
      configureHardwareEncoder(parsed.width, parsed.height, maxVideoBitrate)
    }
    outputWidth = setup.width
    outputHeight = setup.height
    outputFps = setup.fps
    val videoEncoder = setup.codec
    var createdInputSurface: Surface? = setup.inputSurface
    var createdCompositor: GlBrandCompositor? = null
    try {
      val overlayCanvas = BrandOverlayCanvas(outputWidth, outputHeight, showBrandOverlay)
      val gl = try {
        atStage("initialize GLES compositor") {
          GlBrandCompositor(
            setup.inputSurface, parsed.width, parsed.height, outputWidth, outputHeight,
            overlayCanvas, handler,
            onFrame = {
              try { drainEncoder() }
              catch (error: Exception) { fail(processingFailure("encoder output after GLES render", error)) }
            },
            onFailure = { error -> fail(processingFailure("GLES compositor render", error)) }
          )
        }
      } catch (error: Exception) {
        overlayCanvas.close()
        throw error
      }
      createdCompositor = gl
      val videoDecoder = atStage("create decoder " + decoderInfo.name) {
        MediaCodec.createByCodecName(decoderInfo.name)
      }
      try {
        val decodeFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, parsed.width, parsed.height)
        decodeFormat.setByteBuffer("csd-0", ByteBuffer.wrap(byteArrayOf(0, 0, 0, 1) + parsed.sps))
        decodeFormat.setByteBuffer("csd-1", ByteBuffer.wrap(byteArrayOf(0, 0, 0, 1) + parsed.pps))
        atStage("configure decoder " + decoderInfo.name) {
          videoDecoder.configure(decodeFormat, gl.decoderSurface, null, 0)
        }
        atStage("start decoder " + decoderInfo.name) { videoDecoder.start() }
      } catch (error: Exception) {
        runCatching { videoDecoder.stop() }
        videoDecoder.release()
        throw error
      }
      decoder = videoDecoder
      encoder = videoEncoder
      encoderInputSurface = setup.inputSurface
      createdInputSurface = null
      compositor = gl
      createdCompositor = null
      config = parsed
      announcedConfig = false
      lastOutputTimestampMs = -1L

      val mode = if (showBrandOverlay) "@saevond overlay" else "RTMPS relay bitrate cap"
      val bitrateMode = if (setup.bitrateMode == MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR_FD) "CBR-FD" else "CBR"
      val status = if (maxVideoBitrate < Int.MAX_VALUE) {
        val projected = SleipnirRelay.projectedIngestBitrate(setup.bitrate).toInt()
        "Sleipnir encoder ready · " + setup.codecName + " · " + outputWidth + "×" + outputHeight +
          "@" + outputFps + " · " + bitrateMode + " · " + (setup.bitrate / 1_000) +
          " kb/s video · est " + (projected / 1_000) + " kb/s total"
      } else {
        mode + " active · " + outputWidth + "×" + outputHeight + " · up to " + outputFps +
          " fps · H.264 hardware encode · " + setup.codecName
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

  private data class EncoderSetup(
    val codec: MediaCodec,
    val inputSurface: Surface,
    val codecName: String,
    val width: Int,
    val height: Int,
    val fps: Int,
    val bitrate: Int,
    val bitrateMode: Int
  )

  private data class EncoderCandidate(
    val info: MediaCodecInfo,
    val width: Int,
    val height: Int,
    val fps: Int,
    val bitrate: Int,
    val bitrateMode: Int,
    val baselineProfile: Boolean,
    val sizeRank: Int,
    val codecRank: Int
  )

  private fun configureHardwareEncoder(sourceWidth: Int, sourceHeight: Int, maxBitrate: Int): EncoderSetup {
    val constrained = maxBitrate < Int.MAX_VALUE
    val fpsTargets = if (constrained) listOf(30, 24, 20, 15, 60) else listOf(60, 30)
    val avcEncoders = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { info ->
      runCatching {
        info.isEncoder && info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) }
      }.getOrDefault(false)
    }
    val classifications = avcEncoders.map { info ->
      val hardware = runCatching { info.isHardwareAccelerated }.getOrDefault(false)
      val software = runCatching { info.isSoftwareOnly }.getOrDefault(true)
      Triple(info, hardware, software)
    }
    val hardwareEncoders = classifications.filter { it.second && !it.third }.map { it.first }
    val excludedEncoderSummary = classifications.filterNot { it.second && !it.third }.take(4).joinToString(",") {
      it.first.name.take(10) + ":h" + (if (it.second) "1" else "0") + "s" + (if (it.third) "1" else "0")
    }.take(56)
    if (hardwareEncoders.isEmpty()) {
      throw IllegalStateException(
        "No hardware AVC encoder reported (seen=" + avcEncoders.size + ", excluded=" + excludedEncoderSummary + ")"
      )
    }

    var supportedSizeRates = 0
    var bitrateFits = 0
    var bitrateModeFits = 0
    var setupAttempts = 0
    var lastFailure = ""
    for (fps in fpsTargets) {
      val candidates = mutableListOf<EncoderCandidate>()
      for ((codecRank, info) in hardwareEncoders.withIndex()) {
        try {
          val caps = info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
          val video = caps.videoCapabilities
          val sizes = SleipnirRelay.candidateSizes(
            sourceWidth, sourceHeight, video.widthAlignment, video.heightAlignment
          ).let { if (constrained) it else it.take(2) }
          val modes = buildList {
            if (caps.encoderCapabilities.isBitrateModeSupported(
                MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
              )) add(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
            if (android.os.Build.VERSION.SDK_INT >= 31 &&
              caps.encoderCapabilities.isBitrateModeSupported(
                MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR_FD
              )
            ) add(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR_FD)
          }
          val baselineSupported = caps.profileLevels.any {
            it.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline
          }
          for ((sizeRank, size) in sizes.withIndex()) {
            val width = size.first
            val height = size.second
            if (!video.areSizeAndRateSupported(width, height, fps.toDouble())) continue
            supportedSizeRates++
            val target = SleipnirRelay.videoBitrate(width, height, maxBitrate)
            val bitrate = SleipnirRelay.fitCodecBitrate(
              target, video.bitrateRange.lower, video.bitrateRange.upper, maxBitrate
            ) ?: continue
            bitrateFits++
            for (mode in modes) {
              bitrateModeFits++
              candidates.add(
                EncoderCandidate(
                  info, width, height, fps, bitrate, mode, baselineSupported, sizeRank, codecRank
                )
              )
            }
          }
        } catch (_: Exception) {
          // An advertised codec can still expose incomplete or inconsistent capability data.
        }
      }

      val rankedCandidates = candidates.sortedWith(
        compareBy<EncoderCandidate> { it.sizeRank }
          .thenBy { it.codecRank }
          .thenBy {
            if (it.bitrateMode == MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR) 0 else 1
          }
      )
      for (candidate in rankedCandidates) {
        setupAttempts++
        var codec: MediaCodec? = null
        var inputSurface: Surface? = null
        try {
          codec = MediaCodec.createByCodecName(candidate.info.name)
          val format = MediaFormat.createVideoFormat(
            MediaFormat.MIMETYPE_VIDEO_AVC, candidate.width, candidate.height
          ).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, candidate.bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, candidate.fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            setInteger(MediaFormat.KEY_BITRATE_MODE, candidate.bitrateMode)
            if (candidate.baselineProfile) {
              setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            }
            if (android.os.Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
          }
          codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
          inputSurface = codec.createInputSurface()
          codec.start()
          return EncoderSetup(
            codec, inputSurface, candidate.info.name, candidate.width, candidate.height,
            candidate.fps, candidate.bitrate, candidate.bitrateMode
          )
        } catch (error: Exception) {
          lastFailure = candidate.info.name.take(24) + ":" + error.javaClass.simpleName
          runCatching { codec?.stop() }
          runCatching { codec?.release() }
          runCatching { inputSurface?.release() }
        }
      }
    }

    val reason = if (lastFailure.isBlank()) "" else "; last " + lastFailure
    val excluded = if (excludedEncoderSummary.isBlank()) "" else "; excluded=" + excludedEncoderSummary
    throw IllegalStateException(
      "No hardware AVC profile (enc=" + hardwareEncoders.size +
        ", size/fps=" + supportedSizeRates + ", rate=" + bitrateFits +
        ", CBR=" + bitrateModeFits + ", setup=" + setupAttempts + ")" + reason + excluded
    )
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

  private inline fun <T> atStage(operation: String, action: () -> T): T = try {
    action()
  } catch (error: Exception) {
    if (error is StageFailure) throw error
    throw StageFailure(operation, error)
  }

  private fun processingFailure(stage: String, error: Exception): String {
    val stageFailure = error as? StageFailure
    val root = stageFailure?.cause as? Exception ?: error
    val operation = stageFailure?.operation ?: stage
    val detail = root.message?.lineSequence()?.firstOrNull()?.take(180).orEmpty()
    val codecError = (root as? MediaCodec.CodecException)?.let {
      " · diagnostic ${it.diagnosticInfo} · recoverable ${it.isRecoverable} · transient ${it.isTransient}"
    }.orEmpty()
    val codecs = listOfNotNull(
      runCatching { decoder?.name?.let { "decoder=$it" } }.getOrNull(),
      runCatching { encoder?.name?.let { "encoder=$it" } }.getOrNull()
    ).joinToString(" ")
    return "Video processing failed at $operation (${root.javaClass.simpleName})" +
      (if (detail.isBlank()) "" else ": $detail") +
      codecError +
      (if (codecs.isBlank()) "" else " · $codecs")
  }

  private fun throttledStatus(message: String) {
    val now = System.currentTimeMillis()
    if (now - lastStatusAt > 2_000) { lastStatusAt = now; onStatus(message) }
  }

  private fun fail(message: String) {
    if (!closed.compareAndSet(false, true)) return
    releaseCodecs()
    onFailure(message)
    worker.quitSafely()
  }

  private fun releaseCodecs() {
    runCatching { decoder?.stop() }; runCatching { decoder?.release() }; decoder = null
    runCatching { compositor?.close() }; compositor = null
    runCatching { encoder?.stop() }; runCatching { encoder?.release() }; encoder = null
    runCatching { encoderInputSurface?.release() }; encoderInputSurface = null
    config = null
  }

  companion object {
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
      uniform mat4 uTextureMatrix; varying vec2 vTexCoord;
      void main(){ gl_Position=aPosition; vTexCoord=(uTextureMatrix*aTexCoord).xy; }
    """
    private const val VIDEO_FRAGMENT = """
      #extension GL_OES_EGL_image_external : require
      precision mediump float; uniform samplerExternalOES uTexture; varying vec2 vTexCoord;
      void main(){ gl_FragColor=texture2D(uTexture,vTexCoord); }
    """
    private const val OVERLAY_VERTEX = """
      attribute vec4 aPosition; attribute vec2 aTexCoord; varying vec2 vTexCoord;
      void main(){ gl_Position=aPosition; vTexCoord=aTexCoord; }
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
