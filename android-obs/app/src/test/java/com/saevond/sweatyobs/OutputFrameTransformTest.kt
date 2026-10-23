package com.saevond.sweatyobs

import org.junit.Assert.assertEquals
import org.junit.Test

class OutputFrameTransformTest {
  @Test fun rotate180MapsEveryOutputCornerToItsOpposite() {
    val matrix = OutputFrameTransform.glMatrix(rotate180 = true)
    val corners = listOf(-1f to -1f, 1f to -1f, -1f to 1f, 1f to 1f)

    for ((x, y) in corners) {
      val transformedX = matrix[0] * x + matrix[4] * y + matrix[12]
      val transformedY = matrix[1] * x + matrix[5] * y + matrix[13]
      assertEquals(-x, transformedX, 0f)
      assertEquals(-y, transformedY, 0f)
    }
  }

  @Test fun disabledRotationKeepsEveryOutputCornerInPlace() {
    val matrix = OutputFrameTransform.glMatrix(rotate180 = false)
    val corners = listOf(-1f to -1f, 1f to -1f, -1f to 1f, 1f to 1f)

    for ((x, y) in corners) {
      val transformedX = matrix[0] * x + matrix[4] * y + matrix[12]
      val transformedY = matrix[1] * x + matrix[5] * y + matrix[13]
      assertEquals(x, transformedX, 0f)
      assertEquals(y, transformedY, 0f)
    }
  }
}
