package com.saevond.sweatyobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteMusicCatalogTest {
  @Test fun catalogHasOneHundredCreatorTracksAcrossThreePlaylists() {
    assertEquals(60, RemoteMusicCatalog.forGenre(GenrePlaylist.CLUB).size)
    assertEquals(15, RemoteMusicCatalog.forGenre(GenrePlaylist.DUBSTEP).size)
    assertEquals(25, RemoteMusicCatalog.forGenre(GenrePlaylist.POP_TRAP).size)
    assertEquals(100, RemoteMusicCatalog.tracks.size)
    assertEquals(100, RemoteMusicCatalog.tracks.map { it.audioUrl }.toSet().size)
    assertTrue(RemoteMusicCatalog.tracks.all {
      RemoteMusicCatalog.isSupportedAudioUrl(it.audioUrl) && it.pageUrl.startsWith("https://ncs.io/")
    })
    val credits = RemoteMusicCatalog.creditsForAudioUrls(RemoteMusicCatalog.tracks.map { it.audioUrl })
    assertEquals(100, Regex("(?m)^Song:").findAll(credits).count())
  }

  @Test fun onlyKnownHttpsNcsDownloadRoutesAreAccepted() {
    val official = RemoteMusicCatalog.tracks.first().audioUrl
    assertTrue(RemoteMusicCatalog.isSupportedAudioUrl(official))
    assertFalse(RemoteMusicCatalog.isSupportedAudioUrl(official.replaceFirst("https://", "http://")))
    assertFalse(RemoteMusicCatalog.isSupportedAudioUrl(official.replace("ncs.io", "ncs.io.example")))
    assertFalse(RemoteMusicCatalog.isSupportedAudioUrl(official + "?next=https://example.com"))
    assertFalse(RemoteMusicCatalog.isSupportedAudioUrl(
      "https://ncs.io/track/download/00000000-0000-0000-0000-000000000000"
    ))
  }

  @Test fun songCreditsReferBackToTheOfficialNcsPage() {
    val track = RemoteMusicCatalog.tracks.first()
    assertNotNull(RemoteMusicCatalog.trackForAudioUrl(track.audioUrl))
    val credit = RemoteMusicCatalog.creditsForAudioUrls(listOf(track.audioUrl))
    assertTrue(credit.contains("Song: " + track.songCredit))
    assertTrue(credit.contains(track.pageUrl))
    assertEquals("Music provided by http://spoti.fi/NCS", RemoteMusicCatalog.LIVE_STREAM_CREDIT)
  }
}
