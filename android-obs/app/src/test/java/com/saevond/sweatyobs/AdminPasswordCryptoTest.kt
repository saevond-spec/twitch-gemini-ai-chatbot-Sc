package com.saevond.sweatyobs

import java.security.MessageDigest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AdminPasswordCryptoTest {
  @Test fun samePasswordAndSaltDeriveTheSameHash() {
    val salt = ByteArray(AdminPasswordCrypto.SALT_BYTES) { it.toByte() }
    assertTrue(MessageDigest.isEqual(
      AdminPasswordCrypto.derive("test-password-2026", salt),
      AdminPasswordCrypto.derive("test-password-2026", salt),
    ))
  }

  @Test fun differentSaltProducesDifferentHash() {
    val firstSalt = ByteArray(AdminPasswordCrypto.SALT_BYTES) { it.toByte() }
    val secondSalt = ByteArray(AdminPasswordCrypto.SALT_BYTES) { (it + 1).toByte() }
    assertNotEquals(
      AdminPasswordCrypto.derive("test-password-2026", firstSalt).toList(),
      AdminPasswordCrypto.derive("test-password-2026", secondSalt).toList(),
    )
  }

  @Test fun differentPasswordDoesNotMatchStoredHash() {
    val salt = ByteArray(AdminPasswordCrypto.SALT_BYTES) { (it * 3).toByte() }
    val expected = AdminPasswordCrypto.derive("test-password-2026", salt)
    val wrong = AdminPasswordCrypto.derive("wrong-password-2026", salt)
    assertFalse(MessageDigest.isEqual(expected, wrong))
  }
}
