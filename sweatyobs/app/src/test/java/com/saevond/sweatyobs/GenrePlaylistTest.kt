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

  @Test fun popAndTrapStationKeepsItsOwnCreatorClearedTracks() {
    val p = playlist()
    val track = RemoteMusicCatalog.forGenre(GenrePlaylist.POP_TRAP).first().audioUrl
    p.setTracks(GenrePlaylist.POP_TRAP, listOf(track))
    p.configure(GenrePlaylist.POP_TRAP, false, true)
    assertEquals(track, p.next())
    assertEquals(1, p.count(GenrePlaylist.POP_TRAP))
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
  @Test fun allowsOnlyVerifiedRemoteNcsTracks() {
    val p = GenrePlaylist()
    val remote = RemoteMusicCatalog.forGenre("club").first().audioUrl
    p.setTracks("club", listOf(remote))
    assertEquals(remote, p.next())
    try { p.setTracks("club", listOf("https://youtube.com/music")); fail() }
    catch (_: IllegalArgumentException) {}
    try { p.setTracks("club", listOf("https://ncs.io/track/download/00000000-0000-0000-0000-000000000000")); fail() }
    catch (_: IllegalArgumentException) {}
  }
  @Test fun rejectsInvalidStationAndOversizedCatalog() {
    val p = GenrePlaylist()
    try { p.configure("rock",true,true); fail() } catch (_: IllegalArgumentException) {}
    p.setTracks("club",List(GenrePlaylist.MAX_TRACKS_PER_GENRE){"content://club/$it"})
    assertEquals(100,p.count("club"))
    try { p.setTracks("dubstep",List(101){"content://dub/$it"});fail() } catch (_:IllegalArgumentException) {}
  }
}
