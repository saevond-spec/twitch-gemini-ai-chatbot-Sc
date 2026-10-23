package com.saevond.sweatyobs

/** Detects default-route identity changes while ignoring the initial callback. */
internal class DefaultNetworkHandoffTracker<T : Any> {
  private var observed = false
  private var current: T? = null

  @Synchronized fun onAvailable(network: T): Boolean {
    val changed = observed && current != network
    current = network
    observed = true
    return changed
  }

  @Synchronized fun onLost(network: T): Boolean {
    if (!observed || current != network) return false
    current = null
    return true
  }

  @Synchronized fun reset() {
    observed = false
    current = null
  }
}
