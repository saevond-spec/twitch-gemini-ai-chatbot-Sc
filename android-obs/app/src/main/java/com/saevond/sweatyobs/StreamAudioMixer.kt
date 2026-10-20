package com.saevond.sweatyobs

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.os.Process
import com.pedro.encoder.input.sources.audio.BufferAudioSource
import kotlin.concurrent.thread
import kotlin.math.min

/**
 * Single Android AAC input: permitted playback capture + licensed local music.
 * Captured app sound may be silent if the other app disallows recording.
 * AudioRecord is used ONLY with MediaProjection and the OS capture policy.
 */
class StreamAudioMixer(
  private val projection: MediaProjection,
  val source: BufferAudioSource = BufferAudioSource(1000, 100)
) {
  @Volatile private var running = false
  @Volatile private var playing = false
  @Volatile private var music: ByteArray = byteArrayOf()
  @Volatile var gameRms = 0.0
    private set
  @Volatile var musicRms = 0.0
    private set
  @Volatile var captureReadErrors = 0
    private set
  private var audioRecord: AudioRecord? = null
  private var worker: Thread? = null
  private var offset = 0

  fun replaceTrack(pcmStereo48k: ByteArray) {
    require(pcmStereo48k.size % 4 == 0)
    music = pcmStereo48k.copyOf()
    offset = 0
  }
  fun command(action: String) {
    when (action) {
      "play" -> playing = music.isNotEmpty()
      "pause" -> playing = false
      "skip" -> { offset = 0; playing = music.isNotEmpty() }
      else -> throw IllegalArgumentException("Unsupported action")
    }
  }
  fun start() {
    check(!running)
    val configuration = AudioPlaybackCaptureConfiguration.Builder(projection)
      .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
      .addMatchingUsage(AudioAttributes.USAGE_GAME)
      .build()
    val format = AudioFormat.Builder()
      .setSampleRate(PcmMixer.SAMPLE_RATE)
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
      .build()
    val minBuffer = AudioRecord.getMinBufferSize(
      PcmMixer.SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
    check(minBuffer > 0) { "Playback recording unsupported" }
    val recorder = AudioRecord.Builder()
      .setAudioFormat(format)
      .setAudioPlaybackCaptureConfig(configuration)
      .setBufferSizeInBytes(maxOf(minBuffer, PcmMixer.FRAME_BYTES * 8))
      .build()
    check(recorder.state == AudioRecord.STATE_INITIALIZED) { "Playback recording not initialized" }
    audioRecord = recorder
    recorder.startRecording()
    running = true
    worker = thread(start = true, name = "SweatyOBS-mixer") {
      Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
      val game = ByteArray(PcmMixer.FRAME_BYTES)
      while (running) {
        val read = recorder.read(game, 0, game.size, AudioRecord.READ_BLOCKING)
        if (read < 0) {
          captureReadErrors++
          if (captureReadErrors > 5) break
          continue
        }
        if (read == 0) continue
        if (read < game.size) game.fill(0, read, game.size)
        val musicFrame = ByteArray(game.size)
        val track = music
        if (playing && track.isNotEmpty()) {
          // Read a 20ms chunk from a locally decoded, licensed track.
          var written = 0
          while (written < musicFrame.size) {
            val left = track.size - offset
            val take = min(left, musicFrame.size - written)
            System.arraycopy(track, offset, musicFrame, written, take)
            written += take
            offset = (offset + take) % track.size
          }
        }
        gameRms = PcmMixer.rms(game)
        musicRms = PcmMixer.rms(musicFrame)
        val mixed = PcmMixer.mix(game, musicFrame)
        source.setBuffer(mixed)
      }
      running = false
    }
  }
  fun stop() {
    running = false
    runCatching { audioRecord?.stop() }
    worker?.join(500)
    runCatching { audioRecord?.release() }
    audioRecord = null
    worker = null
  }
}
