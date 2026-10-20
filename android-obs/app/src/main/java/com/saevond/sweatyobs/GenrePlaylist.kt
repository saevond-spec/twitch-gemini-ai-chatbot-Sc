package com.saevond.sweatyobs

import kotlin.random.Random

/** Pure, testable licensed-file selection. No network, audio capture or disk writes. */
class GenrePlaylist(private val random: Random = Random.Default) {
  companion object {
    const val CLUB = "club"
    const val DUBSTEP = "dubstep"
    const val MIXED = "mixed"
    val STATIONS = setOf(CLUB, DUBSTEP, MIXED)
    const val MAX_TRACKS_PER_GENRE = 20
  }
  private val catalogs = mutableMapOf(CLUB to emptyList<String>(), DUBSTEP to emptyList())
  private var deck = ArrayDeque<String>()
  private var current: String? = null
  var station: String = MIXED
    private set
  var shuffle: Boolean = true
    private set
  var autoNext: Boolean = true
    private set

  @Synchronized fun configure(station: String, shuffle: Boolean, autoNext: Boolean) {
    require(station in STATIONS)
    val changed = station != this.station || shuffle != this.shuffle
    this.station = station
    this.shuffle = shuffle
    this.autoNext = autoNext
    if (changed) { deck.clear(); current = null }
  }

  @Synchronized fun setTracks(genre: String, uris: List<String>) {
    require(genre == CLUB || genre == DUBSTEP)
    require(uris.size <= MAX_TRACKS_PER_GENRE)
    require(uris.all { it.startsWith("content://") && it.length <= 2048 })
    catalogs[genre] = uris.distinct()
    deck.clear()
    current = null
  }
  @Synchronized fun count(genre: String): Int = catalogs[genre]?.size ?: 0
  @Synchronized fun hasTracks(): Boolean = pool().isNotEmpty()

  private fun pool(): List<String> = when (station) {
    CLUB -> catalogs[CLUB].orEmpty()
    DUBSTEP -> catalogs[DUBSTEP].orEmpty()
    else -> (catalogs[CLUB].orEmpty() + catalogs[DUBSTEP].orEmpty()).distinct()
  }

  /** Manual skip always advances; auto-next advances only when enabled. */
  @Synchronized fun next(manual: Boolean = true): String? {
    if (!manual && !autoNext) return current
    val available = pool()
    if (available.isEmpty()) { deck.clear(); current = null; return null }
    if (deck.isEmpty()) {
      val next = if (shuffle) available.shuffled(random) else available
      // At wrap, avoid repeating the same track consecutively.
      val arranged = next.toMutableList()
      if (arranged.size > 1 && arranged.first() == current) {
        val first = arranged.removeAt(0)
        arranged.add(first)
      }
      deck.addAll(arranged)
    }
    current = deck.removeFirst()
    return current
  }
  @Synchronized fun current(): String? = current
  @Synchronized fun summary(): String =
    station + " · Club " + count(CLUB) + " / Dubstep " + count(DUBSTEP) +
      " · shuffle " + shuffle + " · auto-next " + autoNext
}
