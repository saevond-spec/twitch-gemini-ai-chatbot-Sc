package com.saevond.sweatyobs

import java.net.URI

data class RemoteMusicTrack(
  val id: String,
  val title: String,
  val artist: String,
  val genre: String,
  val audioUrl: String,
  val pageUrl: String,
  val songCredit: String
)

/**
 * A small, curated in-app catalog of tracks published on NCS's official site.
 * Audio is fetched directly from ncs.io when selected and decoded in memory.
 */
object RemoteMusicCatalog {
  const val CATALOG_PAGE_URL = "https://ncs.io/music-search"
  const val LIVE_STREAM_CREDIT = "Music provided by http://spoti.fi/NCS"

  val tracks: List<RemoteMusicTrack> = listOf(
    RemoteMusicTrack("ncs-house-desire", "Desire", "gabriawll & Ada Petcu", "club",
      "https://ncs.io/track/download/d06186d5-dda6-4b38-86e0-833cec06c107",
      "https://ncs.io/g_desire", "Gabriawll - Desire ft Ada Petcu"),
    RemoteMusicTrack("ncs-house-halcyon", "halcyon", "onte", "club",
      "https://ncs.io/track/download/0a244df4-594a-4f35-8e48-ef45a4c69de1",
      "https://ncs.io/o_halcyon", "onte - halcyon"),
    RemoteMusicTrack("ncs-house-defect", "Defect", "Reece Rosé", "club",
      "https://ncs.io/track/download/982322fd-acc6-4571-b2c7-bee9bc3a81a5",
      "https://ncs.io/Defect", "Reece Rosé - Defect"),
    RemoteMusicTrack("ncs-house-free", "Free", "Reece Rosé", "club",
      "https://ncs.io/track/download/dc515b2d-711f-42f4-9bd0-6dc258819e2f",
      "https://ncs.io/RR_Free", "Reece Rosé - Free"),
    RemoteMusicTrack("ncs-house-brighter-days", "Brighter Days", "Hester", "club",
      "https://ncs.io/track/download/bf45844c-a54d-416e-a19f-d50d9d9eaa78",
      "https://ncs.io/brighterdays", "HESTER - Brighter Days"),
    RemoteMusicTrack("ncs-house-this-feeling", "This Feeling", "Reece Rosé & STREETSINEZ", "club",
      "https://ncs.io/track/download/c7be5639-edaa-4777-9518-28931b22ea57",
      "https://ncs.io/thisfeeling", "Reece Rose - This Feeling"),

    RemoteMusicTrack("ncs-dubstep-fight-in-me", "Fight In Me", "Egzod, Lost Sky & Alaina Cross", "dubstep",
      "https://ncs.io/track/download/9d21e3b9-a69c-4b26-82c1-e2ce74fc0b4a",
      "https://ncs.io/fightinme", "Egzod, Lost Sky, Alaina Cross - Fight In Me"),
    RemoteMusicTrack("ncs-dubstep-falling-4-u", "Falling 4 U", "ROY KNOX", "dubstep",
      "https://ncs.io/track/download/4a46adda-9404-4497-a640-832aa50a9ddb",
      "https://ncs.io/Falling4U", "ROY KNOX - FALLING 4 YOU"),
    RemoteMusicTrack("ncs-dubstep-deep-end", "Deep End", "FLOTE, Fendy Cisneros & Luxtides", "dubstep",
      "https://ncs.io/track/download/b06b1c0b-be67-41f8-99e4-a578f250dad6",
      "https://ncs.io/deepend", "FLOTE, Fendy Cisneros, Luxtides - Deep End"),
    RemoteMusicTrack("ncs-dubstep-slip-thru", "Slip Thru", "Barren Gates & Taylor Ravenna", "dubstep",
      "https://ncs.io/track/download/22cb73da-dd36-4c4a-97d9-ccb82cf218ba",
      "https://ncs.io/slipthru", "Barren Gates & Taylor Ravenna - Slip Thru"),
    RemoteMusicTrack("ncs-dubstep-blindfold", "Blindfold", "Warriyo & Laura Brehm", "dubstep",
      "https://ncs.io/track/download/75cbeab8-77ce-425a-9fe8-110131bea50a",
      "https://ncs.io/blindfold", "Warriyo & Laura Brehm - Blindfold"),
    RemoteMusicTrack("ncs-dubstep-need-you-again", "Need You Again", "SadBois, ROY KNOX & Jake Neumar", "dubstep",
      "https://ncs.io/track/download/f879c74f-8eca-472b-b52e-52756a6f2835",
      "https://ncs.io/needyouagain", "Roy Knox, Sadbois - Need You Again"),
    RemoteMusicTrack("ncs-dubstep-like-fire", "Like Fire", "Apollo On The Run, Immy Odon & Biometrix", "dubstep",
      "https://ncs.io/track/download/4a0ad566-21b3-42ea-bb6b-836dd9809cd6",
      "https://ncs.io/LikeFire", "Biometrix, Immy Odon, Apollo On The Run - Like Fire"),
    RemoteMusicTrack("ncs-dubstep-fading-light", "Fading Light", "Fytch", "dubstep",
      "https://ncs.io/track/download/9c423741-09f3-4e59-9e6b-ab2e7683c1f2",
      "https://ncs.io/FadingLight", "Fytch - Fading Light")
  )

  private val ncsDownloadPath = Regex(
    "^/track/download/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
  )

  fun forGenre(genre: String): List<RemoteMusicTrack> =
    tracks.filter { it.genre == genre }

  fun isSupportedAudioUrl(value: String): Boolean {
    val safeNcsRoute = runCatching {
      val uri = URI(value)
      uri.scheme == "https" &&
        uri.host == "ncs.io" &&
        uri.port == -1 &&
        uri.userInfo == null &&
        uri.rawQuery == null &&
        uri.rawFragment == null &&
        ncsDownloadPath.matches(uri.rawPath ?: "")
    }.getOrDefault(false)
    return safeNcsRoute && tracks.any { it.audioUrl == value }
  }

  fun trackForAudioUrl(value: String): RemoteMusicTrack? =
    tracks.firstOrNull { it.audioUrl == value && isSupportedAudioUrl(value) }

  fun creditsForAudioUrls(values: List<String>): String =
    values.distinct().mapNotNull { trackForAudioUrl(it) }.joinToString("\n\n") {
      "Song: ${it.songCredit}\nMusic provided by NoCopyrightSounds\nFree Download/Stream: ${it.pageUrl}"
    }
}
