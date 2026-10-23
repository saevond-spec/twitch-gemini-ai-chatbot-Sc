package com.saevond.sweatyobs

/**
 * Clip-space transforms for the separate PS5 video and upright overlay layers.
 * The video correction must never rotate overlay text or graphics.
 */
internal object OutputFrameTransform {
  fun videoGlMatrix(rotate180: Boolean): FloatArray = matrix(rotate180)

  fun overlayGlMatrix(): FloatArray = matrix(rotate180 = false)

  private fun matrix(rotate180: Boolean): FloatArray = floatArrayOf(
    if (rotate180) -1f else 1f, 0f, 0f, 0f,
    0f, if (rotate180) -1f else 1f, 0f, 0f,
    0f, 0f, 1f, 0f,
    0f, 0f, 0f, 1f
  )
}
