package com.saevond.sweatyobs

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keeps RTMPS stream keys and bot bridge tokens out of plain-text SharedPreferences. */
class SecretStore(context: Context) {
  private val prefs = context.getSharedPreferences("secure_encoder_secrets", Context.MODE_PRIVATE)
  private val alias = "sweatyobs_aes_gcm_v1"
  private val secretNames = setOf("rtmps", "youtube_key", "kick_key", "bridge_token")
  private val key: SecretKey
    get() {
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      (store.getKey(alias, null) as? SecretKey)?.let { return it }
      val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
      generator.init(
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build()
      )
      return generator.generateKey()
    }
  fun put(name: String, value: String) {
    require(name in secretNames)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
    val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    prefs.edit().putString(name, Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)).apply()
  }
  fun get(name: String): String {
    require(name in secretNames)
    val encoded = prefs.getString(name, null) ?: return ""
    return try {
      val bytes = Base64.decode(encoded, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
      }
      String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    } catch (_: Exception) { "" }
  }
}
