@file:JvmName("SystemEmojiPlugin")

package contrabag.systememoji

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ReplacementSpan
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import io.github.revenge.plugins.plugin
import io.github.revenge.xposed.api.registerNativeMethod
import java.util.concurrent.atomic.AtomicInteger

private const val STATUS = "contrabag.systememoji.reactions.status"
private var session: ReactionSession? = null

@Suppress("UNUSED")
val systemEmojiPlugin = plugin {
    start {
        session?.close()
        val next = ReactionSession()
        session = next
        registerNativeMethod(STATUS) { next.status() }
        try {
            next.install(classLoader)
            requireReload()
            log.i("System Emoji: native hooks installed; refresh the channel")
        } catch (error: Throwable) {
            next.recordError(error)
            next.close()
            log.i("System Emoji: hooks unavailable: $error")
        }
    }
    stop {
        session?.close()
        session = null
        // Public bridge API has no unregister. Overwrite only our own sync method.
        registerNativeMethod(STATUS) { mapOf("active" to false) }
        requireReload()
        log.i("System Emoji: hooks removed; reload to refresh existing pills")
    }
}

private class ReactionSession {
    @Volatile private var active = false
    @Volatile private var lastError = ""
    private val depth = ThreadLocal<Int>()
    private val hooks = mutableListOf<XC_MethodHook.Unhook>()
    private val reactionCalls = AtomicInteger()
    private val replacements = AtomicInteger()
    private val errors = AtomicInteger()

    fun status(): Map<String, Any> = mapOf(
        "active" to active,
        "renderer" to "fixed-slot-v3",
        "reactionCalls" to reactionCalls.get(),
        "unicodeReplacements" to replacements.get(),
        "errors" to errors.get(),
        "lastError" to lastError,
    )

    fun recordError(error: Throwable) {
        errors.incrementAndGet()
        lastError = "${error.javaClass.simpleName}: ${error.message ?: "unknown error"}"
    }

    fun install(loader: ClassLoader) {
        fun cls(name: String) = Class.forName(name, false, loader)
        val reactionView = cls("com.discord.reactions.ReactionView")
        val unicodeClass = cls("com.discord.emoji.RenderableEmoji\$Unicode")
        val surrogates = unicodeClass.getDeclaredField("surrogates").apply { isAccessible = true }
        check(surrogates.type == String::class.java) { "Unexpected Unicode.surrogates type" }
        val reactionMethod = reactionView.getDeclaredMethod(
            "setReaction",
            cls("com.discord.reactions.ReactionView\$Reaction"),
            cls("com.discord.reactions.ReactionView\$ReactionsTheme"),
        )
        val builderClass = cls("com.facebook.drawee.span.DraweeSpanStringBuilder")
        check(SpannableStringBuilder::class.java.isAssignableFrom(builderClass)) {
            "Unexpected emoji span builder"
        }
        val renderer = cls("com.discord.emoji.RenderableEmojiKt").getDeclaredMethod(
            "renderEmojiInto",
            builderClass,
            cls("com.discord.emoji.RenderableEmoji"),
            cls("android.content.Context"),
            Integer.TYPE,
            java.lang.Boolean.TYPE,
            Integer.TYPE,
            cls("kotlin.jvm.functions.Function1"),
        )
        check(renderer.returnType == Void.TYPE) { "Unexpected renderEmojiInto return type" }
        check(reactionMethod.returnType == Void.TYPE) { "Unexpected setReaction return type" }

        // Validate all names before registering either hook. Both hooks remain
        // inactive until installation completes; failure rolls back in start.
        hooks += XposedBridge.hookMethod(reactionMethod, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                depth.set((depth.get() ?: 0) + 1)
                if (active) reactionCalls.incrementAndGet()
            }

            override fun afterHookedMethod(param: MethodHookParam) {
                val remaining = (depth.get() ?: 1) - 1
                if (remaining <= 0) depth.remove() else depth.set(remaining)
            }
        })
        hooks += XposedBridge.hookMethod(renderer, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                if (!active || (depth.get() ?: 0) == 0) return
                val emoji = param.args[1]
                if (!unicodeClass.isInstance(emoji)) return
                val builder = param.args[0] as? SpannableStringBuilder ?: return
                val originalLength = builder.length
                try {
                    val text = surrogates.get(emoji) as? String ?: return
                    if (text.isEmpty() || text == "©" || text == "®" || text == "™") return
                    val sizePx = param.args[3] as? Int ?: return
                    if (sizePx <= 0) return
                    val alignment = param.args[5] as? Int ?: return
                    val drawable = SystemEmojiDrawable(text, sizePx)
                    val imageSpan = SystemEmojiSpan(drawable, sizePx, alignment)
                    val span = SpannableString(text)
                    span.setSpan(imageSpan, 0, span.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.append(span)
                    param.setResult(null)
                    replacements.incrementAndGet()
                } catch (error: Throwable) {
                    // Keep the original renderer available if our text path fails.
                    if (builder.length > originalLength) builder.delete(originalLength, builder.length)
                    recordError(error)
                }
            }
        })
        active = true
    }

    fun close() {
        active = false
        hooks.asReversed().forEach { hook ->
            try { hook.unhook() } catch (error: Throwable) { recordError(error) }
        }
        hooks.clear()
    }
}

/** Fixed image-style layout, implemented locally using Android's public API. */
private class SystemEmojiSpan(
    private val drawable: Drawable,
    private val sizePx: Int,
    private val alignment: Int,
) : ReplacementSpan() {
    // Fresco image alignment values: bottom=0, baseline=1, center=2.
    // Keep font measurements from the surrounding reaction text, not the glyph.
    private fun slotTop(metrics: Paint.FontMetricsInt): Int = when (alignment) {
        0 -> metrics.descent - sizePx
        2 -> metrics.ascent + (metrics.descent - metrics.ascent - sizePx) / 2
        else -> -sizePx
    }

    override fun getSize(
        paint: Paint, text: CharSequence, start: Int, end: Int,
        fm: Paint.FontMetricsInt?,
    ): Int {
        if (fm != null) {
            val top = slotTop(fm)
            val bottom = top + sizePx
            fm.ascent = minOf(fm.ascent, top)
            fm.top = minOf(fm.top, top)
            fm.descent = maxOf(fm.descent, bottom)
            fm.bottom = maxOf(fm.bottom, bottom)
        }
        return sizePx
    }

    override fun draw(
        canvas: Canvas, text: CharSequence, start: Int, end: Int,
        x: Float, top: Int, y: Int, bottom: Int, paint: Paint,
    ) {
        val saved = canvas.save()
        try {
            canvas.translate(x, (y + slotTop(paint.fontMetricsInt)).toFloat())
            drawable.draw(canvas)
        } finally {
            canvas.restoreToCount(saved)
        }
    }
}

/** A system-font glyph with layout dimensions independent of its font metrics. */
private class SystemEmojiDrawable(private val emoji: String, sizePx: Int) : Drawable() {
    private val glyphPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        textSize = sizePx.toFloat()
    }
    private val ink = Rect()

    init {
        setBounds(0, 0, sizePx, sizePx)
        // Measure the whole sequence so flags, modifiers and ZWJ emoji stay intact.
        glyphPaint.getTextBounds(emoji, 0, emoji.length, ink)
        if (ink.isEmpty) {
            val metrics = glyphPaint.fontMetricsInt
            ink.set(0, metrics.ascent, kotlin.math.ceil(glyphPaint.measureText(emoji)).toInt(), metrics.descent)
        }
        check(!ink.isEmpty) { "System emoji has no drawable bounds" }
    }

    override fun draw(canvas: Canvas) {
        val box = bounds
        if (box.isEmpty) return
        val scale = minOf(1f, box.width().toFloat() / ink.width(), box.height().toFloat() / ink.height())
        val saved = canvas.save()
        try {
            canvas.clipRect(box)
            canvas.translate(box.exactCenterX(), box.exactCenterY())
            canvas.scale(scale, scale)
            canvas.drawText(emoji, -ink.exactCenterX(), -ink.exactCenterY(), glyphPaint)
        } finally {
            canvas.restoreToCount(saved)
        }
    }

    override fun setAlpha(alpha: Int) {
        glyphPaint.alpha = alpha
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        glyphPaint.colorFilter = colorFilter
        invalidateSelf()
    }

    @Suppress("DEPRECATION")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
