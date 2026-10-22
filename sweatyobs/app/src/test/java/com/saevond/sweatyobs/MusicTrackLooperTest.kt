package com.saevond.sweatyobs

import org.junit.Assert.*
import org.junit.Test

class MusicTrackLooperTest {
 @Test fun pausingKeepsGameAudioUnchangedAndMusicWindowSilent() {
   val loop = MusicTrackLooper()
   loop.load(byteArrayOf(1,2,3,4,5,6,7,8))
   assertFalse(loop.playing)
   assertArrayEquals(ByteArray(8), loop.nextWindow(8))
   loop.command("play")
   assertArrayEquals(byteArrayOf(1,2,3,4,5,6,7,8,1,2,3,4),loop.nextWindow(12))
   loop.command("pause")
   assertArrayEquals(ByteArray(8), loop.nextWindow(8))
 }
 @Test fun skipRestartsRightsClearedTrackWithoutStorageOrNetwork() {
   val loop=MusicTrackLooper()
   loop.load(byteArrayOf(1,2,3,4,5,6,7,8))
   loop.command("play")
   loop.nextWindow(4)
   loop.command("skip")
   assertArrayEquals(byteArrayOf(1,2,3,4),loop.nextWindow(4))
   loop.clear()
   assertFalse(loop.ready)
   assertFalse(loop.playing)
 }
 @Test fun licensedMusicAutostartsOnlyWhenTwitchPublishingActuallyBegins() {
   val loop = MusicTrackLooper()
   loop.load(byteArrayOf(1,2,3,4,5,6,7,8), autoStart = true)
   assertFalse("No autoplay during receiver arming or diagnostics", loop.playing)
   assertArrayEquals(ByteArray(8), loop.nextWindow(8))
   assertTrue("Autoplay starts after Twitch publish acknowledgement", loop.onBroadcastStarted())
   assertTrue(loop.playing)
   assertArrayEquals(byteArrayOf(1,2,3,4),loop.nextWindow(4))
   assertTrue(loop.onBroadcastStarted()) // only initial start is an auto-change
 }
 @Test fun explicitPauseBeforePublishOverridesAutoplay() {
   val loop = MusicTrackLooper()
   loop.load(byteArrayOf(1,2,3,4), autoStart = true)
   loop.command("pause")
   assertFalse(loop.onBroadcastStarted())
   assertFalse(loop.playing)
   loop.command("play")
   assertTrue(loop.playing)
 }
 @Test fun disabledAutoplayDoesNotBeginOnPublish() {
   val loop = MusicTrackLooper()
   loop.load(byteArrayOf(1,2,3,4), autoStart = false)
   assertFalse(loop.onBroadcastStarted())
   assertFalse(loop.playing)
   loop.command("play")
   assertTrue(loop.playing)
   loop.clear()
   assertFalse(loop.onBroadcastStarted())
 }
 @Test fun invalidTrackAndWindowFailClosed() {
   val loop=MusicTrackLooper()
   try{loop.load(byteArrayOf(1,2,3));fail("bad frame length")}catch (_:IllegalArgumentException){}
   try{loop.nextWindow(3);fail("bad frame length")}catch (_:IllegalArgumentException){}
 }
}
