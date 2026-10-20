package com.saevond.sweatyobs

import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.SystemClock
import java.io.Closeable
import java.util.ArrayDeque
import java.util.Random
import kotlin.math.cos
import kotlin.math.sin

/** Low-frequency animated, full-screen @saevond overlay. Demo metrics are labeled as simulated. */
internal class BrandOverlayCanvas(private val width: Int, private val height: Int) : Closeable {
  val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
  private val canvas = Canvas(bitmap)
  private val random = Random(0x5ae70dL)
  private val particles = Array(PARTICLE_COUNT) {
    Particle(random.nextFloat() * BASE_WIDTH, random.nextFloat() * BASE_HEIGHT,
      random.nextFloat() * 100f + 20f, PARTICLE_COLORS[random.nextInt(PARTICLE_COLORS.size)], random.nextFloat() * 6f)
  }
  private val chat = ArrayDeque<ChatLine>()
  private var lastRenderAt = 0L
  private var lastStatsAt = 0L
  private var lastChatAt = 0L
  private var lastFeedAt = 0L
  private var lastReactionAt = 0L
  private var lastEventsAt = 0L
  private var chatIndex = 0
  private var feedIndex = 0
  private var reactionIndex = 0
  private var kills = 28
  private var wins = 4
  private var streak = 3
  private var kd = 2.74f
  private var damage = 6.8f
  private var sweat = 72
  private var feedFadeAt = 0L
  private var reactionFadeAt = 0L
  private var killsPulseAt = 0L
  private var winsPulseAt = 0L
  private var streakPulseAt = 0L
  private var eventsPulseAt = 0L
  private var follower = FOLLOWERS[0]
  private var subscriber = SUBSCRIBERS[0]
  private var donor = DONORS[0]
  private var topDonator = TOP_DONORS[0]
  private var donation = "$5.00"

  private data class Particle(val x: Float, val y: Float, val speed: Float, val color: Int, val phase: Float)
  private data class ChatLine(val user: String, val message: String, val color: Int, val highlighted: Boolean)

  fun redrawIfDue(now: Long = SystemClock.elapsedRealtime()): Boolean {
    if (lastRenderAt != 0L && now - lastRenderAt < FRAME_UPDATE_MS) return false
    updateSimulation(now)
    bitmap.eraseColor(Color.TRANSPARENT)
    canvas.save()
    canvas.scale(width / BASE_WIDTH, height / BASE_HEIGHT)
    drawAtmosphere(now)
    drawGameplayBrackets(now)
    drawTopHud(now)
    drawStatsPanel(now)
    drawRightPanels(now)
    drawReactionPanel(now)
    drawBottomHud(now)
    drawFooter(now)
    canvas.restore()
    lastRenderAt = now
    return true
  }

  private fun updateSimulation(now: Long) {
    if (lastStatsAt == 0L) {
      lastStatsAt = now
      lastChatAt = now
      lastFeedAt = now
      lastReactionAt = now
      lastEventsAt = now
      feedFadeAt = now
      reactionFadeAt = now
      repeat(8) { addChatLine() }
      return
    }
    if (now - lastStatsAt >= STATS_INTERVAL_MS) {
      val addedKills = random.nextInt(3)
      kills += addedKills
      if (addedKills > 0) killsPulseAt = now
      if (random.nextInt(4) == 0) {
        wins += 1
        streak += 1
        winsPulseAt = now
        streakPulseAt = now
      }
      kd = (kd + (random.nextFloat() - .48f) * .12f).coerceIn(1.2f, 4.5f)
      damage = (damage + (random.nextFloat() - .45f) * .55f).coerceIn(2.1f, 15.0f)
      sweat = (sweat + random.nextInt(9) - 4).coerceIn(35, 99)
      lastStatsAt = now
    }
    if (now - lastChatAt >= CHAT_INTERVAL_MS) {
      addChatLine()
      lastChatAt = now
    }
    if (now - lastFeedAt >= FEED_INTERVAL_MS) {
      feedIndex = (feedIndex + 1) % AI_MESSAGES.size
      feedFadeAt = now
      lastFeedAt = now
    }
    if (now - lastReactionAt >= REACTION_INTERVAL_MS) {
      reactionIndex = (reactionIndex + 1) % REACTIONS.size
      reactionFadeAt = now
      lastReactionAt = now
    }
    if (now - lastEventsAt >= EVENT_INTERVAL_MS) {
      follower = FOLLOWERS[random.nextInt(FOLLOWERS.size)]
      subscriber = SUBSCRIBERS[random.nextInt(SUBSCRIBERS.size)]
      donor = DONORS[random.nextInt(DONORS.size)]
      topDonator = TOP_DONORS[random.nextInt(TOP_DONORS.size)]
      donation = DONATION_AMOUNTS[random.nextInt(DONATION_AMOUNTS.size)]
      eventsPulseAt = now
      lastEventsAt = now
    }
  }

  private fun addChatLine() {
    val source = CHAT_MESSAGES[chatIndex % CHAT_MESSAGES.size]
    chat.addLast(source)
    chatIndex++
    while (chat.size > CHAT_VISIBLE_COUNT) chat.removeFirst()
  }

  private fun drawAtmosphere(now: Long) {
    val seconds = now / 1000f
    drawOrb(150f + sin(seconds * .12f) * 50f, 360f + cos(seconds * .10f) * 44f, 320f, RED, .22f)
    drawOrb(1760f + cos(seconds * .09f) * 44f, 535f + sin(seconds * .11f) * 50f, 350f, CYAN, .20f)
    val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.argb(22, 255, 33, 57)
      style = Paint.Style.STROKE
      strokeCap = Paint.Cap.ROUND
      strokeWidth = 42f
      maskFilter = BlurMaskFilter(26f, BlurMaskFilter.Blur.NORMAL)
    }
    canvas.drawLine(140f, 150f, 380f, 65f, stroke)
    canvas.drawLine(1540f, 860f, 1800f, 760f, stroke)

    val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.argb(9, 175, 225, 245); style = Paint.Style.STROKE; strokeWidth = 1f
    }
    var y = 2f
    while (y < BASE_HEIGHT) { canvas.drawLine(0f, y, BASE_WIDTH, y, linePaint); y += 4f }

    for (i in particles.indices) {
      val a = particles[i]
      val ax = (a.x + sin(seconds * .12f + a.phase) * a.speed * 2.0f + BASE_WIDTH) % BASE_WIDTH
      val ay = (a.y + cos(seconds * .10f + a.phase) * a.speed * 1.1f + BASE_HEIGHT) % BASE_HEIGHT
      for (j in i + 1 until particles.size) {
        val b = particles[j]
        val bx = (b.x + sin(seconds * .12f + b.phase) * b.speed * 2.0f + BASE_WIDTH) % BASE_WIDTH
        val by = (b.y + cos(seconds * .10f + b.phase) * b.speed * 1.1f + BASE_HEIGHT) % BASE_HEIGHT
        val dx = ax - bx
        val dy = ay - by
        val distance = dx * dx + dy * dy
        if (distance < 17_000f) {
          val alpha = (14f * (1f - distance / 17_000f)).toInt().coerceAtLeast(1)
          canvas.drawLine(ax, ay, bx, by, paint(Color.argb(alpha, 79, 212, 235), 1f, Paint.Style.STROKE))
        }
      }
      val pulse = .5f + .5f * sin(seconds * 1.7f + a.phase)
      canvas.drawCircle(ax, ay, 1.5f + pulse * 1.4f, paint(withAlpha(a.color, 72 + (pulse * 90).toInt()), 2f))
    }

    val vignette = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = RadialGradient(960f, 520f, 1260f,
        intArrayOf(Color.TRANSPARENT, Color.argb(0, 0, 0, 0), Color.argb(118, 0, 0, 0)),
        floatArrayOf(0f, .68f, 1f), Shader.TileMode.CLAMP)
    }
    canvas.drawRect(0f, 0f, BASE_WIDTH, BASE_HEIGHT, vignette)
  }

  private fun drawOrb(x: Float, y: Float, radius: Float, color: Int, opacity: Float) {
    val center = withAlpha(color, (opacity * 255).toInt())
    val middle = withAlpha(color, (opacity * 90).toInt())
    val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = RadialGradient(x, y, radius,
        intArrayOf(center, middle, Color.TRANSPARENT), floatArrayOf(0f, .38f, 1f), Shader.TileMode.CLAMP)
    }
    canvas.drawCircle(x, y, radius, glow)
  }

  private fun drawGameplayBrackets(now: Long) {
    val left = 405f
    val right = 1515f
    val top = 176f
    val bottom = 790f
    val length = 42f + 14f * (.5f + .5f * sin(now / 850f))
    val corners = listOf(
      floatArrayOf(left, top, left + length, top, left, top + length),
      floatArrayOf(right - length, top, right, top, right, top + length),
      floatArrayOf(left, bottom, left + length, bottom, left, bottom - length),
      floatArrayOf(right - length, bottom, right, bottom, right, bottom - length)
    )
    val colors = intArrayOf(CYAN, RED, RED, CYAN)
    corners.forEachIndexed { index, points ->
      val color = colors[index]
      val glow = paint(withAlpha(color, 75), 8f, Paint.Style.STROKE).apply { strokeCap = Paint.Cap.SQUARE; maskFilter = BlurMaskFilter(5f, BlurMaskFilter.Blur.NORMAL) }
      val line = paint(withAlpha(color, 175), 2.5f, Paint.Style.STROKE).apply { strokeCap = Paint.Cap.SQUARE }
      canvas.drawLine(points[0], points[1], points[2], points[3], glow)
      canvas.drawLine(points[0], points[1], points[4], points[5], glow)
      canvas.drawLine(points[0], points[1], points[2], points[3], line)
      canvas.drawLine(points[0], points[1], points[4], points[5], line)
    }
  }

  private fun drawTopHud(now: Long) {
    val seconds = now / 1000f
    drawText("SAEVOND", 42f, 78f, 58f, WHITE, bold = true, spacing = .08f)
    val underline = 218f + 18f * (.5f + .5f * sin(seconds * 1.3f))
    canvas.drawRoundRect(42f, 91f, 42f + underline, 97f, 3f, 3f,
      Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = LinearGradient(42f, 0f, 42f + underline, 0f, RED, Color.rgb(255, 123, 66), Shader.TileMode.CLAMP) })
    drawText("NARAKA  //  RANKED  //  PVP", 43f, 124f, 20f, MUTED, spacing = .12f)

    panel(490f, 27f, 1170f, 132f, RED)
    drawText("SWEAT LEVEL", 518f, 62f, 18f, WHITE, bold = true, spacing = .13f)
    drawText("SIM DATA", 1001f, 59f, 14f, RED, bold = true, spacing = .1f)
    drawText("$sweat%", 1095f, 82f, 28f, WHITE, bold = true, align = Paint.Align.RIGHT)
    val bx = 518f; val by = 91f; val bw = 620f; val bh = 15f
    canvas.drawRoundRect(bx, by, bx + bw, by + bh, 8f, 8f, paint(Color.argb(190, 1, 6, 15), 1f))
    val fillColor = when {
      sweat > 80 -> RED
      sweat > 55 -> Color.rgb(255, 137, 47)
      else -> Color.rgb(54, 219, 172)
    }
    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = LinearGradient(bx, by, bx + bw, by,
        intArrayOf(fillColor, Color.rgb(255, 168, 49), Color.rgb(255, 215, 80)), null, Shader.TileMode.CLAMP)
    }
    canvas.drawRoundRect(bx, by, bx + bw * sweat / 100f, by + bh, 8f, 8f, fill)
    val shimmerX = bx + ((now % 2600L) / 2600f) * bw
    canvas.drawRect(shimmerX - 22f, by, shimmerX + 22f, by + bh,
      Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = LinearGradient(shimmerX - 22f, 0f, shimmerX + 22f, 0f, Color.TRANSPARENT, Color.argb(90, 255, 255, 255), Shader.TileMode.CLAMP) })
    for (i in 1..9) canvas.drawLine(bx + bw * i / 10f, by + 1f, bx + bw * i / 10f, by + bh - 1f, paint(Color.argb(100, 8, 12, 20), 2f, Paint.Style.STROKE))

    panel(1510f, 26f, 1880f, 132f, CYAN)
    drawRobot(1544f, 78f, 25f, now)
    drawText("SWEATYCLANKER", 1582f, 67f, 23f, CYAN, bold = true, spacing = .04f)
    val pulse = 155 + (55 * (.5f + .5f * sin(now / 350f))).toInt()
    drawText("AI CHATTER  //  SIMULATED", 1584f, 98f, 13f, Color.argb(pulse, 190, 224, 236), spacing = .035f)
    drawSword(1834f, 42f, now)
  }

  private fun drawStatsPanel(now: Long) {
    panel(30f, 168f, 370f, 779f, CYAN)
    drawText("SESSION STATS", 54f, 207f, 21f, WHITE, bold = true, spacing = .1f)
    pill("SIMULATED", 240f, 184f, 107f, RED)
    val boxTop = 231f
    statBox(49f, boxTop, 154f, 94f, "KILLS", kills.toString(), RED, now - killsPulseAt)
    statBox(207f, boxTop, 154f, 94f, "WINS", wins.toString(), CYAN, now - winsPulseAt)
    statBox(49f, boxTop + 105f, 154f, 94f, "K / D", String.format(java.util.Locale.US, "%.2f", kd), GOLD, 50_000L)
    statBox(207f, boxTop + 105f, 154f, 94f, "DAMAGE", "${String.format(java.util.Locale.US, "%.1f", damage)}K", PURPLE, 50_000L)

    panel(48f, 451f, 352f, 573f, CYAN, filled = Color.argb(205, 6, 16, 27))
    canvas.drawRect(48f, 451f, 352f, 457f, paint(CYAN, 1f))
    drawText("CURRENT HERO", 66f, 483f, 15f, CYAN, bold = true, spacing = .12f)
    drawText("JUSTINA GU", 66f, 521f, 25f, WHITE, bold = true, spacing = .05f)
    drawText("❄  THE ICE BLADE", 66f, 550f, 17f, MUTED, bold = true, spacing = .03f)

    panel(48f, 590f, 352f, 688f, RED, filled = Color.argb(210, 17, 9, 20))
    drawText("🔥  STREAK", 66f, 620f, 17f, RED, bold = true, spacing = .1f)
    val bump = if (now - streakPulseAt < 650L) 37f + (650f - (now - streakPulseAt)) / 55f else 37f
    drawText("$streak", 66f, 670f, bump, WHITE, bold = true)
    drawText("WIN RUN  •  DEMO", 119f, 667f, 13f, MUTED, spacing = .08f)
    drawText("⚔  FOCUS  •  ADAPT  •  DOMINATE  ⚔", 48f, 738f, 14f, MUTED, bold = true, spacing = .03f)
  }

  private fun statBox(x: Float, y: Float, w: Float, h: Float, label: String, value: String, color: Int, age: Long) {
    panel(x, y, x + w, y + h, color, filled = Color.argb(192, 7, 14, 25))
    drawText(label, x + 13f, y + 27f, 14f, MUTED, bold = true, spacing = .1f)
    val bump = if (age in 0L..450L) 33f + (450f - age) / 45f else 33f
    drawText(value, x + 13f, y + 72f, bump, color, bold = true)
  }

  private fun drawRightPanels(now: Long) {
    panel(1550f, 168f, 1890f, 355f, CYAN)
    drawText("◆  SWEATYCLANKER LIVE FEED", 1570f, 204f, 16f, CYAN, bold = true, spacing = .03f)
    pill("DEMO", 1814f, 181f, 55f, PURPLE)
    val message = AI_MESSAGES[feedIndex]
    val fade = ((now - feedFadeAt).coerceAtLeast(0L) / 450f).coerceIn(0f, 1f)
    val alpha = (fade * 255).toInt()
    drawWrapped(message, 1571f, 245f, 282f, 21f, Color.argb(alpha, 237, 242, 250), 2)
    drawText("SWEATYCLANKER  •  SIMULATED", 1571f, 332f, 13f, MUTED, spacing = .04f)

    panel(1550f, 371f, 1890f, 890f, CYAN)
    drawText("◈  CHAT PREVIEW  //  SIMULATED", 1570f, 408f, 16f, WHITE, bold = true, spacing = .02f)
    canvas.drawLine(1570f, 422f, 1870f, 422f, paint(Color.argb(145, CYAN), 1f, Paint.Style.STROKE))
    val rows = chat.toList()
    rows.forEachIndexed { index, row ->
      val y = 450f + index * 53f
      if (row.highlighted) {
        canvas.drawRoundRect(1568f, y - 20f, 1872f, y + 41f, 7f, 7f,
          paint(Color.argb(33, Color.red(row.color), Color.green(row.color), Color.blue(row.color)), 1f))
        canvas.drawRoundRect(1568f, y - 18f, 1573f, y + 39f, 2f, 2f, paint(row.color, 1f))
      }
      drawText(row.user, 1585f, y, 15f, row.color, bold = true)
      drawFit(row.message, 1585f, y + 24f, 281f, 14f, Color.rgb(222, 231, 243))
    }
  }

  private fun drawReactionPanel(now: Long) {
    panel(30f, 802f, 500f, 889f, RED)
    drawRobot(77f, 845f, 25f, now)
    drawText("CLANKER REACTION  •  DEMO", 114f, 830f, 14f, RED, bold = true, spacing = .08f)
    val reaction = REACTIONS[reactionIndex]
    val fade = ((now - reactionFadeAt).coerceAtLeast(0L) / 350f).coerceIn(0f, 1f)
    drawFit(reaction.first, 114f, 856f, 360f, 19f,
      Color.argb((fade * 255).toInt(), Color.red(WHITE), Color.green(WHITE), Color.blue(WHITE)), bold = true)
    drawFit(reaction.second, 114f, 878f, 360f, 14f, MUTED)
  }

  private fun drawBottomHud(now: Long) {
    panel(30f, 906f, 1890f, 988f, RED)
    val cells = listOf(
      Triple(48f, "RECENT FOLLOWER  •  DEMO", follower to CYAN),
      Triple(350f, "RECENT SUB  •  DEMO", subscriber to CYAN),
      Triple(656f, "CENTER EMBLEM", "⚔  SAEVOND  ⚔" to WHITE),
      Triple(948f, "RECENT DONATION  •  DEMO", "$donor  $donation" to RED),
      Triple(1252f, "TOP DONATOR  •  DEMO", topDonator to GOLD),
      Triple(1554f, "NOW PLAYING", "NARAKA BLADEPOINT OST — FIGHT TO WIN" to WHITE)
    )
    cells.forEachIndexed { index, cell ->
      val x = cell.first
      val label = cell.second
      val (value, color) = cell.third
      if (index > 0) canvas.drawLine(x - 20f, 919f, x - 20f, 975f, paint(Color.argb(92, CYAN), 1f, Paint.Style.STROKE))
      drawFit(label, x, 934f, 300f, 12f, MUTED, bold = true, spacing = .055f)
      val pulse = if (now - eventsPulseAt < 550L && index != 2 && index != 5) 1.12f else 1f
      drawFit(value, x, 964f, 300f, 16f * pulse, color, bold = true)
    }
  }

  private fun drawFooter(now: Long) {
    drawText("STAY CONNECTED", 45f, 1024f, 13f, CYAN, bold = true, spacing = .14f)
    drawFit("YOUTUBE /saevond   •   X @saevond_   •   TIKTOK @saevond   •   INSTAGRAM @saevond",
      45f, 1052f, 1100f, 18f, WHITE, spacing = .01f)
    drawText("FOCUS  •", 1395f, 1036f, 16f, MUTED, bold = true, spacing = .04f)
    drawText("ADAPT", 1495f, 1036f, 16f, RED, bold = true, spacing = .06f)
    drawText("•  DOMINATE", 1568f, 1036f, 16f, MUTED, bold = true, spacing = .04f)
    drawText("ALL HUD ACTIVITY IS A SIMULATION", 1395f, 1060f, 11f, Color.argb(190, 197, 209, 227), spacing = .055f)
  }

  private fun panel(left: Float, top: Float, right: Float, bottom: Float, accent: Int, filled: Int = Color.argb(220, 5, 12, 23)) {
    val rect = RectF(left, top, right, bottom)
    canvas.drawRoundRect(rect, 12f, 12f, paint(filled, 1f))
    val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f; color = withAlpha(accent, 190) }
    canvas.drawRoundRect(rect, 12f, 12f, outline)
    canvas.drawLine(left + 19f, top + 2f, right - 19f, top + 2f,
      Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = LinearGradient(left, top, right, top, Color.TRANSPARENT, accent, Shader.TileMode.CLAMP); style = Paint.Style.STROKE; strokeWidth = 2f })
  }

  private fun pill(text: String, x: Float, y: Float, w: Float, color: Int) {
    canvas.drawRoundRect(x, y, x + w, y + 21f, 10f, 10f, paint(Color.argb(45, Color.red(color), Color.green(color), Color.blue(color)), 1f))
    drawText(text, x + w / 2f, y + 15f, 11f, color, bold = true, align = Paint.Align.CENTER, spacing = .07f)
  }

  private fun drawRobot(x: Float, y: Float, radius: Float, now: Long) {
    val pulse = .75f + .25f * sin(now / 290f)
    val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = withAlpha(CYAN, (45 * pulse).toInt())
      style = Paint.Style.STROKE
      strokeWidth = 2f
    }
    canvas.drawCircle(x, y, radius * 1.55f, glow)
    val body = RectF(x - radius, y - radius * .68f, x + radius, y + radius * .72f)
    canvas.drawRoundRect(body, radius * .25f, radius * .25f, paint(Color.rgb(6, 28, 40), 1f))
    val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f; color = CYAN }
    canvas.drawRoundRect(body, radius * .25f, radius * .25f, edge)
    canvas.drawCircle(x - radius * .36f, y, radius * .13f, paint(CYAN, 1f))
    canvas.drawCircle(x + radius * .36f, y, radius * .13f, paint(CYAN, 1f))
    canvas.drawLine(x - radius * .34f, y + radius * .35f, x + radius * .34f, y + radius * .35f, paint(CYAN, 2f, Paint.Style.STROKE))
    canvas.drawLine(x, y - radius * .68f, x, y - radius * 1.0f, edge)
    canvas.drawCircle(x, y - radius * 1.04f, radius * .10f, paint(CYAN, 1f))
  }

  private fun drawSword(x: Float, y: Float, now: Long) {
    val pulse = .7f + .3f * (.5f + .5f * sin(now / 500f))
    val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = withAlpha(RED, (120 * pulse).toInt())
      style = Paint.Style.STROKE
      strokeWidth = 5f
      strokeCap = Paint.Cap.ROUND
      maskFilter = BlurMaskFilter(10f, BlurMaskFilter.Blur.NORMAL)
    }
    canvas.drawLine(x - 25f, y + 35f, x + 24f, y - 35f, glow)
    canvas.drawLine(x - 28f, y + 14f, x + 2f, y + 35f, paint(RED, 3f, Paint.Style.STROKE))
    canvas.drawCircle(x + 25f, y - 35f, 3f, paint(WHITE, 2f))
  }

  private fun drawWrapped(text: String, x: Float, firstBaseline: Float, maxWidth: Float, size: Float, color: Int, maxLines: Int) {
    val words = text.split(' ')
    val p = textPaint(size, color)
    val lines = ArrayList<String>()
    var line = ""
    for (word in words) {
      val attempt = if (line.isEmpty()) word else "$line $word"
      if (p.measureText(attempt) <= maxWidth) line = attempt
      else { if (line.isNotEmpty()) lines += line; line = word }
    }
    if (line.isNotEmpty()) lines += line
    lines.take(maxLines).forEachIndexed { index, row -> canvas.drawText(row, x, firstBaseline + index * (size + 9f), p) }
  }

  private fun drawFit(text: String, x: Float, y: Float, maxWidth: Float, size: Float, color: Int,
    bold: Boolean = false, spacing: Float = 0f) {
    val p = textPaint(size, color, bold, spacing)
    var result = text
    while (result.isNotEmpty() && p.measureText(result) > maxWidth) result = result.dropLast(1)
    if (result != text && result.length > 2) result = result.dropLast(1) + "…"
    canvas.drawText(result, x, y, p)
  }

  private fun drawText(text: String, x: Float, y: Float, size: Float, color: Int, bold: Boolean = false,
    align: Paint.Align = Paint.Align.LEFT, spacing: Float = 0f) {
    canvas.drawText(text, x, y, textPaint(size, color, bold, spacing, align))
  }

  private fun textPaint(size: Float, color: Int, bold: Boolean = false, spacing: Float = 0f, align: Paint.Align = Paint.Align.LEFT) =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      this.color = color
      textSize = size
      textAlign = align
      typeface = Typeface.create(if (bold) "sans-serif-condensed" else "sans-serif", if (bold) Typeface.BOLD else Typeface.NORMAL)
      letterSpacing = spacing
    }

  private fun paint(color: Int, strokeWidth: Float, style: Paint.Style = Paint.Style.FILL) =
    Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color; this.strokeWidth = strokeWidth; this.style = style }

  private fun withAlpha(color: Int, alpha: Int) = Color.argb(alpha.coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))

  override fun close() {
    if (!bitmap.isRecycled) bitmap.recycle()
  }

  companion object {
    private const val BASE_WIDTH = 1920f
    private const val BASE_HEIGHT = 1080f
    private const val PARTICLE_COUNT = 80
    private const val CHAT_VISIBLE_COUNT = 8
    private const val FRAME_UPDATE_MS = 250L
    private const val STATS_INTERVAL_MS = 8_000L
    private const val CHAT_INTERVAL_MS = 2_200L
    private const val FEED_INTERVAL_MS = 7_000L
    private const val REACTION_INTERVAL_MS = 6_000L
    private const val EVENT_INTERVAL_MS = 18_000L

    private const val WHITE = Color.WHITE
    private const val MUTED = 0xFFB7C8D8.toInt()
    private const val RED = 0xFFFF3658.toInt()
    private const val CYAN = 0xFF35E9EE.toInt()
    private const val GOLD = 0xFFFFC75E.toInt()
    private const val PURPLE = 0xFFB77CFF.toInt()
    private val PARTICLE_COLORS = intArrayOf(RED, CYAN, GOLD, PURPLE)

    private val CHAT_MESSAGES = listOf(
      ChatLine("icequeen", "JUSTINA IS BUILT DIFFERENT ❄", CYAN, true),
      ChatLine("blade_runner", "that parry was clean ⚔", RED, false),
      ChatLine("clankfan", "clanker called that one 😈", PURPLE, false),
      ChatLine("ranked_grind", "focus adapt dominate 💪", WHITE, false),
      ChatLine("naraka_ninja", "1v3 incoming 👀", GOLD, true),
      ChatLine("saevond_fan", "the ice blade is cooking 🔥", CYAN, false),
      ChatLine("combo_lab", "perfect reset 🎯", PURPLE, false),
      ChatLine("parry_this", "we take those 🏆", WHITE, false),
      ChatLine("frostbyte", "that ult was icy ❄", CYAN, true),
      ChatLine("sweatcheck", "ranked lobby sweating 😅", RED, false),
      ChatLine("echo_strike", "nice dodge 🧠", GOLD, false),
      ChatLine("blade_watch", "clip that ⚔", PURPLE, true),
      ChatLine("night_queue", "another clean win 💜", CYAN, false),
      ChatLine("combo_sensei", "timing is everything 🎯", WHITE, false),
      ChatLine("clutch_mode", "no panic just parry 🔥", RED, false),
      ChatLine("icebound", "that spacing tho 👀", CYAN, true),
      ChatLine("ranked_owl", "we locked in 💪", GOLD, false),
      ChatLine("third_party", "not the 1v3 😂", PURPLE, false),
      ChatLine("blade_echo", "huge damage 🏆", WHITE, false),
      ChatLine("nightwatch", "SAEVOND ON TOP 😈", RED, true)
    )
    private val AI_MESSAGES = listOf(
      "😈 Pressure is rising. Make them respect the spacing.",
      "🔥 Clean punish. Keep the tempo and take the angle.",
      "❄ Justina is freezing this lobby one parry at a time.",
      "💜 Smart reset. Breathe, read, then strike.",
      "⚔ Three opponents? One blade. Stay focused.",
      "🧠 They are dodging early. Hold the pressure.",
      "🏆 Another round in the books. Keep the streak alive.",
      "👀 Third party on the edge. Check your flank.",
      "🎯 Great spacing. Now convert that opening.",
      "💪 Sweat level is climbing. Adapt and dominate."
    )
    private val REACTIONS = listOf(
      "SKILL ISSUE DETECTED." to "JUST KIDDING... MAYBE.",
      "ICE BLADE GOING BRRR." to "TEMPERATURE: CRITICAL.",
      "1V3? NO PROBLEM." to "CALCULATING... SEND IT.",
      "PARRY WINDOW: PERFECT." to "THE READ WAS PERSONAL.",
      "LOBBY STATUS: SWEATING." to "CLANKER HAS THE RECEIPTS.",
      "DODGE LIKE YOU MEAN IT." to "THAT WAS ALMOST CLEAN.",
      "RANKED POINTS SECURED." to "MORALE: UNREASONABLY HIGH.",
      "THIRD PARTY DETECTED." to "EYES UP, SAEVOND.",
      "COMBO ROUTE OPTIMIZED." to "NO NOTES. JUST DAMAGE.",
      "FOCUS MODE: MAXIMUM." to "ADAPT. THEN DOMINATE."
    )
    private val FOLLOWERS = listOf("frostbyte", "parry_this", "night_queue", "blade_echo", "ranked_owl", "echo_strike")
    private val SUBSCRIBERS = listOf("icequeen", "clankfan", "combo_lab", "saevond_fan", "nightwatch", "blade_runner")
    private val DONORS = listOf("frostbyte", "clutch_mode", "icebound", "ranked_grind", "third_party", "naraka_ninja")
    private val TOP_DONORS = listOf("icequeen", "saevond_fan", "blade_watch", "nightwatch", "combo_sensei", "clankfan")
    private val DONATION_AMOUNTS = listOf("\$2.00", "\$5.00", "\$10.00", "\$3.50", "\$7.00")
  }
}
