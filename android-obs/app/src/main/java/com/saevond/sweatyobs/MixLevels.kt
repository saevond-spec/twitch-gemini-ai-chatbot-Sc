package com.saevond.sweatyobs

import kotlin.math.min

/**
 * Live-safe volume settings; percentages are linear amplitude controls, not power.
 * Bound worst-case fully correlated waveforms by g_game + g_music <= 0.98.
 * The bound works regardless of the content's peaks and needs no dynamic clipping.
 */
class MixLevels(game: Int = 85, music: Int = 20) {
  @Volatile var gamePercent: Int = game.coerceIn(0, 100)
    private set
  @Volatile var musicPercent: Int = music.coerceIn(0, 100)
    private set

  @Synchronized fun update(game: Int, music: Int) {
    require(game in 0..100 && music in 0..100)
    gamePercent = game
    musicPercent = music
  }

  /** A snapshot used for one audio window, avoiding mixed old/new slider values. */
  @Synchronized fun gains(musicIsPlaying: Boolean): Pair<Double, Double> {
    val rawGame = gamePercent / 100.0
    val rawMusic = if (musicIsPlaying) musicPercent / 100.0 else 0.0
    val peakBound = rawGame + rawMusic
    val scale = if (peakBound > 0.98) 0.98 / peakBound else 1.0
    return Pair(rawGame * scale, rawMusic * scale)
  }

  fun description(): String = "Game ${gamePercent}% · Music ${musicPercent}%"
}
