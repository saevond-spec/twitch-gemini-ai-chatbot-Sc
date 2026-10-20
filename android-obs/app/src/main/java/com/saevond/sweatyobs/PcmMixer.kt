package com.saevond.sweatyobs

import kotlin.math.sqrt

/**
 * Mixes little-endian 16-bit stereo 48kHz PCM; both inputs must represent the same time window.
 * Returns conservative headroom, saturated samples, and an RMS diagnostic for game capture.
 * Android is not required, so this calculation can be tested on a JVM.
 */
object PcmMixer {
  const val SAMPLE_RATE = 48000
  const val FRAME_BYTES = 3840 // 20ms x 48kHz x 2ch x 2 bytes
  fun mix(game: ByteArray, music: ByteArray, gameGain: Double = 0.70, musicGain: Double = 0.25): ByteArray {
    require(game.size == music.size && game.size % 2 == 0)
    require(gameGain in 0.0..1.0 && musicGain in 0.0..1.0)
    val out = ByteArray(game.size)
    for (i in game.indices step 2) {
      val a = shortAt(game, i)
      val b = shortAt(music, i)
      val mixed = (a * gameGain + b * musicGain).toInt().coerceIn(-32768, 32767)
      out[i] = mixed.toByte()
      out[i + 1] = (mixed shr 8).toByte()
    }
    return out
  }
  fun rms(data: ByteArray): Double {
    if (data.isEmpty() || data.size % 2 != 0) return 0.0
    var energy = 0.0
    for (i in data.indices step 2) {
      val sample = shortAt(data, i) / 32768.0
      energy += sample * sample
    }
    return sqrt(energy / (data.size / 2))
  }
  private fun shortAt(data: ByteArray, index: Int): Int =
    (((data[index + 1].toInt() and 255) shl 8) or (data[index].toInt() and 255)).toShort().toInt()
}
