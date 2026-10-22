package com.saevond.sweatyobs

/** Persists a destination's first selection so saving a key later cannot silently enable it. */
internal fun initializeDestinationSelection(
  savedSelection: Boolean?,
  configuredDefault: Boolean,
  persist: (Boolean) -> Unit
): Boolean {
  val selection = savedSelection ?: configuredDefault
  if (savedSelection == null) persist(selection)
  return selection
}
