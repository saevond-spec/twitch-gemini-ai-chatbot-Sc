package com.saevond.sweatyobs

import org.junit.Assert.assertEquals
import org.junit.Test

class OutputFrameTransformTest {
  @Test fun videoCorrectionRotatesOnlyTheVideoAndKeepsOverlayCornersUpright() {
    val videoMatrix = OutputFrameTransform.videoGlMatrix(rotate180 = true)
    val overlayMatrix = OutputFrameTransform.overlayGlMatrix()
    val corners = listOf(-1f to -1f, 1f to -1f, -1f to 1f, 1f to 1f)

    for ((x, y) in corners) {
      assertEquals(-x, mapX(videoMatrix, x, y), 0f)
      assertEquals(-y, mapY(videoMatrix, x, y), 0f)
      assertEquals(x, mapX(overlayMatrix, x, y), 0f)
      assertEquals(y, mapY(overlayMatrix, x, y), 0f)
    }
  }

  @Test fun disabledVideoCorrectionKeepsBothLayersInPlace() {
    val videoMatrix = OutputFrameTransform.videoGlMatrix(rotate180 = false)
    val overlayMatrix = OutputFrameTransform.overlayGlMatrix()
    val corners = listOf(-1f to -1f, 1f to -1f, -1f to 1f, 1f to 1f)

    for ((x, y) in corners) {
      assertEquals(x, mapX(videoMatrix, x, y), 0f)
      assertEquals(y, mapY(videoMatrix, x, y), 0f)
      assertEquals(x, mapX(overlayMatrix, x, y), 0f)
      assertEquals(y, mapY(overlayMatrix, x, y), 0f)
    }
  }

  private fun mapX(matrix: FloatArray, x: Float, y: Float) =
    matrix[0] * x + matrix[4] * y + matrix[12]

  private fun mapY(matrix: FloatArray, x: Float, y: Float) =
    matrix[1] * x + matrix[5] * y + matrix[13]
}
