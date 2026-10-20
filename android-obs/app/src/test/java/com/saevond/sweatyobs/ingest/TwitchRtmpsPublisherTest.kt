package com.saevond.sweatyobs.ingest
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import org.junit.Assert.*
import org.junit.Test
class TwitchRtmpsPublisherTest {
 @Test fun keysRejectUrlAndDangerousCharacters() {
   assertFalse(TwitchRtmpsPublisher.keyValid("https://live.twitch.tv/app/a"))
   assertFalse(TwitchRtmpsPublisher.keyValid("secret\ninjection"))
   assertTrue(TwitchRtmpsPublisher.keyValid("live_abcdefghijklmnop_123456"))
 }
 @Test fun roundTripChunkedAvcAndAac() {
   for(type in listOf(8,9)) {
     val bytes = ByteArray(500){ (it and 255).toByte() }
     val media = RtmpMessage(type, 30000, 1, bytes)
     val out = ByteArrayOutputStream()
     sendRtmpMedia(out,media)
     val parsed = RtmpChunkReader(ByteArrayInputStream(out.toByteArray())).nextMessage()
     assertEquals(type,parsed.type)
     assertEquals(30000L,parsed.timestamp)
     assertArrayEquals(bytes,parsed.data)
   }
 }
 @Test fun extendedTimestampRoundTrip() {
   val msg=RtmpMessage(9,0x1000000L,1,ByteArray(270){7})
   val out=ByteArrayOutputStream();sendRtmpMedia(out,msg)
   val parsed=RtmpChunkReader(ByteArrayInputStream(out.toByteArray())).nextMessage()
   assertEquals(msg.timestamp,parsed.timestamp)
   assertArrayEquals(msg.data,parsed.data)
 }
}
