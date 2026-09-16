package com.nyx.android;

import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;

/**
 * 系统 TTS（D-374 的「立即可用」那一半）。
 *
 * WebView 里没有 speechSynthesis（真机探过：http 源下 undefined），
 * 所以系统朗读必须走原生。原生保持傻：读什么、什么口音、什么语速、
 * 还是该播缓存 —— 全是 JS 侧（db/tts.ts）判完了递过来的。
 *
 * ★ TextToSpeech 初始化是异步的：第一次 speak 可能赶在 onInit 之前 ——
 *   存成 pending，好了再读，不丢。引擎缺失/初始化失败如实报错误态，
 *   不静默（CLAUDE.md：没接上的要当场说）。
 */
@CapacitorPlugin(name = "NyxTts")
public class TtsPlugin extends Plugin {
    private TextToSpeech tts = null;
    /** null=还在初始化 · TRUE=可用 · FALSE=这台机器没有能用的引擎 */
    private Boolean ready = null;
    private String pendingText = null, pendingLang = null;
    private float pendingRate = 1f;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            ready = status == TextToSpeech.SUCCESS;
            if (ready && pendingText != null) {
                doSpeak(pendingText, pendingLang, pendingRate);
                pendingText = null;
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            try { tts.shutdown(); } catch (Exception ignored) {}
            tts = null;
        }
        super.handleOnDestroy();
    }

    private void doSpeak(String text, String lang, float rate) {
        // Locale.forLanguageTag 认 "en-GB" 这种 BCP-47（就是偏好里存的形状）
        tts.setLanguage(Locale.forLanguageTag(lang == null ? "en-GB" : lang));
        tts.setSpeechRate(rate);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "nyx");
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "en-GB");
        float rate = call.getFloat("rate", 1f);
        JSObject out = new JSObject();
        if (Boolean.FALSE.equals(ready)) {
            out.put("ok", false);
            out.put("why", "这台手机上没有可用的语音引擎。");
            call.resolve(out);
            return;
        }
        if (ready == null) {
            // 引擎还在起 —— 记下来，onInit 好了就读。对使用者是「点了稍等半秒响」
            pendingText = text; pendingLang = lang; pendingRate = rate;
        } else {
            doSpeak(text, lang, rate);
        }
        out.put("ok", true);
        call.resolve(out);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null && Boolean.TRUE.equals(ready)) {
            try { tts.stop(); } catch (Exception ignored) {}
        }
        pendingText = null;
        call.resolve();
    }
}
