package com.saevond.sweatyobs
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class GenrePlaylistTest {
  private fun playlist() = GenrePlaylist(Random(10)).apply {
    setTracks("club", listOf("content://club/a", "content://club/b", "content://club/c"))
    setTracks("dubstep", listOf("content://dub/1", "content://dub/2"))
  }
  @Test fun clubAndDubstepOnlyPlayTheirOwnTracks() {
    val p = playlist()
    p.configure("club",true,true)
    repeat(15) { assertTrue(p.next()!!.startsWith("content://club/")) }
    p.configure("dubstep",true,true)
    repeat(15) { assertTrue(p.next()!!.startsWith("content://dub/")) }
  }
  @Test fun mixedShuffledDeckVisitsAllTracksBeforeRepeating() {
    val p=playlist()
    p.configure("mixed",true,true)
    val cycle=(0 until 5).map { p.next()!! }
    assertEquals(5, cycle.toSet().size)
    assertTrue(cycle.any { it.contains("club") })
    assertTrue(cycle.any { it.contains("dub") })
    assertNotEquals(cycle.last(), p.next())
  }
  @Test fun autoNextDisabledLoopsExistingButSkipStillAdvances() {
    val p=playlist()
    p.configure("club",false,false)
    assertEquals("content://club/a",p.next())
    assertEquals("content://club/a",p.next(manual=false))
    assertEquals("content://club/b",p.next(manual=true))
  }
  @Test fun stationSwitchRebuildsDeckAndEmptyGenreFailsWithoutWrongMusic() {
    val p=playlist()
    p.configure("mixed",true,true)
    p.next()
    p.setTracks("dubstep",emptyList())
    p.configure("dubstep",true,true)
    assertNull(p.next())
    p.configure("club",true,true)
    assertNotNull(p.next())
  }
  @Test fun rejectsUntrustedOrHugeCatalog() {
    val p=GenrePlaylist()
    try {p.setTracks("club",listOf("https://youtube.com/music")); fail()}catch (_: IllegalArgumentException){}
    try {p.configure("rock",true,true); fail()}catch (_: IllegalArgumentException){}
    try{p.setTracks("dubstep",List(21){"content://dub/$it"});fail()}catch (_:IllegalArgumentException){}
  }
}
