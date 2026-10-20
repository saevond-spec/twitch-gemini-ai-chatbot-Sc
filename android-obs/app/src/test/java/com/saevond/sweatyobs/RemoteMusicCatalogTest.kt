package com.saevond.sweatyobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteMusicCatalogTest {
  @Test fun catalogHasClubAndDubstepSongsFromNcs() {
    assertEquals(6, RemoteMusicCatalog.forGenre(GenrePlaylist.CLUB).size)
    assertEquals(8, RemoteMusicCatalog.forGenre(GenrePlaylist.DUBSTEP).size)
    assertEquals(14, RemoteMusicCatalog.tracks.size)
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
