package com.saevond.sweatyobs

import android.content.Context
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * Device-local app access gate. This password is never sent to Render and is
 * not an authentication credential for the public APK or streaming services.
 */
internal class AdminPasswordStore(context: Context) {
  private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  fun isConfigured(): Boolean = prefs.contains(SALT_KEY) && prefs.contains(HASH_KEY)

  fun setPassword(password: String): Boolean {
    if (!isValidPassword(password)) return false
    val salt = ByteArray(AdminPasswordCrypto.SALT_BYTES).also(SecureRandom()::nextBytes)
    val hash = AdminPasswordCrypto.derive(password, salt)
    return prefs.edit()
      .putString(SALT_KEY, Base64.getEncoder().withoutPadding().encodeToString(salt))
      .putString(HASH_KEY, Base64.getEncoder().withoutPadding().encodeToString(hash))
      .commit()
  }

  fun verify(password: String): Boolean {
    if (password.length > MAX_PASSWORD_LENGTH) return false
    val salt = decode(SALT_KEY) ?: return false
    val expected = decode(HASH_KEY) ?: return false
    if (salt.size != AdminPasswordCrypto.SALT_BYTES || expected.size != AdminPasswordCrypto.HASH_BYTES) return false
    return try {
      MessageDigest.isEqual(expected, AdminPasswordCrypto.derive(password, salt))
    } catch (_: Exception) {
      false
    }
  }

  private fun decode(key: String): ByteArray? = try {
    prefs.getString(key, null)?.let { Base64.getDecoder().decode(it) }
  } catch (_: IllegalArgumentException) { null }

  companion object {
    const val MIN_PASSWORD_LENGTH = 8
    const val MAX_PASSWORD_LENGTH = 128
    private const val PREFS_NAME = "encoder_admin_lock"
    private const val SALT_KEY = "password_salt"
    private const val HASH_KEY = "password_hash"

    fun isValidPassword(password: String): Boolean =
      password.length in MIN_PASSWORD_LENGTH..MAX_PASSWORD_LENGTH
  }
}

/** PBKDF2 keeps only a salted slow hash in the app's private preferences. */
internal object AdminPasswordCrypto {
  const val SALT_BYTES = 16
  const val HASH_BYTES = 32
  const val ITERATIONS = 210_000

  fun derive(password: String, salt: ByteArray): ByteArray {
    val spec = javax.crypto.spec.PBEKeySpec(password.toCharArray(), salt, ITERATIONS, HASH_BYTES * 8)
    return try {
      javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    } finally {
      spec.clearPassword()
    }
  }
}
