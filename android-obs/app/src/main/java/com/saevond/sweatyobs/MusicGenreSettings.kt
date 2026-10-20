package com.saevond.sweatyobs

import android.content.Context
import org.json.JSONArray

/** Persist user-granted local URIs and allowlisted NCS track URLs, never audio bytes. */
class MusicGenreSettings(context: Context) {
  private val prefs = context.getSharedPreferences("ps5_music", Context.MODE_PRIVATE)
  fun tracks(genre: String): List<String> {
    require(genre == "club" || genre == "dubstep")
    val data = prefs.getString("library_$genre", "[]") ?: "[]"
    return runCatching {
      val parsed = JSONArray(data)
      (0 until minOf(parsed.length(), GenrePlaylist.MAX_TRACKS_PER_GENRE))
        .map { parsed.getString(it) }.filter { (it.startsWith("content://") && it.length <= 2048) || RemoteMusicCatalog.isSupportedAudioUrl(it) }
        .distinct()
    }.getOrDefault(emptyList())
  }
  fun add(genre: String, tracks: List<String>) {
    require(genre == "club" || genre == "dubstep")
    require(tracks.all { (it.startsWith("content://") && it.length <= 2048) || RemoteMusicCatalog.isSupportedAudioUrl(it) })
    val combined = (tracks(genre) + tracks).distinct().take(GenrePlaylist.MAX_TRACKS_PER_GENRE)
    prefs.edit().putString("library_$genre", JSONArray(combined).toString()).apply()
  }
  fun clear(genre: String) {
    require(genre == "club" || genre == "dubstep")
    prefs.edit().remove("library_$genre").apply()
  }
  fun selected(): String = prefs.getString("station", "mixed").orEmpty().let {
    if (it in GenrePlaylist.STATIONS) it else "mixed"
  }
  fun select(station: String) {
    require(station in GenrePlaylist.STATIONS)
    prefs.edit().putString("station", station).apply()
  }
  fun shuffle() = prefs.getBoolean("shuffle", true)
  fun autoNext() = prefs.getBoolean("auto_next", true)
  fun setShuffle(on: Boolean) { prefs.edit().putBoolean("shuffle", on).apply() }
  fun setAutoNext(on: Boolean) { prefs.edit().putBoolean("auto_next", on).apply() }
  fun playlist() = GenrePlaylist().also {
    it.setTracks("club", tracks("club"))
    it.setTracks("dubstep", tracks("dubstep"))
    it.configure(selected(), shuffle(), autoNext())
  }
}
