package com.saevond.sweatyobs.ingest
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InterruptedIOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test
class TwitchRtmpsPublisherTest {
 @Test fun keysRejectUrlAndDangerousCharacters() {
   assertFalse(TwitchRtmpsPublisher.keyValid("https://live.twitch.tv/app/a"))
   assertFalse(TwitchRtmpsPublisher.keyValid("secret\ninjection"))
   assertTrue(TwitchRtmpsPublisher.keyValid("live_abcdefghijklmnop_123456"))
 }
 @Test fun sharedPublisherRequiresSecurePublicEndpointShape() {
   assertTrue(RtmpsPublisher.endpointValid("rtmps://ingest.example.com:443/app"))
   assertFalse(RtmpsPublisher.endpointValid("rtmp://ingest.example.com/app"))
   assertFalse(RtmpsPublisher.endpointValid("https://ingest.example.com/app"))
   assertFalse(RtmpsPublisher.endpointValid("rtmps://user:pass@ingest.example.com/app"))
   assertFalse(RtmpsPublisher.endpointValid("rtmps://ingest.example.com/app?key=secret"))
   assertFalse(RtmpsPublisher.endpointValid("rtmps://ingest.example.com/../admin"))
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
 @Test fun largeFrameUsesOneSocketWriteAndRetainsDefaultChunkFraming() {
   val payload = ByteArray(24 * 1024) { (it * 31).toByte() }
   val media = RtmpMessage(9, 30000, 1, payload)
   val output = CountingOutputStream()
   sendRtmpMedia(output, media)
   assertEquals("One coalesced write per RTMP media message", 1, output.writeCalls)
   val parsed = RtmpChunkReader(ByteArrayInputStream(output.bytes.toByteArray())).nextMessage()
   assertEquals(media.timestamp, parsed.timestamp)
   assertEquals(media.type, parsed.type)
   assertArrayEquals(payload, parsed.data)
 }
 @Test fun successfulSetupWinsAgainstItsPendingDeadline() {
   val operationClosed = CountDownLatch(1)
   val cancellation = ConnectionCancellation()
   cancellation.setCancelAction { operationClosed.countDown() }
   val deadline = StartupDeadline(
     System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(500), cancellation
   )
   try {
     assertFalse("watchdog must not expire early", operationClosed.await(40, TimeUnit.MILLISECONDS))
     assertTrue("setup should complete before the deadline", deadline.complete())
     deadline.expire() // Models a watchdog task that started before cancel(false) could stop it.
     assertFalse("completed setup must not be closed by a late timer",
       operationClosed.await(600, TimeUnit.MILLISECONDS))
     assertFalse(cancellation.isCancelled)
   } finally {
     deadline.cancel()
   }
 }

 @Test fun expiredSetupDeadlineCancelsAndCannotBeCompleted() {
   val operationClosed = CountDownLatch(1)
   val cancellation = ConnectionCancellation()
   cancellation.setCancelAction { operationClosed.countDown() }
   val deadline = StartupDeadline(
     System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(30), cancellation
   )
   try {
     assertTrue("deadline must close the active operation", operationClosed.await(2, TimeUnit.SECONDS))
     assertFalse("expired startup cannot transition to success", deadline.complete())
     assertTrue(cancellation.isCancelled)
   } finally {
     deadline.cancel()
   }
 }

 @Test fun requestAbortCancelsBlockedDnsLookupAndConnectWorker() {
   val lookupStarted = CountDownLatch(1)
   val cancellationObserved = CountDownLatch(1)
   val failure = AtomicReference<Exception?>(null)
   val publisher = RtmpsPublisher(
     "rtmps://ingest.example.com:443/app",
     "sandbox-key-12345",
     HostAddressResolver { _, timeoutMs, cancellation ->
       lookupStarted.countDown()
       cancellation.setCancelAction { cancellationObserved.countDown() }
       if (!cancellationObserved.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
         throw SocketTimeoutException("test resolver timed out")
       }
       cancellation.throwIfCancelled()
       throw AssertionError("Cancelled synthetic resolver must not return an address")
     }
   )
   val worker = Thread {
     try { publisher.connect() } catch (error: Exception) { failure.set(error) }
   }
   try {
     worker.start()
     assertTrue("DNS lookup should begin", lookupStarted.await(2, TimeUnit.SECONDS))
     publisher.requestAbort()
     assertTrue("requestAbort must signal the active DNS lookup", cancellationObserved.await(1, TimeUnit.SECONDS))
     worker.join(1_000)
     assertFalse("connect worker must finish after DNS cancellation", worker.isAlive)
     assertTrue("connect must report cancellation", failure.get() is InterruptedIOException)
   } finally {
     publisher.close()
     worker.join(1_000)
   }
 }

 @Test fun closeFinishesActiveSocketBeforeCleanupCanReleaseItsSession() {
   val connectEntered = CountDownLatch(1)
   val dispatchEntered = CountDownLatch(1)
   val releaseDispatch = CountDownLatch(1)
   val closeEntered = CountDownLatch(1)
   val releasePhysicalClose = CountDownLatch(1)
   val physicalCloseFinished = CountDownLatch(1)
   val cleanupReturned = CountDownLatch(1)
   val connectionFailure = AtomicReference<Exception?>(null)
   val socket = object : Socket() {
     override fun setTcpNoDelay(on: Boolean) {}
     override fun setKeepAlive(on: Boolean) {}
     override fun connect(endpoint: SocketAddress, timeout: Int) {
       connectEntered.countDown()
       if (!physicalCloseFinished.await(5, TimeUnit.SECONDS)) {
         throw SocketTimeoutException("synthetic socket was not closed")
       }
       throw SocketException("synthetic socket closed during connect")
     }
     override fun close() {
       closeEntered.countDown()
       if (!releasePhysicalClose.await(5, TimeUnit.SECONDS)) {
         throw java.io.IOException("synthetic close gate timed out")
       }
       physicalCloseFinished.countDown()
     }
   }
   val publisher = RtmpsPublisher(
     "rtmps://ingest.example.com:443/app",
     "sandbox-key-12345",
     HostAddressResolver { _, _, _ -> arrayOf(InetAddress.getByName("8.8.8.8")) },
     socketCloser = { candidate, onClosed ->
       dispatchEntered.countDown()
       try {
         releaseDispatch.await(5, TimeUnit.SECONDS)
         candidate.close()
       } finally { onClosed() }
     },
     socketFactory = { socket }
   )
   val connector = Thread {
     try { publisher.connect() } catch (error: Exception) { connectionFailure.set(error) }
   }
   val canceller = Thread { publisher.requestAbort() }
   val cleanup = Thread {
     try { publisher.close() } finally { cleanupReturned.countDown() }
   }

   try {
     connector.start()
     assertTrue("synthetic TCP connect should start", connectEntered.await(2, TimeUnit.SECONDS))
     canceller.start()
     assertTrue("cancellation should claim the socket-close callback", dispatchEntered.await(2, TimeUnit.SECONDS))

     cleanup.start()
     assertTrue("cleanup must directly close the registered setup socket", closeEntered.await(2, TimeUnit.SECONDS))
     assertFalse("cleanup must retain the session until its active socket is physically closed",
       cleanupReturned.await(100, TimeUnit.MILLISECONDS))

     releasePhysicalClose.countDown()
     assertTrue("cleanup should finish after the old socket closes",
       cleanupReturned.await(2, TimeUnit.SECONDS))
     assertTrue(physicalCloseFinished.await(1, TimeUnit.SECONDS))
   } finally {
     releasePhysicalClose.countDown()
     releaseDispatch.countDown()
     publisher.close()
     connector.join(1_000)
     canceller.join(1_000)
     cleanup.join(1_000)
   }
   assertFalse("synthetic connection should stop after cleanup", connector.isAlive)
   assertTrue("connect should observe the deliberate socket close", connectionFailure.get() != null)
 }


 @Test fun failedSetupSocketCloseDoesNotHoldPublisherCleanup() {
   val asyncCloseStarted = CountDownLatch(1)
   val releaseAsyncClose = CountDownLatch(1)
   val cleanupCloseEntered = CountDownLatch(1)
   val cleanupReturned = CountDownLatch(1)
   val asyncCloseFinished = CountDownLatch(1)
   val socket = object : Socket() {
     override fun setTcpNoDelay(on: Boolean) {}
     override fun setKeepAlive(on: Boolean) {}
     override fun connect(endpoint: SocketAddress, timeout: Int) {
       throw SocketException("synthetic setup failure")
     }
     override fun close() {
       cleanupCloseEntered.countDown()
     }
   }
   val publisher = RtmpsPublisher(
     "rtmps://ingest.example.com:443/app",
     "sandbox-key-12345",
     HostAddressResolver { _, _, _ -> arrayOf(InetAddress.getByName("8.8.8.8")) },
     socketCloser = { candidate, onClosed ->
       Thread({
         asyncCloseStarted.countDown()
         try {
           releaseAsyncClose.await(10, TimeUnit.SECONDS)
           candidate.close()
         } finally {
           try { onClosed() } finally { asyncCloseFinished.countDown() }
         }
       }, "synthetic-async-close").apply { isDaemon = true; start() }
     },
     socketFactory = { socket }
   )
   val connectFailure = AtomicReference<Exception?>(null)
   try {
     try { publisher.connect() } catch (error: Exception) { connectFailure.set(error) }
     assertNotNull("synthetic TCP setup should fail", connectFailure.get())
     assertTrue("failed setup should dispatch its close asynchronously",
       asyncCloseStarted.await(1, TimeUnit.SECONDS))

     val cleanup = Thread {
       try { publisher.close() } finally { cleanupReturned.countDown() }
     }
     cleanup.start()
     assertTrue("publisher cleanup must not wait for a failed-candidate close lane",
       cleanupReturned.await(2, TimeUnit.SECONDS))
     assertEquals("failed candidate remains open only on its async close lane",
       1L, cleanupCloseEntered.count)
     releaseAsyncClose.countDown()
     assertTrue("the dispatched failed-candidate close should finish after release",
       asyncCloseFinished.await(2, TimeUnit.SECONDS))
     assertTrue("the synthetic socket should eventually be closed",
       cleanupCloseEntered.await(1, TimeUnit.SECONDS))
     cleanup.join(1_000)
   } finally {
     releaseAsyncClose.countDown()
     publisher.close()
   }
  }

 @Test fun blocksPrivateDnsDestinations() {
   val host = java.net.InetAddress.getByName("192.168.1.105")
   val loop = java.net.InetAddress.getByName("127.0.0.1")
   val publicDns = java.net.InetAddress.getByName("1.1.1.1")
   assertFalse(TwitchRtmpsPublisher.isPublicDestination(host))
   assertFalse(TwitchRtmpsPublisher.isPublicDestination(loop))
   assertTrue(TwitchRtmpsPublisher.isPublicDestination(publicDns))
 }
 @Test fun extendedTimestampRoundTrip() {
   val msg=RtmpMessage(9,0x1000000L,1,ByteArray(270){7})
   val out=ByteArrayOutputStream();sendRtmpMedia(out,msg)
   val parsed=RtmpChunkReader(ByteArrayInputStream(out.toByteArray())).nextMessage()
   assertEquals(msg.timestamp,parsed.timestamp)
   assertArrayEquals(msg.data,parsed.data)
 }

 private class CountingOutputStream : OutputStream() {
   val bytes = ByteArrayOutputStream()
   var writeCalls = 0
   override fun write(value: Int) {
     writeCalls++
     bytes.write(value)
   }
   override fun write(data: ByteArray, offset: Int, length: Int) {
     writeCalls++
     bytes.write(data, offset, length)
   }
 }
}
