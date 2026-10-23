package com.saevond.sweatyobs

/**
 * Clip-space rotation applied to every final composition layer before encoding.
 * The matrix is column-major for GLES glUniformMatrix4fv(..., transpose=false).
 */
internal object OutputFrameTransform {
  fun glMatrix(rotate180: Boolean): FloatArray = floatArrayOf(
    if (rotate180) -1f else 1f, 0f, 0f, 0f,
    0f, if (rotate180) -1f else 1f, 0f, 0f,
    0f, 0f, 1f, 0f,
    0f, 0f, 0f, 1f
  )
}
