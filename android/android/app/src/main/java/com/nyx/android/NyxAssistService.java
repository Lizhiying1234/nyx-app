package com.nyx.android;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.animation.ValueAnimator;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RadialGradient;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.animation.DecelerateInterpolator;
import android.speech.tts.TextToSpeech;
import android.view.Display;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Nyx Assist Selection（D-398/D-399/D-402）
 *
 * ══ D-402 · 持续取词模式 ═══════════════════════════════════════
 *   「Assist 是一个持续的取词模式，而不是一次性的操作。」
 *   · 星 = Assist Mode Toggle：点一下进模式，再点一下才退出
 *   · Save / 气泡消失 / 查词结束 **都不退出模式** —— 单次 Selection/Bubble
 *     的生命周期与模式生命周期彻底分离
 *   · 模式内宿主 App 照常能用：非选词手势（滚动/点按/宿主长按）原样
 *     转发回宿主（dispatchGesture）；层不抢焦点（返回键归宿主）
 *   · 每次手指按下现场重读当前窗口 —— 滚动后、切到别的 App 后都新鲜
 *   · 星双状态（DS §4.5 同编码）：OFF=空心轮廓静止 · ON=实心+柔光呼吸+
 *     双星芒，转场 320ms「苏醒」——值未冻结，登记待 DS §11 收编（D-326）
 *
 * ══ 定版体验（D-399 两道 Gate + D-403/D-404 原则）══════════
 *   Selection Gate：长按 → 真选区高亮 + 两枚端点柄，可拖调（词粒度）。
 *   In-place Gate：抬手 → 气泡立即出现在选区行正下方（空间不足翻上方）。
 *   ★ D-403① Selection = Lookup Trigger：选区落定就是查词开始。
 *   ★ D-404②③ 默认路径**只有 AI**：卡片一出现就在生成简明释义，
 *     词典不再抢跑；等待是卡片里的轻量占位，不是另开一个页面。
 *   ★ D-404⑤ Dictionary 改成**点了才查**，并按**词典自己的**信息结构
 *     渲染（词条原始 HTML），不重新包装成我们 AI 卡片的样子。
 *   「我只是选了一个词，Nyx 就安静地告诉我它是什么意思。」
 *
 * ══ 数据纪律 ═════════════════════════════════════════════════
 *   · 查词与写库都交给 AssistEngine（服务自己的无头 WebView，跑的是
 *     src/db/* 那一份判据）—— 不再 RPC 打给 App 主进程的 WebView。
 *     ★★★ 那正是「跳回 Nyx」的根因：那个 WebView 只活在 MainActivity
 *     里，叫醒它只能 startActivity。现在整条链路一次 Activity 都不起。
 *   · L0 词面状态也走引擎（T-6.1 / R-004）：原生这一侧一句业务 SQL 都不留。
 *     `capture.ts::assistStatus` 是唯一那份判据 —— 认不认得、挂在哪一讲由它答；
 *     默认认读层同理（裁决 ⑩：一律 A、不记忆上一次）。原生只做采集与渲染。
 *   · D-399③：保存带词所在完整句子；判不出句界 → 整节点原文。
 *   · D-335：只在用户手指按下那一刻读当前窗口，不监听不常驻。
 */
public class NyxAssistService extends AccessibilityService {
    private static final String TAG = "NyxAssist";
    private WindowManager wm;
    private StarView star;
    private WindowManager.LayoutParams starLp;
    private FrameLayout layer;          // 取词模式全屏层（透明；不抢焦点）
    private SelectionView selView;
    private LinearLayout bubble;
    private FrameLayout.LayoutParams bubbleLp;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private float density;
    /** overlay 窗口原点相对屏幕的偏移（含状态栏）—— 词矩形是屏幕系，绘制/布局要减它 */
    private int winX = 0, winY = 0;
    /** D-402 · 模式状态 —— 与单次选区/气泡完全分离 */
    private boolean modeOn = false;

    /** D-400⑨ · 总开关/悬浮星（默认全开 —— 没写过键 = 开）；服务起来读库，Settings 拨动即推 */
    private boolean cfgEnabled = true;
    private static NyxAssistService active = null;

    /** D-404① · Assist 自己的引擎（无头 WebView，跑 src/db 那一份判据） */
    private AssistEngine engine;

    // ── 气泡状态（每个气泡一套，showBubble 里重置）──────────────
    private String bubbleTerm = null;
    private String bubbleSentence = null;
    /** 卡片顶部那一行简明释义（Quick AI）—— 选区落定就自动开始 */
    private TextView tvQuick = null;
    private String quickText = null, quickErr = null;
    private boolean quickWaiting = false;
    /** 展开区（点 AI / Dictionary 才出现；再点同一个收起） */
    private FrameLayout lkBox;
    private ScrollView lkScroll;
    private LinearLayout lkContent;
    private WebView dictWeb;
    private TextView tabAi, tabDict;
    /** null=收起 · "ai" · "dict" */
    private String openTab = null;
    private JSONArray secFull = null, secDict = null;
    private String noteFull = null, noteDict = null;
    private String errFull = null, errDict = null;
    private boolean fullWaiting = false, dictWaiting = false, dictMiss = false;
    /** 词条 HTML（词典自己的结构，D-404⑤）：[书名, html]；css = 词典自带样式表 */
    private String dictBook = null, dictHtml = null, dictCss = null;
    /** 词典 Tab 正在看的词 —— 方框链跳转后可以 ≠ bubbleTerm（在词典里走动是
     *  D-404⑤ 的延伸；卡片身份 Save/AI/状态行仍是宿主里选的那个词）。null = 没跳过 */
    private String dictTerm = null;
    /** 跨词条跳转要滚到的锚点 —— 用一次即清 */
    private String pendingDictAnchor = null;

    // ── 保存状态 ────────────────────────────────────────────────
    private TextView bubbleDef = null;
    private boolean saveWaiting = false;

    /** D-403⑦ · 等待占位的轻呼吸（· ·· ···）—— 有等待感也要精美 */
    private int dotPhase = 0;
    private final Runnable dotTick = new Runnable() {
        @Override public void run() {
            if (!quickWaiting && !fullWaiting && !dictWaiting) return;
            dotPhase = (dotPhase + 1) % 3;
            renderQuick();
            renderTab();
            ui.postDelayed(this, 380);
        }
    };
    private String dots() {
        return dotPhase == 0 ? "·" : dotPhase == 1 ? "· ·" : "· · ·";
    }

    private void beat() {
        ui.removeCallbacks(dotTick);
        dotPhase = 0;
        ui.postDelayed(dotTick, 380);
    }

    /**
     * 查词（D-404）：kind = quick | full | dict。
     * ★ 全程不碰 Activity —— 引擎就在这个进程里，答复直接回到气泡。
     */
    private void requestLookup(final String kind) {
        if (bubbleTerm == null || engine == null) return;
        final String owner = bubbleTerm; // 气泡身份 —— 陈旧答复靠它丢，不靠查询词
        final String term = "dict".equals(kind) && dictTerm != null ? dictTerm : bubbleTerm;
        JSONObject a = new JSONObject();
        try {
            a.put("kind", kind);
            a.put("term", term);
            a.put("sentence", bubbleSentence == null ? JSONObject.NULL : bubbleSentence);
        } catch (Exception ignored) {}
        if ("quick".equals(kind)) { quickWaiting = true; quickErr = null; renderQuick(); }
        else if ("full".equals(kind)) { fullWaiting = true; errFull = null; renderTab(); }
        else { dictWaiting = true; errDict = null; renderTab(); }
        beat();
        engine.call("lookup", a, (ok, json) -> {
            if (!owner.equals(bubbleTerm)) return; // 气泡换过了 —— 陈旧答复直接丢
            applyLookup(kind, ok, json);
        });
    }

    private void applyLookup(String kind, boolean ok, String json) {
        JSONObject o;
        try {
            o = new JSONObject(json == null ? "{}" : json);
        } catch (Exception e) {
            o = new JSONObject();
        }
        if ("quick".equals(kind)) quickWaiting = false;
        else if ("full".equals(kind)) fullWaiting = false;
        else dictWaiting = false;
        if (!ok) {
            String msg = o.optString("title", "查询失败");
            String detail = o.optString("detail", "");
            // ★ 离线态说清（阶段 7 第四件）：连接类失败聚合成一句人话 ——
            //   为什么要网 + 现在不通 + 本地的都不受影响。分类判据在 core 不动，
            //   这里只管气泡上怎么说（VPN 黑洞下走的是超时分支，话术同族）。
            if ((msg + " " + detail).matches(
                    "(?is).*(连不上网|连不上|unable to resolve|failed to connect|unreachable|timed? ?out|超时了).*")) {
                msg = "AI 要联网（释义来自线上模型）—— 现在网络不通。词典与保存都在本机，不受影响。";
            } else if (!detail.isEmpty()) {
                // ★ 详情里可能是服务商原文（甚至一整页 HTML）—— 卡片只留一句人话，
                //   详情裁短并去标签，绝不把原始响应糊到屏幕上（乱码事故的另一半）
                msg = msg + " —— " + brief(detail);
            }
            if ("quick".equals(kind)) quickErr = msg;
            else if ("full".equals(kind)) errFull = msg;
            else errDict = msg;
            // D-404 兜底：AI 没配好时不能让卡片空着 —— 自动改问本地词典，
            // 并如实说明这是退而求其次（默认路径仍然只有 AI）
            if ("quick".equals(kind) && secDict == null && !dictWaiting) {
                openTab = "dict";
                styleTabs();
                requestLookup("dict");
            }
            renderQuick();
            renderTab();
            return;
        }
        JSONArray arr = o.optJSONArray("sections");
        if (arr == null) arr = new JSONArray();
        if ("quick".equals(kind)) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject s = arr.optJSONObject(i);
                if (s == null) continue;
                if (sb.length() > 0) sb.append('\n');
                sb.append(s.optString("text", ""));
            }
            quickText = sb.toString().trim();
            renderQuick();
            return;
        }
        if ("full".equals(kind)) {
            secFull = arr;
            noteFull = o.optString("note", null);
        } else {
            secDict = arr;
            noteDict = o.optString("note", null);
            dictMiss = o.optBoolean("miss", false);
            dictBook = null;
            dictHtml = null;
            dictCss = null;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject s = arr.optJSONObject(i);
                if (s != null && !s.optString("html", "").isEmpty()) {
                    dictBook = s.optString("label", "");
                    dictHtml = s.optString("html", "");
                    dictCss = s.optString("css", "");
                    break;
                }
            }
        }
        renderTab();
    }

    /** 服务商原文/HTML → 一句人话（最多 120 字，标签与空白都清掉） */
    private static String brief(String s) {
        String t = s.replaceAll("(?is)<(script|style)[^>]*>.*?</\\1>", " ")
            .replaceAll("<[^>]+>", " ")
            .replaceAll("\\s+", " ")
            .trim();
        return t.length() > 120 ? t.substring(0, 120) + "…" : t;
    }

    // ── 生命周期 ────────────────────────────────────────────────
    /**
     * ★ 只用来认「现在前台是谁」——**不读任何内容**（D-335 的界线在这里）。
     * 为什么需要：D-402 让气泡与取词模式跨 App 存续（误触切走宿主时不该白选一次），
     * 但旧的选区高亮与卡片也跟着过去了 —— 在 Instagram 里还挂着 YouTube 那个词。
     * 换了宿主就把这一次的选区收掉；模式不动（模式与单次选区分离，D-402）。
     * 系统 UI（下拉通知栏之类）不算换宿主。
     */
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!modeOn || event == null) return;
        int t = event.getEventType();
        if (t == AccessibilityEvent.TYPE_WINDOWS_CHANGED) { syncImeAvoid(); return; }
        if (t != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        syncImeAvoid();
        CharSequence p = event.getPackageName();
        if (p == null) return;
        String pkg = p.toString();
        if (pkg.equals(getPackageName()) || pkg.startsWith("com.android.systemui")) return;
        // 键盘弹起/收起不是换宿主 —— 选区不动（IME 场景批）
        if (isImePkg(pkg)) return;
        if (selPkg != null && !pkg.equals(selPkg) && selView != null && selView.selA >= 0) {
            ui.post(() -> { if (selView != null) selView.clearSelection(); });
        }
    }

    /** 这是输入法的包吗（默认 IME 设置串形如 pkg/.Service）—— 不读任何窗口内容 */
    private boolean isImePkg(String pkg) {
        try {
            String di = android.provider.Settings.Secure.getString(
                getContentResolver(), android.provider.Settings.Secure.DEFAULT_INPUT_METHOD);
            return di != null && di.startsWith(pkg + "/");
        } catch (Exception ignored) {
            return false;
        }
    }

    /**
     * IME 可见时把层的高度缩到键盘顶（阶段 7 第二件 · IME 场景）。
     * 层在 IME **之上**（TYPE_ACCESSIBILITY_OVERLAY z 序更高）——不避让的话：
     * 打字每一击都要过「缓存→抬手重放」；滑行输入被当滚动；长按键帽等变音
     * 会被 OCR 当成选词。缩层后键盘区回归**完全原生**，正文区选词照旧。
     * 只认「贴底的整块键盘」：太小的悬浮条不值得切层。
     */
    private void syncImeAvoid() {
        if (layer == null) return;
        int top = -1;
        try {
            int sh = getResources().getDisplayMetrics().heightPixels;
            for (android.view.accessibility.AccessibilityWindowInfo w : getWindows()) {
                if (w == null) continue;
                if (w.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue;
                Rect b = new Rect();
                w.getBoundsInScreen(b);
                if (b.height() > sh * 0.15f && b.bottom > sh * 0.85f) top = b.top;
            }
        } catch (Exception ignored) {}
        if (top == imeTop) return;
        imeTop = top;
        try {
            WindowManager.LayoutParams lp = (WindowManager.LayoutParams) layer.getLayoutParams();
            lp.height = top > 0 ? top : WindowManager.LayoutParams.MATCH_PARENT;
            wm.updateViewLayout(layer, lp);
            probe("imeAvoid top=" + top);
        } catch (Exception ignored) {}
    }

    /** 气泡与卡片能用的屏幕底边：键盘弹着就到键盘顶为止（别把卡片摆进键盘底下） */
    private int screenBottom() {
        int sh = getResources().getDisplayMetrics().heightPixels;
        return imeTop > 0 ? Math.min(imeTop, sh) : sh;
    }
    @Override public void onInterrupt() {}

    @Override protected void onServiceConnected() {
        super.onServiceConnected();
        active = this;
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        density = getResources().getDisplayMetrics().density;
        engine = new AssistEngine(this);
        readConfig();
        syncStar();
    }

    @Override public void onDestroy() {
        if (active == this) active = null;
        exitMode();
        removeStar();
        // ★ T-6.6 · 引擎没了就不会有回调来放闸了 —— 在这里放，免得下次起来时锁着
        if (engine != null) { engine.destroy(); engine = null; ttsBusy = false; }
        stopPronounce();
        if (svcTts != null) { try { svcTts.shutdown(); } catch (Exception ignored) {} svcTts = null; }
        super.onDestroy();
    }

    // ── 发音（指令第九则 · D-374 两级在气泡上的样子）───────
    //   ★ T-7.5 起「用谁读」全部由引擎按 core/voice 那一份序列定：
    //   引擎交回来的要么是**字节**（词典音 / 缓存音），要么是一句
    //   「请你现读」（source=system，带口音与语速）。原生只做播放这一件事。
    //   在那之前，缓存那一级是原生自己判的（文件在就播）—— 于是「用谁读」
    //   一半在引擎、一半在 Java，两处都改不干净。
    private TextToSpeech svcTts = null;
    private Boolean svcTtsReady = null;
    private String ttsPending = null, ttsPendingLang = "en-GB";
    private float ttsPendingRate = 1f;
    private MediaPlayer player = null;

    /**
     * ★★ T-6.6 · **一次只跑一趟发音。**
     *
     * 真机实测：未命中那一趟要 53 秒，连点三次就排到 142.6 秒 —— 后两下**纯粹是等**，
     * 而且它们排在引擎那条单线队列里，把 status / lookup / save 一起堵死（C，2026-09-06）。
     * 所以在跑的时候新的点击**直接丢掉**，不叠上去。
     *
     * ★ 为什么丢而不是排队：排队对他没有价值 —— 他连点是因为「第一下好像没反应」，
     *   给他三遍同一个词只会让等待变成三倍。第一趟的喇叭还亮着（`playing(true)`），
     *   界面上本来就在说「在跑」。
     * ★ Java 里只有这一个布尔，判据（读什么、用谁读、预算多少）一个字都不在这一层。
     */
    private boolean ttsBusy = false;

    /**
     * 连接③ 上一次读回来的 `busy_timeout`（-1 = 没设上）。
     * ★ 记它只为**在探针开关读到之后**写得出那一行 —— 不参与任何判断。
     */
    private int lastBusyTimeoutMs = -1;

    private void pronounce(final String word, final SpeakerView spk, final boolean flip) {
        // ★ T-6.5 · TTFA 的**零点**就是这一行；下面每一条探针都拿它当基准
        final long t0 = System.currentTimeMillis();
        probe("pronounce " + word);
        if (word == null || word.trim().isEmpty()) return;
        if (ttsBusy) {
            probe("pronounce dropped (busy) " + word);
            return; // 见上：正在跑的那一趟还在，喇叭也还亮着
        }
        stopPronounce();
        spk.playing(true);
        JSONObject a = new JSONObject();
        try { a.put("text", word); a.put("flip", flip); } catch (Exception ignored) {}
        ttsBusy = true;
        engine.call("tts", a, (ok, json) -> ui.post(() -> {
            // ★ T-6.6 · 第一句就放闸 —— 下面每一条 return 都在它后面，忘不掉
            ttsBusy = false;
            probe("tts result ok=" + ok + " " + (json == null ? "null" : json.substring(0, Math.min(300, json.length()))));
            /**
             * ★★ T-6.5 · 引擎往返用了多久，以及**每一步各用了多久**。
             *
             * 上面那行为了不把 probe.txt 撑爆只印前 300 字，而 `tried`（core 的
             * `StepRecord[]`：每一步的 source / outcome / **ms**）常常正好被截在外面 ——
             * 那正是「词典扫描到底占了多少」这个问题的答案所在。所以单独印一行，
             * 并且**只印 `tried` 与 `pronStats`**（不含 base64，不会撑爆）。
             * `pronStats` 是词典那一步自己记的账：扫了几本、其中几本是现开的（索引重建）。
             */
            probe("tts trip " + (System.currentTimeMillis() - t0) + "ms " + briefTts(json));
            String accent = "en-GB"; float rate = 1f;
            /**
             * ★★ T-7.5：顺序**不在这里**了。
             *   这一段原来自己做后两级（缓存文件在就播、否则系统音）——
             *   于是「用谁读」一半在引擎、一半在 Java。现在引擎照
             *   `core/voice` 那一份序列跑完，交回来的只有两种东西：
             *     · 字节（词典音 / 缓存音，谁赢了 `source` 里写着）→ 播
             *     · 「请你现读」（source=system）→ 系统 TTS
             *   播放逻辑一个字没动，动的只是这几行入口。
             */
            boolean useSystem = !ok;   // 引擎起不来时照旧兜底读，不让他按了没反应
            if (ok) {
                JSONObject o;
                try { o = new JSONObject(json); } catch (Exception e) { o = new JSONObject(); }
                String audio = o.optString("audioB64", "");
                if (!audio.isEmpty()) {
                    try {
                        // ★ T-6.5 怀疑点 ④ · base64 过桥 + 写临时文件到底占多少
                        final long tB = System.currentTimeMillis();
                        File c = new File(getCacheDir(), "pron.mp3");
                        java.io.FileOutputStream w = new java.io.FileOutputStream(c);
                        byte[] raw = android.util.Base64.decode(audio, android.util.Base64.DEFAULT);
                        w.write(raw);
                        w.close();
                        probe("tts hit " + o.optString("source", "?"));
                        probe("bridge b64=" + audio.length() + "chars bytes=" + raw.length
                            + " decode+write=" + (System.currentTimeMillis() - tB) + "ms"
                            + " since0=" + (System.currentTimeMillis() - t0) + "ms");
                        playFile(c, spk, t0);
                        return;
                    } catch (Exception e) {
                        /* 写不了缓存文件 —— 落到系统音，别把这一次吞掉 */
                        useSystem = true;
                    }
                }
                if ("system".equals(o.optString("source", ""))) useSystem = true;
                accent = o.optString("accent", "en-GB");
                rate = (float) o.optDouble("rate", 1.0);
                if (!useSystem) probe("tts none " + o.optString("why", ""));
            }
            if (useSystem) speakWord(word, accent, rate, spk, t0);
            else spk.playing(false);   // 一步都没排上（来源全关了）—— 如实不出声
        }));
    }

    /**
     * ★ T-6.5 · 只把 `tried`（每一步的 source / outcome / ms）与 `pronStats`
     *   （词典那一步扫了几本、几本是现开的）挑出来 —— 别的字段（尤其 `audioB64`）
     *   一个字都不带，探针不许被音频撑爆。取不出来就原样说「-」，不猜。
     *
     * ★★ T-7.9 多一样 `skipped=`：账本（`VoiceTrace`）里**被跳过的那几步与原因**。
     *   `tried` 里根本不会有它们（它只记真的跑过的），而「为什么没用云端」的答案
     *   往往正在这里 —— 关着 / 没配 / 这台机器上用不了。这一行是它在真机上唯一的出口。
     *   ★ 只挑 skipped，不整个把 trace 印出来：其余部分与 `tried` 重复，白占探针文件。
     */
    private static String briefTts(String json) {
        if (json == null) return "-";
        try {
            JSONObject o = new JSONObject(json);
            String tried = o.has("tried") ? o.get("tried").toString() : "-";
            String stats = o.has("pronStats") ? o.get("pronStats").toString() : "-";
            return "tried=" + tried + " skipped=" + skippedOf(o)
                + " dict=" + stats + " source=" + o.optString("source", "?");
        } catch (Exception e) {
            return "unparsed";
        }
    }

    /** 账本里 outcome=skipped 的那几步，印成 `来源(为什么)`。零判据，只是搬字 */
    private static String skippedOf(JSONObject o) {
        JSONObject tr = o.optJSONObject("trace");
        JSONArray steps = tr == null ? null : tr.optJSONArray("steps");
        if (steps == null) return "-";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < steps.length(); i++) {
            JSONObject st = steps.optJSONObject(i);
            if (st == null || !"skipped".equals(st.optString("outcome", ""))) continue;
            if (b.length() > 0) b.append(", ");
            b.append(st.optString("source", "?")).append('(').append(st.optString("reason", "")).append(')');
        }
        return b.length() == 0 ? "(无)" : b.toString();
    }

    private void playFile(File f, final SpeakerView spk, final long t0) {
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            player.setDataSource(f.getPath());
            player.setOnCompletionListener(mp -> { if (spk != null) spk.playing(false); stopPronounce(); });
            // ★ T-6.5 怀疑点 ④ · 每次都新建 MediaPlayer，prepare 占多少
            final long tP = System.currentTimeMillis();
            player.prepare();
            player.start();
            // ★★ 这一行就是 **Time-to-First-Audio**（字节那条路）：从按下到真的出声
            probe("audio start prepare=" + (System.currentTimeMillis() - tP) + "ms"
                + " TTFA=" + (System.currentTimeMillis() - t0) + "ms");
        } catch (Exception e) {
            probe("audio fail " + e + " since0=" + (System.currentTimeMillis() - t0) + "ms");
            if (spk != null) spk.playing(false);
            stopPronounce();
        }
    }

    private void speakWord(String word, String accent, float rate, final SpeakerView spk, final long t0) {
        if (svcTts == null) {
            // ★★ T-6.5 怀疑点 ③ · 系统 TTS **第一次用时才建**，冷启动占多少全在这一段
            final long tT = System.currentTimeMillis();
            probe("systts new (cold) since0=" + (tT - t0) + "ms");
            svcTts = new TextToSpeech(this, st -> {
                svcTtsReady = st == TextToSpeech.SUCCESS;
                probe("systts init ok=" + svcTtsReady + " took=" + (System.currentTimeMillis() - tT) + "ms"
                    + " since0=" + (System.currentTimeMillis() - t0) + "ms");
                if (Boolean.TRUE.equals(svcTtsReady) && ttsPending != null) {
                    doTts(ttsPending, ttsPendingLang, ttsPendingRate, t0);
                    ttsPending = null;
                }
            });
        } else {
            probe("systts warm ready=" + svcTtsReady + " since0=" + (System.currentTimeMillis() - t0) + "ms");
        }
        if (Boolean.TRUE.equals(svcTtsReady)) doTts(word, accent, rate, t0);
        else if (svcTtsReady == null) { ttsPending = word; ttsPendingLang = accent; ttsPendingRate = rate; }
        // 读完没有干净的回调线程可接 —— 词很短，亮态 900ms 后自己收
        ui.postDelayed(() -> spk.playing(false), 900);
    }

    private void doTts(String word, String accent, float rate, long t0) {
        try {
            svcTts.setLanguage(java.util.Locale.forLanguageTag(accent));
            svcTts.setSpeechRate(rate);
            svcTts.speak(word, TextToSpeech.QUEUE_FLUSH, null, "nyx-assist");
            // ★★ 这一行是 **TTFA**（系统音那条路）—— `speak()` 交给引擎的那一刻。
            //   ★ 它不等于耳朵听见：系统 TTS 自己还有一段合成延迟，这里量不到，
            //     四组表里 C 组的数要按「≥ 这个数」读（真机上再对一次秒表）。
            probe("systts speak accent=" + accent + " rate=" + rate
                + " TTFA=" + (System.currentTimeMillis() - t0) + "ms");
        } catch (Exception e) {
            probe("systts speak fail " + e);
        }
    }

    private void stopPronounce() {
        if (player != null) { try { player.release(); } catch (Exception ignored) {} player = null; }
        if (svcTts != null && Boolean.TRUE.equals(svcTtsReady)) { try { svcTts.stop(); } catch (Exception ignored) {} }
    }

    /** 自绘小喇叭 —— nyx-speak 同轮廓（实心三角喇叭 + 两道弧），dim 色不抓层级 */
    private class SpeakerView extends View {
        private final Paint fillP = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint arcP = new Paint(Paint.ANTI_ALIAS_FLAG);
        private boolean on = false;
        SpeakerView(android.content.Context c) {
            super(c);
            fillP.setStyle(Paint.Style.FILL);
            arcP.setStyle(Paint.Style.STROKE);
            arcP.setStrokeCap(Paint.Cap.ROUND);
            setClickable(true);
        }
        void playing(boolean v) { on = v; invalidate(); }
        @Override protected void onDraw(Canvas cv) {
            if (isPressed()) {
                // 主色 10%：按下的涟漪 —— 颜色从令牌来，只有 alpha 是这里定的
                fillP.setColor((tok(NyxAssistService.this, R.color.nyx_violet) & 0x00FFFFFF) | 0x1A000000);
                cv.drawCircle(getWidth() / 2f, getHeight() / 2f, dp(15), fillP);
            }
            int c = on ? tok(NyxAssistService.this, R.color.nyx_violet) : tok(NyxAssistService.this, R.color.nyx_faint);
            fillP.setColor(c); arcP.setColor(c);
            float u = dp(13) / 24f;
            float ox = (getWidth() - dp(13)) / 2f, oy = (getHeight() - dp(13)) / 2f;
            arcP.setStrokeWidth(Math.max(2f, 4.8f * u));
            Path ph = new Path();
            ph.moveTo(ox + 4 * u, oy + 9.5f * u); ph.lineTo(ox + 4 * u, oy + 14.5f * u);
            ph.lineTo(ox + 7.2f * u, oy + 14.5f * u); ph.lineTo(ox + 12 * u, oy + 18.5f * u);
            ph.lineTo(ox + 12 * u, oy + 5.5f * u); ph.lineTo(ox + 7.2f * u, oy + 9.5f * u);
            ph.close();
            cv.drawPath(ph, fillP);
            RectF r1 = new RectF(ox + 11.4f * u, oy + 8f * u, ox + 19.4f * u, oy + 16f * u);
            cv.drawArc(r1, -45, 90, false, arcP);
            RectF r2 = new RectF(ox + 10.4f * u, oy + 4.4f * u, ox + 25.6f * u, oy + 19.6f * u);
            cv.drawArc(r2, -45, 90, false, arcP);
        }
        /**
         * ★ 坑（真机 2026-08-30 探针抓的）：不许自己在 UP 里 setPressed(false) 再调
         * super —— View 的 UP 分支靠内部 pressed 位判定 click，先清掉它 click 就没了
         * （探针里只有 spk-touch 0/1，没有 pronounce）。按压反馈交给系统位 + 重绘。
         */
        @Override protected void drawableStateChanged() {
            super.drawableStateChanged();
            invalidate();
        }
    }

    // ── OCR 兜底（D-406 T3 · D-395「永远只是兜底」）──────────────
    //   触发条件只有一个：按点上结构化层（T1 text / T2 cd）没词。
    //   截一帧 → ML Kit（bundled，离线）→ 词框并进现有词表（行文本进
    //   nodeTexts，保存的整句语境走同一条路）→ 按点重判。识别完位图即弃。

    private void startOcr(final int px, final int py) {
        try {
            if (ocrClient == null) {
                ocrClient = com.google.mlkit.vision.text.TextRecognition.getClient(
                    com.google.mlkit.vision.text.latin.TextRecognizerOptions.DEFAULT_OPTIONS);
            }
            takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(),
                new TakeScreenshotCallback() {
                    @Override public void onSuccess(ScreenshotResult res) {
                        android.graphics.Bitmap hw = android.graphics.Bitmap.wrapHardwareBuffer(
                            res.getHardwareBuffer(), res.getColorSpace());
                        if (hw == null) { res.getHardwareBuffer().close(); ocrDone(px, py, null); return; }
                        android.graphics.Bitmap sw = hw.copy(android.graphics.Bitmap.Config.ARGB_8888, false);
                        hw.recycle();
                        res.getHardwareBuffer().close();
                        if (sw == null) { ocrDone(px, py, null); return; }
                        com.google.mlkit.vision.common.InputImage img =
                            com.google.mlkit.vision.common.InputImage.fromBitmap(sw, 0);
                        ocrClient.process(img)
                            .addOnSuccessListener(t -> ocrDone(px, py, t))
                            .addOnFailureListener(e -> { probe("ocr err " + e); ocrDone(px, py, null); });
                    }
                    @Override public void onFailure(int code) {
                        probe("ocr shot err " + code);
                        ocrDone(px, py, null);
                    }
                });
        } catch (Exception e) {
            probe("ocr err " + e);
            ocrDone(px, py, null);
        }
    }

    /** 识别结果并进词表（UI 线程），按点重判，然后把攥着的手势放行或吞掉 */
    private void ocrDone(int px, int py, com.google.mlkit.vision.text.Text t) {
        ui.post(() -> {
            if (selView == null) return;
            if (t != null) {
                // 上一轮 OCR 的行先撤掉（屏可能滚了）；结构化词不受影响 ——
                // OCR 行永远追加在尾巴上，没有别人引用那些下标
                if (ocrNodeFrom != Integer.MAX_VALUE) {
                    final int from = ocrNodeFrom;
                    words.removeIf(w -> w.node >= from);
                    while (nodeTexts.size() > from) nodeTexts.remove(nodeTexts.size() - 1);
                }
                ocrNodeFrom = nodeTexts.size();
                for (com.google.mlkit.vision.text.Text.TextBlock b : t.getTextBlocks()) {
                    for (com.google.mlkit.vision.text.Text.Line ln : b.getLines()) {
                        String lt = ln.getText();
                        if (lt == null || lt.trim().isEmpty()) continue;
                        int node = nodeTexts.size();
                        nodeTexts.add(lt);
                        int cur = 0;
                        for (com.google.mlkit.vision.text.Text.Element el : ln.getElements()) {
                            Rect bb = el.getBoundingBox();
                            String et = el.getText();
                            if (bb == null || et == null || et.trim().isEmpty()) continue;
                            int at = lt.indexOf(et, cur);
                            if (at < 0) at = cur;
                            cur = at + et.length();
                            words.add(new Word(et, new Rect(bb), node, at, at + et.length()));
                        }
                    }
                }
            }
            SelectionView sv = selView;
            sv.ocrPending = false;
            // 按点优先找 OCR 词（像素框）——命中近似词不算数；60px 内最近的也认
            int idx = -1;
            int bestD = 60 * 60;
            for (int k = 0; k < words.size(); k++) {
                Word w = words.get(k);
                if (w.node < ocrNodeFrom) continue;
                if (w.box.contains(px, py)) { idx = k; break; }
                int dx = Math.max(0, Math.max(w.box.left - px, px - w.box.right));
                int dy = Math.max(0, Math.max(w.box.top - py, py - w.box.bottom));
                int d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; idx = k; }
            }
            if (idx < 0 && sv.approxIdx >= 0 && sv.approxIdx < words.size()) {
                idx = sv.approxIdx; // OCR 没接住 —— 近似命中兜底（绝不当成宿主长按转发）
            }
            if (idx >= 0) {
                sv.selA = idx; sv.selB = idx;
                dismissBubble();
                sv.performHaptic();
                sv.invalidate();
                if (sv.fingerDown) {
                    sv.longPressed = true; // 手指还按着 —— 继续拖就是扩选（同一行内）
                } else {
                    onSelectionSettled(); // 手已抬 —— 直接出卡
                }
                sv.pendingTrail = null;
                return;
            }
            // OCR 也没词：把攥着的手势补转发 —— 宿主只是晚半秒收到自己的长按
            if (sv.pendingTrail != null) {
                forwardGesture(sv.pendingTrail, sv.pendingDur);
                sv.pendingTrail = null;
            }
        });
    }

    /**
     * 真机探针：logcat 被 ROM 限流吞（tools/device/README 老坑）—— 落文件，
     * `run-as com.nyx.android cat files/probe.txt` 读。
     * 平时只留真错误（collect err）；验收要细看时把 PROBE 翻 true 重装。
     * ★ 2026-08-30 它抓过两个 Log.d 抓不到的：SpeakerView 手动 setPressed(false)
     *   拆掉 View 的 click 判定 · YouTube 首树收词与 380ms 长按的竞速。
     */
    /**
     * ★ 2026-09-01 改成**运行期开关**（原来是 `static final false`）。
     *
     * 起因是使用者报的一条事实：**装一次新包，无障碍授权就掉一次**
     * （Android/ColorOS 的安全行为，App 侧改不掉）。而探针原先要靠改常量 +
     * 重装才能打开 —— 也就是说「想看清楚 Assist 到底走了哪条路」这件事，
     * 每次都要**先把 Assist 弄坏**。这条路本身就是错的。
     *
     * 现在读 settings 的 `assist.probe`（'1' 开），和总开关同一次读库；
     * 每次进取词模式再读一遍 —— 所以拨一下星就能生效，不必重装。
     */
    private boolean cfgProbe = false;
    /**
     * ★ T-6.5：写文件那一段搬进 `Probe`（引擎那一侧也要记时间戳，照抄一份就是
     *   两份格式两个开关）。**行为逐字不变** —— 同一个文件、同一个格式、同一个
     *   64 KB 上限、同一个开关；判据仍然只有 `readConfig()` 那一处。
     */
    private void probe(String msg) {
        Probe.write(this, msg);
    }

    private int dp(float v) { return (int) (v * density); }

    /** 开关只读一次库（RO；默认全开）—— 之后靠 Settings 的 assistConfig 推送保持同步 */
    private void readConfig() {
        SQLiteDatabase db = null;
        try {
            File f = getDatabasePath("nyxSQLite.db");
            if (!f.exists()) return;
            db = SQLiteDatabase.openDatabase(f.getPath(), null, SQLiteDatabase.OPEN_READONLY);
            /*
             * ★ 三条连接里的**第三条**（T-2.3 · 审计 R-012）。撞上库锁时等多久 ——
             *   **显式钉住 2500，这一条是有意不跟着涨的那一条。**
             *
             * 库不是 WAL（真机实测 journal_mode = delete），所以只读也会被写挡住：
             * 另外两条连接任何一处在写，这两句读都可能撞 SQLITE_BUSY。
             *
             * 另外两条设的是 15 秒（`src/db/open.ts` · `AssistEngine.db()`），因为它们
             * 都跑在后台线程上，等多久都不碰界面。**这一条不一样**：`readConfig()`
             * 的两个调用点 —— `onServiceConnected()` 与 `enterMode()` —— 都在
             * **无障碍服务的主线程**上。在这里等 15 秒，等的是整个服务和那颗星。
             *
             * 2500 正好是 AOSP 不设时的原生默认（android_database_SQLiteConnection.cpp
             * 里 `static const int BUSY_TIMEOUT_MS = 2500;`）。写下来不是为了改行为，
             * 是为了**钉住**：换 ROM、换插件版本时这个数不会再静默地漂。
             * 代价说清楚：真撞上长写事务时这两句读会失败 —— 那一次用默认值
             * （总开关默认开），下一次进取词模式再读一遍。这比卡住服务好。
             *
             * ★ 走 rawQuery 不走 execSQL：两个理由，任一条都足够。
             *   ① 连接是 OPEN_READONLY，execSQL 那条路按写语句处理；
             *   ② 更要命的一条 —— `pragma busy_timeout = N` **有回值**，而 execSQL
             *      最终落到 `executeNonQuery(…, isPragmaStmt = false)`，`SQLITE_ROW`
             *      直接抛「Queries can be performed using … query or rawQuery methods only.」
             *      （出处与整条调用链见 `AssistEngine.db()` 里那段）。
             *   顺带：rawQuery 的游标是**懒的**，但 pragma 在 prepare 期就已生效；
             *   moveToFirst 是为了把生效值**读回来**，不是为了让它执行。
             * ★ 不是业务 SQL：pragma 只设这条连接自己的等待时长，不碰任何表。
             * ★ 设不上只该**降级**（退回原生的 2500，正好是同一个数），不许把
             *   这个函数真正的活 —— 读那两个开关 —— 一起拖下水。所以单独包一层。
             */
            try {
                Cursor bt = db.rawQuery("pragma busy_timeout = 2500", null);
                int got = bt.moveToFirst() ? bt.getInt(0) : -1;
                bt.close();
                /**
                 * ★★ T-2.3 ②③ 的可读出口（2026-09-07）：这一行原来只进 `Log.i`，
                 *   而这台 ROM 连它一起吞 —— 真机上**读不到**，等于没有验收面。
                 *   现在把值**记下来**，等下面读完探针开关再写进 `probe.txt`
                 *   （那条通道在真机上是验过的：T-6.5 / T-6.6 都靠它）。
                 * ★ 为什么不在这里直接 `probe()`：此刻 `Probe.on` 还没被赋值 ——
                 *   开关就在下面几行才读出来，现在写只会被丢掉。
                 */
                lastBusyTimeoutMs = got;
                Log.i(TAG, "busy_timeout=" + got);
            } catch (Exception e) {
                lastBusyTimeoutMs = -1;
                Log.i(TAG, "busy_timeout set failed, native default stands: " + e);
            }
            // ★ 指令第十则（D-408）：悬浮星不再是独立开关 —— 星只跟总开关。
            //   旧档案里的 assist.floatIcon 从此被忽略（不迁移，读都不读）。
            Cursor c = db.rawQuery(
                "select value from settings where key = 'assist.enabled'", null);
            if (c.moveToNext()) cfgEnabled = !"0".equals(c.getString(0));
            c.close();
            // ★ 探针开关（默认关）—— 见 probe() 的说明：诊断不该以重装为代价
            Cursor p = db.rawQuery(
                "select value from settings where key = 'assist.probe'", null);
            if (p.moveToNext()) cfgProbe = "1".equals(p.getString(0));
            Probe.on = cfgProbe; // ★ 判据只有这一处；`Probe` 只是写入口（T-6.5）
            p.close();
            // ★ 开关到手了，这才写得出去 —— 连接③ 的 busy_timeout 真机读得到的唯一出口
            probe("db busy_timeout=" + lastBusyTimeoutMs + " conn=service");
        } catch (Exception e) {
            Log.d(TAG, "cfg read err " + e);
        } finally {
            if (db != null) try { db.close(); } catch (Exception ignored) {}
        }
    }

    /** Settings 拨动 → 立即生效（D-400⑨：星当场隐显；关总开关连取词模式一起退）
     *  ★ 原来还有第二个参数 floatIcon —— D-408 起星只跟总开关，那个值早已被忽略；
     *    2026-09-04（Phase 1A 清理）连签名一起删掉，免得下一个人以为它还管事。 */
    static void applyConfig(final boolean enabled) {
        final NyxAssistService s = active;
        if (s == null) return;
        s.ui.post(() -> {
            s.cfgEnabled = enabled;
            if (!enabled) s.exitMode();
            s.syncStar();
        });
    }

    private void syncStar() {
        if (cfgEnabled) addStar(); else removeStar();
    }

    private void removeStar() {
        if (star != null) { try { wm.removeView(star); } catch (Exception ignored) {} star = null; }
    }

    /**
     * 保存（D-400① 回执制 · D-404① 就地完成）：
     * 引擎在**本进程**里跑 assistCapture（判据一份），拿到真实路径才说「已收下」。
     * ★ D-402：Save 不是退出动作 —— 回执看完只清这次选区，取词模式继续。
     */
    private void startSave(final String term, final String sentence, final TextView tvDef) {
        if (engine == null) return;
        bubbleDef = tvDef;
        saveWaiting = true;
        tvDef.setVisibility(View.VISIBLE);
        tvDef.setText("收下…");
        JSONObject a = new JSONObject();
        try {
            a.put("term", term);
            a.put("quote", sentence == null ? JSONObject.NULL : sentence);
            // ★ 裁决 ⑩（2026-09-01）：新收下的一律默认认读 A、不记忆上一次 ——
            //   所以这里**不传** layer，默认那一条在引擎里（T-6.1 / R-004）。
            //   原来这儿是去 settings 里读「他上一次选的层」当默认，与裁决 ⑩ 正相反。
            a.put("pkg", hostPkg == null ? JSONObject.NULL : hostPkg);
        } catch (Exception ignored) {}
        engine.call("save", a, (ok, json) -> {
            if (bubbleDef != tvDef) return; // 气泡换过了
            saveWaiting = false;
            JSONObject o;
            try {
                o = new JSONObject(json == null ? "{}" : json);
            } catch (Exception e) {
                o = new JSONObject();
            }
            if (ok) {
                String path = o.optString("path", "");
                tvDef.setText("✓ 已收下 · " + path
                    + (o.optBoolean("dup", false) ? " · 重复收集 ✦" : "") + " · 连同整句语境");
                ui.postDelayed(() -> { if (selView != null) selView.clearSelection(); }, 1600);
            } else {
                tvDef.setText("没收成：" + o.optString("title", "写库失败") + " —— 再点一次保存重试。");
            }
            if (bubble != null) bubble.post(this::clampBubble);
        });
    }

    // ── 悬浮星（D-402 · Assist Mode Toggle · 双状态 · 可拖）──────
    private void addStar() {
        if (star != null) return;
        StarView v = new StarView(this);
        int size = dp(42);
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(size, size,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = getResources().getDisplayMetrics().widthPixels - size - dp(10);
        lp.y = (int) (getResources().getDisplayMetrics().heightPixels * 0.60f);
        v.setOnTouchListener(new View.OnTouchListener() {
            float dx, dy; int sx, sy; boolean moved;
            @Override public boolean onTouch(View vv, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        dx = e.getRawX(); dy = e.getRawY(); sx = lp.x; sy = lp.y; moved = false; return true;
                    case MotionEvent.ACTION_MOVE:
                        if (Math.abs(e.getRawX() - dx) > 18 || Math.abs(e.getRawY() - dy) > 18) moved = true;
                        lp.x = sx + (int) (e.getRawX() - dx);
                        lp.y = sy + (int) (e.getRawY() - dy);
                        try { wm.updateViewLayout(vv, lp); } catch (Exception ignored) {}
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) toggleMode();
                        return true;
                }
                return false;
            }
        });
        star = v;
        starLp = lp;
        wm.addView(v, lp);
        star.setOn(modeOn, false);
    }

    /** 层加上后把星重挂到最上 —— 模式里星必须仍可点（它是唯一的退出口，D-402） */
    private void raiseStar() {
        if (star == null || starLp == null) return;
        try {
            wm.removeView(star);
            wm.addView(star, starLp);
        } catch (Exception ignored) {}
    }

    /** D-402 · 星 = 模式开关：进和出都只由它（和 Settings 总开关）控制 */
    private void toggleMode() {
        if (modeOn) exitMode(); else enterMode();
    }

    // ── 词模型 ─────────────────────────────────────────────────
    private static class Word {
        String text; Rect box; int node; int charStart; int charEnd;
        /** 几何是带内拟合出来的（cd 大卡）—— 命中它时值得用 OCR 精化一帧 */
        boolean approx = false;
        /**
         * ★ F-019（2026-09-01 真机查实）· 这个词的几何是「自己量出来、而且量出了不止一行」。
         *
         * 宿主不给字符坐标时我们用 Paint 自己排版（measureFallback），
         * 而它是**从节点框的左上角开始排**的。对一个独占一行的节点（比如
         * Wikipedia 里 <a>staircase</a> 这种）没问题 —— 框就是那个词。
         * 但对**段落里的一段行内文字**（" so that one can move in height. A "）
         * 就完全不对：那种节点的 getBoundsInScreen 是它所有行片段的并集
         * （整段宽 × 两三行高），而它真正的起点在上一个行内元素结束的地方，
         * 不在框的左边。于是 "move" 被排到了下一行的行首 ——
         * **正好压在真正的 "stairwell" 上面**。
         *
         * 真机实证：按 staircase 的框心 → 对；按 stairwell 的框心 → 卡片显示 "move"。
         * ★ 这不是「OCR 被抬上来了」（原先的怀疑），OCR 那次反而是**正确兜底** ——
         *   按点落空了才去截图，而且如实标了「可能有误」。
         *   真正危险的是这一条：**卡片自信地显示一个你没碰过的词，一句提示都没有。**
         */
        boolean loose = false;
        Word(String t, Rect b, int n, int cs, int ce) { text = t; box = b; node = n; charStart = cs; charEnd = ce; }
    }
    private final List<Word> words = new ArrayList<>();
    private final List<String> nodeTexts = new ArrayList<>();
    /**
     * D-406 T3 · OCR 兜底。从这个下标起的 nodeTexts 是 OCR 行（可能有误 ——
     * D-395 的标记靠它算）；每次换词表清回 MAX。
     */
    private int ocrNodeFrom = Integer.MAX_VALUE;
    private boolean selFromOcr = false;
    private com.google.mlkit.vision.text.TextRecognizer ocrClient = null;
    private String hostPkg = null;
    /** 当前选区是在哪个 App 里做的 —— 换了宿主，旧选区作废 */
    private String selPkg = null;
    /** IME 顶边（屏幕 Y）；-1 = 键盘没弹。层高避让用（阶段 7 · IME 场景） */
    private int imeTop = -1;

    // ── 取词模式进出（D-402：与单次选区完全分离）────────────────
    private void enterMode() {
        if (modeOn || !cfgEnabled) return;
        readConfig(); // ★ 顺手重读探针开关 —— 拨一下星就生效，不必重装（见 probe()）
        modeOn = true;
        addLayer();
        raiseStar();
        if (star != null) star.setOn(true, true);
        toast("取词模式开 · 长按选词（点选区扩整句）· 再点 ✦ 退出");
    }

    /** 取词层的搭建（enterMode 与「滚动放行后重挂」共用） */
    private void addLayer() {
        FrameLayout fl = new FrameLayout(this);
        selView = new SelectionView(fl.getContext());
        fl.addView(selView, new FrameLayout.LayoutParams(-1, -1));
        // ★ 不抢焦点：返回键/输入焦点都归宿主 —— 模式是环境，不是弹窗
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(-1, -1,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        layer = fl;
        wm.addView(fl, lp);
        // ★ D-404① · 引擎预热：进模式就把无头 WebView 起好（首查不必等冷启动）。
        //   1×1 近乎透明地挂在层里 —— 只为让 Chromium 认它「可见」，
        //   否则渲染进程会被系统当后台冻住（2026-08-30 实证的那条坑）。
        if (engine != null) {
            engine.warm();
            WebView ev = engine.view();
            if (ev != null && ev.getParent() == null) {
                ev.setAlpha(0.01f);
                fl.addView(ev, new FrameLayout.LayoutParams(1, 1));
            }
        }
        // ★ 真机 2026-08-30（Discord）：**层的原点会变。** 宿主 App 对系统栏的
        //   处理不一样（Discord 铺满全屏），我们这块层跟着 inset 重排 ——
        //   进模式时读一次就不够了，卡片会整体错位。每次布局变化都重算。
        final Runnable readOrigin = () -> {
            int[] loc = new int[2];
            fl.getLocationOnScreen(loc);
            if (loc[0] == winX && loc[1] == winY) return;
            winX = loc[0];
            winY = loc[1];
            if (selView != null) selView.invalidate();
        };
        fl.post(readOrigin);
        fl.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, orr, ob) -> fl.post(readOrigin));
        imeTop = -1;
        ui.post(this::syncImeAvoid); // 键盘可能本来就弹着（比如从输入框场景点星）
    }

    private void exitMode() {
        dismissBubble();
        // 引擎活着但先摘下来（层要拆了）—— 下次进模式再挂回去，不重建
        if (engine != null && engine.view() != null && engine.view().getParent() != null) {
            ((FrameLayout) engine.view().getParent()).removeView(engine.view());
        }
        if (layer != null) { try { wm.removeView(layer); } catch (Exception ignored) {} layer = null; selView = null; }
        if (modeOn && star != null) star.setOn(false, true);
        modeOn = false;
        imeTop = -1;
    }

    /**
     * 令牌 → 颜色 · **原生层拿颜色的唯一入口**（DS §十五 账③ · 2026-09-01）
     *
     * 以前这里是 34 处 `Color.parseColor("#5B44D6")` —— 一份**手抄的**设计令牌。
     * 2026-08-31 那次「28 处全量对齐 v5」就证明了这条路走不通：对齐要人逐处比对，
     * 当场还漏了两处带 alpha 前缀的（`#595B44D6` / `#F2FCFCFD` 长得不像颜色，
     * grep 抓不到）。改 tokens.css 不报错，只会让气泡和 App 慢慢长得不一样，
     * 而**两边都说得通** —— 本项目定义的最贵事故形态。
     *
     * 现在颜色住在 res/values/nyx_tokens.xml，那份文件由
     * tools/tokens-to-android.mjs 从 src/ui/styles/tokens.css 生成
     * （npm run build 每次都跑，check:tokens 守着不许再写字面量）。
     *
     * ★ 别在这个文件里再写 `Color.parseColor("#…")` —— 写了 check:tokens 会红。
     */
    private static int tok(android.content.Context c, int res) {
        return androidx.core.content.ContextCompat.getColor(c, res);
    }

    private void toast(String msg) {
        if (layer == null) return;
        final TextView t = new TextView(this);
        t.setText(msg);
        // ★ violet 是线与图形的色（压白 2.83）；当文字用一律换 violet-2（5.04）。
        //   这条规则 CSS 那侧 2026-09-07 就执行了（22 处），原生层 2026-09-08 才跟上
        //   —— 真机气泡截图上「Save」那行字比周围淡一档，才看出来漏了。
        t.setTextColor(tok(this, R.color.nyx_violet_2));
        t.setTextSize(12);
        GradientDrawable g = new GradientDrawable();
        g.setColor(tok(this, R.color.nyx_toast));
        g.setCornerRadius(dp(10));
        t.setBackground(g);
        t.setPadding(dp(14), dp(8), dp(14), dp(8));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2);
        lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        lp.topMargin = dp(46);
        layer.addView(t, lp);
        ui.postDelayed(() -> { if (layer != null) layer.removeView(t); }, 2200);
    }

    // ── 结构化文本采集与词几何（D-402：每次手指按下现场重读）────
    private int collectSeq = 0;
    private volatile boolean collectReady = false;

    /** 手指按下那一刻发起（D-335 的「按需」就是这一刻）；后台线程收，主线程用 */
    private void startCollect() {
        final int seq = ++collectSeq;
        collectReady = false;
        new Thread(() -> {
            final List<Word> ws = new ArrayList<>();
            final List<String> ts = new ArrayList<>();
            String pkg = null;
            try {
                AccessibilityNodeInfo root = getRootInActiveWindow();
                if (root != null) {
                    pkg = root.getPackageName() != null ? root.getPackageName().toString() : null;
                    List<AccessibilityNodeInfo> nodes = new ArrayList<>();
                    collect(root, nodes);
                    for (int n = 0; n < nodes.size(); n++) extractWordsInto(nodes.get(n), n, ws, ts);
                }
            } catch (Exception e) {
                probe("collect err " + e);
            }
            final String fp = pkg;
            ui.post(() -> {
                if (seq != collectSeq) return; // 过期的收集，扔
                /**
                 * ★ 真机 2026-08-30（X → Reddit）：**换了宿主，旧选区必须作废。**
                 * 以前有活跃选区就干脆不重读（怕把词表从选区脚下换掉），可切了
                 * App 之后那份词表连同高亮全是上一个 App 的 —— 在 Reddit 长按，
                 * 屏幕上高亮着 Reddit 的字，卡片里还写着 X 那个词。
                 * 现在：同一个 App 且选区还在 → 保留旧表（原来的保护还在）；
                 * 换了 App → 清掉选区、换新表。
                 */
                boolean live = selView != null && selView.selA >= 0;
                if (live && fp != null && fp.equals(selPkg)) {
                    collectReady = true; // 同一个 App：词表不动，选区下标继续有效
                    return;
                }
                if (live) selView.clearSelection(); // 换了 App：旧选区与旧气泡一起收
                words.clear(); words.addAll(ws);
                nodeTexts.clear(); nodeTexts.addAll(ts);
                ocrNodeFrom = Integer.MAX_VALUE; // 旧屏的 OCR 行随词表一起走
                hostPkg = fp;
                collectReady = true;
                probe("collected " + ws.size() + " words pkg=" + fp);
            });
        }).start();
    }

    /**
     * 收可用的**文字叶子**。
     *
     * ★ 只收叶子（真机 2026-08-30 · 浏览器场景）：WebView 这个容器节点自己
     *   也带 text（整页标题），而它的 bounds 是**整个视口** —— 收了它，
     *   字符几何量出来的词框就摊在整页上，长按谁都选中同一个词，
     *   高亮糊满全屏。规则：后代里有文字，祖先就不收。
     * ★ isVisibleToUser 必查（真机 2026-08-30）：RecyclerView 回收的**离屏**
     *   节点还挂在树上，boundsInScreen 是陈坐标。
     *
     * @return 这棵子树里有没有收到东西
     */
    private boolean collect(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> out) {
        if (node == null) return false;
        CharSequence pkg = node.getPackageName();
        if (pkg != null && getPackageName().contentEquals(pkg)) return false;
        boolean childHit = false;
        for (int i = 0; i < node.getChildCount(); i++) {
            if (collect(node.getChild(i), out)) childHit = true;
        }
        if (childHit) return true;
        if (!node.isVisibleToUser()) return false;
        Rect b = new Rect();
        node.getBoundsInScreen(b);
        // T1 · 真文本（原生 TextView / Compose 语义 text）
        CharSequence t = node.getText();
        if (t != null && t.toString().trim().length() >= 2
                && b.width() > dp(20) && b.height() > dp(8)) {
            out.add(node);
            return true;
        }
        /**
         * T2 · contentDescription（2026-08-30 覆盖审计的主修）：
         * Compose/Litho 的信息流卡片把整卡文字合并进容器 cd，树上一个 text
         * 节点都没有（Reddit 信息流实测 0 个 —— 这就是「评论能选、标题不能选」）。
         * ★ 只收**大块非图片**节点（≥100×50dp 且不是 Image*）：
         *   图标按钮的 cd（Back/Search…）是给读屏的标签，不是屏上可见文字 ——
         *   收了它们，长按图标会选中一个屏幕上根本没有的词。
         */
        CharSequence cd = node.getContentDescription();
        if (cd != null && b.width() >= dp(100) && b.height() >= dp(50)) {
            CharSequence cls = node.getClassName();
            boolean img = cls != null && cls.toString().contains("Image");
            String trimmed = adapterTrim(node.getPackageName(), cd.toString());
            if (!img && trimmed.trim().length() >= 2) {
                out.add(node);
                return true;
            }
        }
        return false;
    }

    /** collect/extract 共用的取字口径：text 优先，cd 兜底（过 adapter 剪裁） */
    private String textOf(AccessibilityNodeInfo node) {
        CharSequence t = node.getText();
        if (t != null && t.toString().trim().length() >= 2) return t.toString();
        CharSequence cd = node.getContentDescription();
        if (cd == null) return "";
        return adapterTrim(node.getPackageName(), cd.toString());
    }

    /**
     * T2.5 · 每 App 的 cd 剪裁（指令第九则第五条明确授权 per-App adapter）。
     * cd 是「可见文字 + 读屏模板尾巴」——尾巴不在屏幕上，剪掉才不会让人
     * 选中看不见的词。规则全部来自真机 dump 原文，不猜：
     *   Reddit  「标题, From r/xx, Posted 1 day ago, 516…」→ 剪到 , From / , Promoted post / , Posted
     *   YouTube 「标题 - 30 minutes, 16 seconds - Go to channel …- play video」→ 剪到时长段 / Go to channel
     */
    private static String adapterTrim(CharSequence pkgCs, String s) {
        String pkg = pkgCs == null ? "" : pkgCs.toString();
        if (pkg.contains("reddit")) {
            int cut = earliest(s, ", From ", ", Promoted post", ", Posted ");
            return cut > 0 ? s.substring(0, cut) : s;
        }
        if (pkg.contains("youtube")) {
            int cut = earliest(s, " - Go to channel", " - play video");
            java.util.regex.Matcher m = java.util.regex.Pattern
                .compile(" - \\d+ (hour|minute|second)").matcher(s);
            if (m.find() && (cut < 0 || m.start() < cut)) cut = m.start();
            return cut > 0 ? s.substring(0, cut) : s;
        }
        return s;
    }

    /** 大卡片里「文字带」占卡高的哪一段（0..1）—— 逐 App 校准，量出来的不是猜的 */
    private static float[] adapterBand(CharSequence pkgCs) {
        String pkg = pkgCs == null ? "" : pkgCs.toString();
        if (pkg.contains("youtube")) return new float[]{0.56f, 0.86f}; // 缩略图之下 · 频道行之上
        if (pkg.contains("reddit")) return new float[]{0.08f, 0.58f};  // 用户行之下 · 票数行之上
        return null;
    }

    private static int earliest(String s, String... marks) {
        int best = -1;
        for (String m : marks) {
            int i = s.indexOf(m);
            if (i >= 0 && (best < 0 || i < best)) best = i;
        }
        return best;
    }

    private void extractWordsInto(AccessibilityNodeInfo node, int nodeIdx, List<Word> ws, List<String> ts) {
        String text = textOf(node);
        ts.add(text);
        Rect nb = new Rect();
        node.getBoundsInScreen(nb);
        CharSequence realText = node.getText();
        boolean isRealText = realText != null && realText.toString().equals(text);
        // cd 文本没有字符坐标可要（EXTRA_DATA 只属 text）—— 度量拟合；
        // ★ 大卡片（含缩略图）的文字只占一条带：把拟合框压进 adapter 给的带里，
        //   词框才落在真字上（YouTube 标题在图下方、Reddit 标题在卡上部）
        Rect fitBox = nb;
        if (!isRealText && nb.height() > dp(160)) {
            float[] band = adapterBand(node.getPackageName());
            if (band != null) {
                fitBox = new Rect(nb.left + dp(6), nb.top + (int) (nb.height() * band[0]),
                    nb.right - dp(6), nb.top + (int) (nb.height() * band[1]));
            }
        }
        RectF[] chars = isRealText ? charLocations(node, text.length(), nb) : null;
        // ★ 带内拟合要**顶对齐 + 固定近似字号**（阶段 7 · Reddit 纯文卡实测：
        //   按 wealthy 命中 that —— 把带高当文本满铺反推字号，带比真文本高时
        //   行高被拉大、词整体下漂一行）。信息流标题字号本就稳定（15~17sp），
        //   文本占不满带就该留白，不许拉伸凑底。
        boolean measured = chars == null; // 宿主没给字符坐标，下面这份是我们自己排的
        if (chars == null) chars = fitBox != nb ? measureTopAligned(text, fitBox) : measureFallback(text, fitBox);
        // ★ F-019 · 自己排的版一旦排出不止一行，起点就不可信（见 Word.loose）。
        //   真字符坐标不算 —— 那是宿主给的真值，多行也准。
        boolean loose = measured && spansLines(chars);
        int i = 0;
        while (i < text.length()) {
            while (i < text.length() && Character.isWhitespace(text.charAt(i))) i++;
            int j = i;
            while (j < text.length() && !Character.isWhitespace(text.charAt(j))) j++;
            if (j > i) {
                Rect box = union(chars, i, j);
                if (box != null) {
                    Word w = new Word(text.substring(i, j), box, nodeIdx, i, j);
                    w.approx = fitBox != nb; // 带内拟合的几何 —— 一行级近似
                    w.loose = loose;         // ★ F-019 · 自己量的、且量出了多行 —— 起点不可信
                    ws.add(w);
                }
            }
            i = j;
        }
    }

    /** 这份字符盒子排到了不止一行？（比较 top，容差半行）★ F-019 */
    private boolean spansLines(RectF[] chars) {
        float first = Float.NaN, h = 0;
        for (RectF c : chars) {
            if (c == null) continue;
            if (Float.isNaN(first)) { first = c.top; h = c.height(); continue; }
            if (Math.abs(c.top - first) > h * 0.5f) return true;
        }
        return false;
    }

    private Rect union(RectF[] chars, int a, int b) {
        RectF acc = null;
        for (int k = a; k < b && k < chars.length; k++) {
            RectF c = chars[k];
            if (c == null) continue;
            if (acc == null) acc = new RectF(c); else acc.union(c);
        }
        if (acc == null) return null;
        return new Rect((int) acc.left, (int) acc.top, (int) acc.right, (int) acc.bottom);
    }

    private RectF[] charLocations(AccessibilityNodeInfo node, int len, Rect nb) {
        try {
            if (!node.getAvailableExtraData()
                    .contains(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY)) {
                return null;
            }
            Bundle args = new Bundle();
            args.putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_START_INDEX, 0);
            args.putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_LENGTH, Math.min(len, 1000));
            if (!node.refreshWithExtraData(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY, args)) return null;
            android.os.Parcelable[] arr = node.getExtras()
                .getParcelableArray(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY);
            if (arr == null) return null;
            RectF[] out = new RectF[arr.length];
            int ok = 0;
            float sumW = 0;
            for (int i = 0; i < arr.length; i++) {
                out[i] = (RectF) arr[i];
                if (out[i] != null) { ok++; sumW += out[i].width(); }
            }
            if (ok == 0) return null;
            // ★ 假几何要认出来（真机 2026-08-30 · 浏览器）：有的宿主答应给字符
            //   坐标，回来的却是「每个字符 = 整个节点框」。那样每个词的框都一样大，
            //   长按谁都选中第一个词、高亮糊满整段。一个字符占不到节点宽的四成 ——
            //   超了就是假的，退回自己度量。
            if (len >= 8 && sumW / ok > nb.width() * 0.4f) return null;
            return out;
        } catch (Exception e) {
            Log.d(TAG, "charLoc err " + e);
            return null;
        }
    }

    /** 带内顶对齐拟合：固定近似字号（17dp ≈ 信息流标题），从带顶往下铺行，不拉伸凑底 */
    private RectF[] measureTopAligned(String text, Rect nb) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTextSize(dp(17));
        float lineH = dp(17) * 1.42f;
        RectF[] out = new RectF[text.length()];
        int line = 0;
        float x = 0;
        int i = 0;
        while (i < text.length()) {
            int j = i;
            while (j < text.length() && !Character.isWhitespace(text.charAt(j))) j++;
            if (j == i) j = i + 1;
            String w = text.substring(i, j);
            float wW = p.measureText(w);
            if (x > 0 && x + wW > nb.width()) { line++; x = 0; }
            float perCh = wW / Math.max(1, (j - i));
            for (int k = i; k < j; k++) {
                float cl = nb.left + x + perCh * (k - i);
                float ct = nb.top + line * lineH;
                out[k] = new RectF(cl, ct, cl + perCh, ct + lineH);
            }
            x += wW;
            if (j < text.length() && Character.isWhitespace(text.charAt(j))) x += p.measureText(" ");
            i = j + ((j < text.length() && Character.isWhitespace(text.charAt(j))) ? 1 : 0);
        }
        return out;
    }

    /**
     * 字符定位不可用时的度量兜底：用 Paint 做贪心断行拟合节点高度，
     * 二分字号让「行数 × 行高 ≈ 节点高」——比均分准一个量级（词柄手感的底线）。
     */
    private RectF[] measureFallback(String text, Rect nb) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        float lo = dp(10), hi = dp(28), best = dp(16);
        for (int it = 0; it < 12; it++) {
            float mid = (lo + hi) / 2f;
            p.setTextSize(mid);
            int lines = wrapLines(text, p, nb.width());
            float need = lines * mid * 1.32f;
            if (need > nb.height()) hi = mid; else { best = mid; lo = mid; }
        }
        p.setTextSize(best);
        float lineH = nb.height() / (float) Math.max(1, wrapLines(text, p, nb.width()));
        RectF[] out = new RectF[text.length()];
        int line = 0; float x = 0;
        int i = 0;
        while (i < text.length()) {
            int j = i;
            while (j < text.length() && !Character.isWhitespace(text.charAt(j))) j++;
            if (j == i) j = i + 1; // 空白算一个占位
            String w = text.substring(i, j);
            float wW = p.measureText(w);
            if (x > 0 && x + wW > nb.width()) { line++; x = 0; }
            float perCh = wW / Math.max(1, (j - i));
            for (int k = i; k < j; k++) {
                float cl = nb.left + x + perCh * (k - i);
                float ct = nb.top + line * lineH;
                out[k] = new RectF(cl, ct, cl + perCh, ct + lineH);
            }
            x += wW;
            if (j < text.length() && Character.isWhitespace(text.charAt(j))) x += p.measureText(" ");
            i = j + ((j < text.length() && Character.isWhitespace(text.charAt(j))) ? 1 : 0);
        }
        return out;
    }

    private int wrapLines(String text, Paint p, int width) {
        int lines = 1; float x = 0;
        int i = 0;
        while (i < text.length()) {
            int j = i;
            while (j < text.length() && !Character.isWhitespace(text.charAt(j))) j++;
            if (j == i) j = i + 1;
            float wW = p.measureText(text, i, j);
            if (x > 0 && x + wW > width) { lines++; x = 0; }
            x += wW + p.measureText(" ");
            i = j + 1;
        }
        return lines;
    }

    // ── 手势转发（D-402：模式里宿主照常能用）─────────────────────
    /** 合成手势也会打在自己层上 —— 转发前先让层「透」，回调里恢复 */
    private void setLayerTouchable(boolean t) {
        if (layer == null) return;
        WindowManager.LayoutParams lp = (WindowManager.LayoutParams) layer.getLayoutParams();
        if (t) lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        else lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        try { wm.updateViewLayout(layer, lp); } catch (Exception ignored) {}
    }

    private final Runnable restoreTouch = () -> setLayerTouchable(true);

    private void forwardGesture(List<float[]> trail, long durMs) {
        if (trail.isEmpty()) return;
        Path p = new Path();
        p.moveTo(trail.get(0)[0], trail.get(0)[1]);
        for (int i = 1; i < trail.size(); i++) p.lineTo(trail.get(i)[0], trail.get(i)[1]);
        long d = Math.max(40, Math.min(durMs, 900));
        try {
            GestureDescription.Builder b = new GestureDescription.Builder();
            b.addStroke(new GestureDescription.StrokeDescription(p, 0, d));
            setLayerTouchable(false);
            ui.removeCallbacks(restoreTouch);
            ui.postDelayed(restoreTouch, d + 500); // 回调失约的保险
            dispatchGesture(b.build(), new GestureResultCallback() {
                @Override public void onCompleted(GestureDescription g) { ui.post(restoreTouch); }
                @Override public void onCancelled(GestureDescription g) { ui.post(restoreTouch); }
            }, ui);
        } catch (Exception e) {
            Log.d(TAG, "forward err " + e);
            setLayerTouchable(true);
        }
    }

    // ── 选区视图（高亮 + 双端点柄，词粒度可拖；非选词手势转发）────
    private class SelectionView extends View {
        int selA = -1, selB = -1;          // words 下标（同 node）
        private int dragging = 0;          // 0=无 1=起柄 2=止柄
        private boolean longPressed = false;
        private boolean moved = false;
        private boolean hadSelAtDown = false;
        private float downX, downY;
        private long downT = 0;
        private final List<float[]> trail = new ArrayList<>();
        boolean fingerDown = false;
        boolean ocrTried = false;
        boolean ocrPending = false;
        /** 近似命中的词（OCR 精化落空时的兜底）——每次按下清 -1 */
        int approxIdx = -1;
        List<float[]> pendingTrail = null;
        long pendingDur = 0;

        // 滚动转发 = 抬手重放（实测边界见 ACTION_UP 尾注 —— 实时跟手在此平台不可达）

        private final Runnable longPress = new Runnable() {
            @Override public void run() {
                if (moved) return;
                if (!collectReady) {
                    // 收集还在路上（按下才发起）—— 稍等再试，最多等到 ~1s
                    if (System.currentTimeMillis() - downT < 1000) { postDelayed(this, 120); return; }
                    probe("collect timeout");
                    return;
                }
                int idx = hitWord(downX, downY);
                // ★ 阶段 7 · cd 大卡对位精化：带内拟合的词框是一行级近似
                //  （cd 没有字符坐标可要），而 OCR 词框是像素级（D-406⑪ 实测
                //   「比 cd 拟合还贴字」）。按在近似词上就顺手截一帧精化 ——
                //   同一条「每按至多一次、识别即弃」的边界；OCR 落空退回近似命中。
                if (idx >= 0 && words.get(idx).approx && !ocrTried) {
                    ocrTried = true;
                    ocrPending = true;
                    approxIdx = idx;
                    probe("ocr refine '" + words.get(idx).text + "'");
                    startOcr((int) downX, (int) downY);
                    return;
                }
                if (idx < 0) {
                    StringBuilder sb = new StringBuilder("miss @" + (int) downX + "," + (int) downY
                        + " words=" + words.size() + " pkg=" + hostPkg);
                    for (int k = 0; k < Math.min(6, words.size()); k++) {
                        Word w = words.get(k);
                        sb.append(" | ").append(w.text).append(w.box.toShortString());
                    }
                    probe(sb.toString());
                    // D-406 T3 · 结构化层在按点上没词 —— 这一刻才轮到 OCR（每按最多一次）
                    if (!ocrTried) {
                        ocrTried = true;
                        ocrPending = true;
                        startOcr((int) downX, (int) downY);
                    }
                }
                if (idx >= 0) {
                    longPressed = true;
                    selA = idx; selB = idx;
                    dismissBubble();
                    performHaptic();
                    invalidate();
                }
                // 没点到词：什么都不做 —— 抬手时整个手势原样转给宿主（宿主自己的长按）
            }
        };
        private final Paint hl = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint handle = new Paint(Paint.ANTI_ALIAS_FLAG);

        SelectionView(android.content.Context c) {
            super(c);
            hl.setColor(tok(NyxAssistService.this, R.color.nyx_sel));
            handle.setColor(tok(NyxAssistService.this, R.color.nyx_violet));
        }

        void performHaptic() { performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS); }

        @Override public boolean onTouchEvent(MotionEvent e) {
            float x = e.getRawX(), y = e.getRawY();
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = x; downY = y; downT = System.currentTimeMillis();
                    longPressed = false; moved = false;
                    hadSelAtDown = selA >= 0;
                    fingerDown = true; ocrTried = false; ocrPending = false; pendingTrail = null;
                    approxIdx = -1;
                    trail.clear();
                    trail.add(new float[]{x, y});
                    // D-402/D-335：按下那一刻现场重读当前窗口（只在这一刻，不常驻）。
                    // 有活跃选区时读回来只用来**认宿主**：同一个 App 就把新表丢掉
                    // （旧下标继续有效），换了 App 就连选区一起换 —— 见 startCollect。
                    startCollect();
                    if (selA >= 0) {
                        dragging = hitHandle(x, y);
                        if (dragging != 0) return true;
                    }
                    postDelayed(longPress, 380);
                    return true;
                case MotionEvent.ACTION_MOVE:
                    trail.add(new float[]{x, y});
                    if (dragging != 0) {
                        int idx = nearestWord(x, y);
                        if (idx >= 0) {
                            if (dragging == 1) selA = idx; else selB = idx;
                            invalidate();
                        }
                        return true;
                    }
                    if (longPressed) {
                        int idx = nearestWord(x, y);
                        if (idx >= 0) { selB = idx; invalidate(); }
                        return true;
                    }
                    if (!moved && (Math.abs(x - downX) > dp(10) || Math.abs(y - downY) > dp(10))) {
                        moved = true;
                        removeCallbacks(longPress);
                        // 滚动意图：旧选区随内容失位，先清掉（模式不动）
                        if (selA >= 0) clearSelection();
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    fingerDown = false;
                    removeCallbacks(longPress);
                    if (dragging != 0) { dragging = 0; onSelectionSettled(); return true; }
                    if (longPressed) { longPressed = false; onSelectionSettled(); return true; }
                    if (ocrPending && !moved) {
                        // OCR 还在路上（按点上结构化层没词才发起的）—— 手势先攥着：
                        // 识别命中 = 这是一次选词，不转发；识别落空 = 再补转发，
                        // 宿主只是晚 ~半秒收到自己的长按
                        pendingTrail = new ArrayList<>(trail);
                        pendingDur = System.currentTimeMillis() - downT;
                        return true;
                    }
                    if (hadSelAtDown && !moved) {
                        // 有选区时的单击：点在选中的词上 = 扩成整句（D-402 手感批）；
                        // 点在别处 = 清这次选区（原生选择的习惯）。都不转发。
                        if (hitSelection(x, y)) expandToSentence();
                        else clearSelection();
                        return true;
                    }
                    // 没形成选择：这是宿主的手势（点按/滚动/宿主长按）—— 原样转发（D-402）。
                    // ★ 阶段 7 实测边界（流式两版 + 放行两版原型全被证伪后定案）：
                    //   DOWN 一落在本层，这根手指的**余程就拿不回来** ——
                    //   dispatchGesture 注入会让系统 CANCEL 真手指流且不重路由；
                    //   摘窗（removeViewImmediate）同样不重路由（指针就地死掉，
                    //   y 值探针证：整次 1.4s 拖动宿主收到 0 像素）。
                    //   「实时跟手」在此平台不可达 —— 抬手重放是诚实的上限，
                    //   fling 由重放段的真实时长近似（D-402 真机验收过的手感）。
                    forwardGesture(new ArrayList<>(trail), System.currentTimeMillis() - downT);
                    return true;
            }
            return false;
        }

        void clearSelection() { selA = -1; selB = -1; dismissBubble(); invalidate(); }

        /** 点点落在当前选区的哪个词框里吗（扩整句的触发判定） */
        private boolean hitSelection(float x, float y) {
            if (selA < 0) return false;
            for (int i : selectedWords()) {          // ★ 与取词、高亮同一批
                Word w = words.get(i);
                if (w.box.contains((int) x, (int) y)) return true;
            }
            return false;
        }

        /** 选区 → 它所在的整句（句界与保存语境同一把尺）；已是整句再点 = 清 */
        private void expandToSentence() {
            if (selA < 0) return;
            int a = Math.min(selA, selB), b = Math.max(selA, selB);
            int node = words.get(a).node;
            // ★ 选区已经跨了节点 —— 句界偏移是**节点内**的，算不准；
            //   而且他手动拖出来的范围比我们猜的整句更可信，原样留着。
            if (words.get(b).node != node) return;
            int[] r = sentenceRange(nodeTexts.get(node), words.get(a).charStart, words.get(b).charEnd);
            int first = -1, last = -1;
            for (int i = 0; i < words.size(); i++) {
                Word w = words.get(i);
                if (w.node != node) continue;
                if (w.charStart >= r[0] && w.charEnd <= r[1]) {
                    if (first < 0) first = i;
                    last = i;
                }
            }
            if (first < 0) return;
            if (first == a && last == b) {
                clearSelection(); // 已经是整句 —— 再点一下 = 收掉
                return;
            }
            selA = first;
            selB = last;
            performHaptic();
            invalidate();
            onSelectionSettled();
        }

        /**
         * ★★ F-019（2026-09-01）：**命中要先看几何可不可信，再看谁排在前面。**
         *
         * 原来这里是「第一个框住这一点的就是它」（`return i`）。词表按节点顺序排，
         * 于是段落里那段行内文字（几何是我们自己量的、而且量歪了）排在
         * 独立词节点前面，就把真正的那个词**盖住**了 ——
         * 真机上按 stairwell 的正中心，卡片显示的是 "move"。
         *
         * 现在分两轮：先找几何可信的（loose=false），没有再退而求其次。
         * ★ 两轮都是「框住这一点」，不是就近 —— 距离兜底那一档原样不动。
         */
        private int hitWord(float x, float y) {
            int loose = -1, near = -1; int bd = Integer.MAX_VALUE;
            for (int i = 0; i < words.size(); i++) {
                Word w = words.get(i);
                Rect b = w.box;
                if (b.contains((int) x, (int) y)) {
                    if (!w.loose) return i;        // 几何可信 —— 就是它
                    if (loose < 0) loose = i;      // 先记着，等没有可信的再用
                } else {
                    int dxx = Math.max(0, Math.max(b.left - (int) x, (int) x - b.right));
                    int dyy = Math.max(0, Math.max(b.top - (int) y, (int) y - b.bottom));
                    int d = dxx + dyy;
                    if (d < dp(14) && d < bd) { bd = d; near = i; }
                }
            }
            return loose >= 0 ? loose : near;
        }

        /**
         * ★★ 2026-09-03 · 这里原来带一个 `node` 形参，只在**起点所在的那个节点**里
         *   找最近的词 —— 于是「选一整句」在跨节点时**拖不出去**：
         *   高亮到节点边界就停，卡片上只剩其中一小段，而屏幕上看着像选中了。
         *
         *   一句话被拆到两个无障碍节点里是常事（网页里的行内 span、聊天气泡、
         *   OCR 出来的逐行块）。使用者要的是「我选中什么就查什么」，
         *   所以终点不再受起点的节点约束。
         *
         *   ★ `words` 是按无障碍树的遍历顺序排的 —— 那通常就是阅读顺序，
         *     所以 `a..b` 这个区间取出来仍然是连着读的一段。
         */
        private int nearestWord(float x, float y) {
            int best = -1; long bd = Long.MAX_VALUE;
            for (int i = 0; i < words.size(); i++) {
                Rect b = words.get(i).box;
                long cx = Math.max(0, Math.max(b.left - (int) x, (int) x - b.right));
                long cy = Math.max(0, Math.max(b.top - (int) y, (int) y - b.bottom));
                long d = cx * cx + cy * cy;
                if (d < bd) { bd = d; best = i; }
            }
            return best;
        }

        private int hitHandle(float x, float y) {
            if (selA < 0) return 0;
            List<Integer> picked = selectedWords();
            if (picked.isEmpty()) return 0;
            // ★ 柄挂在**阅读顺序**的头尾（跨节点时下标头尾不是屏幕上的头尾）
            Rect ra = words.get(picked.get(0)).box, rb = words.get(picked.get(picked.size() - 1)).box;
            // 柄挂在基线**下方**（原生同款）—— 框内的点是「点词」（扩整句），
            // 不算抓柄；否则短词的框整个被柄的命中圈罩住（真机 2026-08-30 撞过）
            if (y >= ra.bottom - dp(6) && dist(x, y, ra.left, ra.bottom) < dp(26)) return 1;
            if (y >= rb.bottom - dp(6) && dist(x, y, rb.right, rb.bottom) < dp(26)) return 2;
            return 0;
        }

        private float dist(float x, float y, int px, int py) {
            return (float) Math.hypot(x - px, y - py);
        }

        @Override protected void onDraw(Canvas c) {
            if (selA < 0) return;
            c.save();
            c.translate(-winX, -winY);
            // 高亮：按行合并成条（原生观感）
            // ★ 2026-09-03 · 与取词走同一份 selectedWords()（阅读顺序、跨节点）——
            //   画的和取的必须是同一批词，否则屏幕说的和卡片说的是两回事。
            RectF line = null;
            for (int i : selectedWords()) {
                Word w = words.get(i);
                RectF r = new RectF(w.box);
                if (line != null && Math.abs(r.top - line.top) < r.height() * 0.5f) {
                    line.union(r);
                } else {
                    if (line != null) c.drawRoundRect(line, dp(3), dp(3), hl);
                    line = r;
                }
            }
            if (line != null) c.drawRoundRect(line, dp(3), dp(3), hl);
            // 端点柄：原生样式的泪滴（起柄朝左，止柄朝右）
            // ★ 挂在**阅读顺序**的头尾 —— 跨节点时列表下标的头尾不是屏幕上的头尾
            List<Integer> ends = selectedWords();
            if (ends.isEmpty()) { c.restore(); return; }
            Rect ra = words.get(ends.get(0)).box, rb = words.get(ends.get(ends.size() - 1)).box;
            drawHandle(c, ra.left, ra.bottom, true);
            drawHandle(c, rb.right, rb.bottom, false);
            c.restore();
        }

        private void drawHandle(Canvas c, int x, int y, boolean start) {
            float r = dp(9);
            Path p = new Path();
            if (start) {
                p.moveTo(x, y);
                p.lineTo(x - r, y);
                p.arcTo(new RectF(x - 2 * r, y, x, y + 2 * r), 270, -270);
            } else {
                p.moveTo(x, y);
                p.lineTo(x + r, y);
                p.arcTo(new RectF(x, y, x + 2 * r, y + 2 * r), 270, 270);
            }
            p.close();
            c.drawPath(p, handle);
        }
    }

    // ── 选区落定 → In-place 气泡 ────────────────────────────────
    /**
     * ★★ 选区**按阅读顺序**取词，不按 `words` 的列表下标（2026-09-03 真机修）
     *
     * ── 病 ────────────────────────────────────────────────────
     *
     * 让选区跨节点之后，取词还是 `for (i = min(selA,selB); i <= max; i++)` ——
     * 而 `words` 的顺序是**无障碍树的遍历顺序**（OCR 那条路更是按识别块给的），
     * 跨节点时它**不等于阅读顺序**。真机上一拖，卡片标题成了「say. I」：
     * 上一段结尾的 say. 和下一段开头的 I 在列表里正好挨着，中间什么都没有。
     * 比截断更糟 —— 它拼出了一段屏幕上根本不存在的话。
     *
     * ── 药 ────────────────────────────────────────────────────
     *
     * 按几何排：先按行（纵向中心，容差取行高的一半），同一行再按左边界。
     * 这就是人眼读的顺序，也是他手指扫过的顺序。
     * 单节点的情况下结果和以前**逐字一样**（同一段文字本来就按阅读顺序排）。
     */
    private int[] readingOrder() {
        Integer[] idx = new Integer[words.size()];
        for (int i = 0; i < idx.length; i++) idx[i] = i;
        java.util.Arrays.sort(idx, (p, q) -> {
            Rect a = words.get(p).box, b2 = words.get(q).box;
            int ay = a.centerY(), by = b2.centerY();
            int tol = Math.max(1, Math.max(a.height(), b2.height()) / 2);
            if (Math.abs(ay - by) > tol) return Integer.compare(ay, by);
            return Integer.compare(a.left, b2.left);
        });
        int[] out = new int[idx.length];
        for (int i = 0; i < idx.length; i++) out[i] = idx[i];
        return out;
    }

    /** 当前选区覆盖的那些词 —— **已按阅读顺序排好**，空表示没有选区 */
    private List<Integer> selectedWords() {
        List<Integer> out = new ArrayList<>();
        if (selView == null || selView.selA < 0 || selView.selB < 0) return out;
        if (selView.selA >= words.size() || selView.selB >= words.size()) return out;
        int[] ord = readingOrder();
        int pa = -1, pb = -1;
        for (int i = 0; i < ord.length; i++) {
            if (ord[i] == selView.selA) pa = i;
            if (ord[i] == selView.selB) pb = i;
        }
        if (pa < 0 || pb < 0) return out;
        for (int i = Math.min(pa, pb); i <= Math.max(pa, pb); i++) out.add(ord[i]);
        return out;
    }

    private void onSelectionSettled() {
        if (selView == null || selView.selA < 0) return;
        List<Integer> picked = selectedWords();
        if (picked.isEmpty()) return;
        int node = words.get(picked.get(0)).node;
        selFromOcr = node >= ocrNodeFrom; // 卡片要如实标「可能有误」（D-395）
        StringBuilder sb = new StringBuilder();
        Rect first = null, last = null;
        int cs = Integer.MAX_VALUE, ce = -1;
        int words0 = 0;
        boolean crossNode = false;
        for (int i : picked) {
            Word w = words.get(i);
            // ★★ 2026-09-03 · 这里原来是 `if (w.node != node) continue;` ——
            //   跨节点的那半句被**悄悄丢掉**，卡片上只剩一小段。
            //   现在全都要：使用者选中什么，就是什么。
            //   顺序由 selectedWords() 按阅读顺序给，不再用列表下标（见它的说明）。
            if (w.node != node) crossNode = true;
            if (sb.length() > 0) sb.append(' ');
            sb.append(w.text);
            words0++;
            if (w.node == node) {
                cs = Math.min(cs, w.charStart);
                ce = Math.max(ce, w.charEnd);
            }
            if (first == null) first = w.box;
            last = w.box;
        }
        /**
         * ★ 首尾标点只对**单个词**剥（真机撞过「account.」查不到）。
         *   一个词组 / 一整句的句末标点是它自己的一部分 ——
         *   剥掉就等于替他改了选中的内容，而这次要修的正是这件事。
         *   查库与查词典那一侧本来就会归一（引擎里的 normalizeTerm，
         *   L0 状态与收下走的是同一把尺），不需要在这里先动他的原文。
         */
        String raw = sb.toString().trim();
        String selected = words0 <= 1 ? trimEdges(raw) : raw;
        if (selected.isEmpty()) return;
        selPkg = hostPkg;
        /**
         * ★ 上下文句子：只有整个选区都落在同一个节点里才算得准
         *   （`charStart/charEnd` 是**节点内**的偏移，跨节点混着用会取错范围）。
         *   跨了节点就不给上下文 —— 选中的那一整段本身就是上下文。
         */
        String sentence = crossNode ? null : sentenceAround(nodeTexts.get(node), cs, ce);
        showBubble(selected, sentence, first, last);
    }

    /** 词面首尾的标点/括号/引号剥掉 —— 中间的连字符、撇号（don't · well-known）留着 */
    private static String trimEdges(String s) {
        String t = s.trim();
        int a = 0, b = t.length();
        String edge = ".,;:!?\"'’”“「」（）()[]{}…—–-·、。！？：；";
        while (a < b && edge.indexOf(t.charAt(a)) >= 0) a++;
        while (b > a && edge.indexOf(t.charAt(b - 1)) >= 0) b--;
        String out = t.substring(a, b).trim();
        return out.isEmpty() ? t : out; // 整串都是标点 —— 原样给，不吞
    }

    /** 句界扫描的**范围**版：[start, end) —— 选区扩整句（D-402 手感批）也用同一把尺 */
    private int[] sentenceRange(String text, int cs, int ce) {
        String stops = ".!?…。！？\n";
        int s = 0;
        for (int i = Math.min(cs, text.length()) - 1; i >= 0; i--) {
            if (stops.indexOf(text.charAt(i)) >= 0) { s = i + 1; break; }
        }
        int e = text.length();
        for (int i = Math.min(ce, text.length()); i < text.length(); i++) {
            if (stops.indexOf(text.charAt(i)) >= 0) { e = Math.min(i + 1, text.length()); break; }
        }
        return new int[]{s, e};
    }

    /** D-399③ · 句界扫描：[.!?…。！？\n] 为界；找不到 → 整节点原文（真实可确定，不猜） */
    private String sentenceAround(String text, int cs, int ce) {
        if (text == null || text.isEmpty()) return null;
        int[] r = sentenceRange(text, cs, ce);
        String out = text.substring(r[0], r[1]).trim();
        return out.isEmpty() ? text.trim() : out;
    }

    private void dismissBubble() {
        if (bubble != null && layer != null) { layer.removeView(bubble); bubble = null; }
        bubbleDef = null;
        saveWaiting = false;
        ui.removeCallbacks(dotTick);
        // 引擎那边的答复靠 bubbleTerm 配对 —— 这里清空即失效（陈旧答复自动丢）
        bubbleTerm = null;
        bubbleSentence = null;
        bubbleLp = null;
        tvQuick = null;
        quickText = null; quickErr = null; quickWaiting = false;
        secFull = null; secDict = null;
        noteFull = null; noteDict = null;
        errFull = null; errDict = null;
        fullWaiting = false; dictWaiting = false; dictMiss = false;
        dictBook = null; dictHtml = null; dictCss = null;
        dictTerm = null; pendingDictAnchor = null;
        openTab = null;
        tabAi = null; tabDict = null;
        lkBox = null; lkScroll = null; lkContent = null;
        if (dictWeb != null) { try { dictWeb.destroy(); } catch (Exception ignored) {} dictWeb = null; }
    }

    /**
     * 内容展开后卡片可能伸出屏底（词典区/长回执）—— 量完真实高度往上收。
     * ★ 真机 2026-08-30：只在 post 里收一次**不够** —— 那一刻 getHeight()
     *   还是展开**前**的旧值，于是按旧高度算出的位置仍然出屏（词典一展开，
     *   底下的 Save 那行整个被推到屏幕外）。改成盯着布局变化收。
     */
    private void clampBubble() {
        if (bubble == null || bubbleLp == null) return;
        int h = bubble.getHeight();
        if (h <= 0) return;
        int screenH = screenBottom();
        int maxTop = screenH - winY - h - dp(16);
        if (bubbleLp.topMargin > maxTop) {
            bubbleLp.topMargin = Math.max(dp(16) - winY, maxTop);
            bubble.setLayoutParams(bubbleLp);
        }
    }

    private void showBubble(final String term, final String sentence, Rect firstBox, Rect lastBox) {
        dismissBubble();
        if (layer == null) return;
        final LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(tok(NyxAssistService.this, R.color.nyx_card));
        bg.setCornerRadius(dp(12));
        card.setBackground(bg);
        card.setElevation(dp(5));
        card.setPadding(dp(14), dp(10), dp(14), dp(8));

        LinearLayout termRow = new LinearLayout(this);
        termRow.setOrientation(LinearLayout.HORIZONTAL);
        termRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView tvTerm = new TextView(this);
        tvTerm.setText(term);
        tvTerm.setTextColor(tok(NyxAssistService.this, R.color.nyx_ink));
        /**
         * ★★ 2026-09-03 · 长选区要**看得见全貌**。
         *
         * 这里原来死死钉着 `setTextSize(16)` + `setMaxLines(2)`。选中一整句时
         * 卡片顶上只露前两行、后面被吃掉 —— 使用者看到的就是
         * 「我选了一整句，它只显示其中一小段」。取到的文本其实是全的，
         * **是这一行把它裁掉的**，而裁在显示层比裁在数据层更骗人：
         * 屏幕说少了，人就以为查的也是少的那份。
         *
         * 所以：一个词照旧 16sp 两行（那是卡片的招牌），
         * 选得长就把字号收小、行数放开，宁可占几行也不许省略号吃掉内容。
         */
        // 词数只用来定版式。选区是用单个空格拼起来的（onSelectionSettled），
        // 所以按空格切就够 —— 不写 \s 这类转义，省得在这一层再踩一次反斜杠。
        int termWords = 0;
        for (String piece : term.trim().split(" ")) if (!piece.isEmpty()) termWords++;
        tvTerm.setTextSize(termWords <= 1 ? 16 : (termWords <= 8 ? 14.5f : 13.5f));
        tvTerm.setTypeface(Typeface.create("serif", Typeface.BOLD));
        tvTerm.setMaxLines(termWords <= 1 ? 2 : (termWords <= 8 ? 4 : 8));
        tvTerm.setEllipsize(android.text.TextUtils.TruncateAt.END);
        termRow.addView(tvTerm, new LinearLayout.LayoutParams(0, -2, 1f));
        // 发音（指令第九则 · 十～十三）：小而精致 —— 视觉 13dp 的自绘喇叭
        //（Sprite.svelte nyx-speak 同轮廓），点击区 40dp；点了就读，不开新面
        SpeakerView spk = new SpeakerView(this);
        termRow.addView(spk, new LinearLayout.LayoutParams(dp(40), dp(40)));
        spk.setOnClickListener(v -> pronounce(term, spk, false));
        // 指令十一的「轻量选择方式」：长按喇叭 = 另一种口音（英↔美），不加任何 UI
        spk.setOnLongClickListener(v -> { pronounce(term, spk, true); return true; });
        card.addView(termRow);

        final TextView tvStat = new TextView(this);
        tvStat.setText(selFromOcr ? "OCR·可能有误 · NYX · …" : "NYX · …");
        tvStat.setTextColor(tok(NyxAssistService.this, R.color.nyx_mute));
        tvStat.setTextSize(10.5f);
        tvStat.setPadding(0, dp(2), 0, 0);
        card.addView(tvStat);

        // ══ D-404 · 卡片定版 ═══════════════════════════════════
        //   词
        //   简明释义（Quick AI —— 选区落定就自动开始，不用点任何东西）
        //   [AI] [Dictionary]   ← 点了才在下面展开；再点收起
        //   Save
        bubbleTerm = term;
        bubbleSentence = sentence;

        tvQuick = new TextView(this);
        tvQuick.setTextColor(tok(NyxAssistService.this, R.color.nyx_ink));
        tvQuick.setTextSize(13.5f);
        tvQuick.setLineSpacing(dp(3), 1f);
        tvQuick.setPadding(0, dp(4), 0, 0);
        card.addView(tvQuick);

        // 展开区：AI 完整解释走我们自己的分节排版；Dictionary 走词典自己的 HTML
        lkBox = new FrameLayout(this);
        lkScroll = new ScrollView(this);
        lkContent = new LinearLayout(this);
        lkContent.setOrientation(LinearLayout.VERTICAL);
        lkScroll.addView(lkContent, new FrameLayout.LayoutParams(-1, -2));
        lkBox.addView(lkScroll, new FrameLayout.LayoutParams(-1, -1));
        lkBox.setVisibility(View.GONE);
        card.addView(lkBox, new LinearLayout.LayoutParams(-1, dp(1)));

        LinearLayout tabs = new LinearLayout(this);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        tabs.setPadding(0, dp(8), 0, dp(2));
        // ★ D-404⑥ · 完整 AI 解释只有主动点这里才生成（成功缓存不重调；失败再点=重试）
        tabAi = tabBtn("AI", () -> {
            if ("ai".equals(openTab)) { openTab = null; styleTabs(); renderTab(); return; }
            openTab = "ai";
            styleTabs();
            if (secFull == null && !fullWaiting) requestLookup("full");
            else renderTab();
        });
        // ★ D-404⑤ · 词典也改成点了才查
        tabDict = tabBtn("Dictionary", () -> {
            if ("dict".equals(openTab)) { openTab = null; styleTabs(); renderTab(); return; }
            openTab = "dict";
            styleTabs();
            if (secDict == null && !dictWaiting) requestLookup("dict");
            else renderTab();
        });
        tabs.addView(tabAi);
        tabs.addView(tabDict);
        tabs.addView(gap());
        tabs.addView(tabBtn("✕", () -> { if (selView != null) selView.clearSelection(); }));
        card.addView(tabs);
        styleTabs();

        final TextView tvDef = new TextView(this);
        tvDef.setTextColor(tok(NyxAssistService.this, R.color.nyx_ink_2));
        tvDef.setTextSize(12.5f);
        tvDef.setPadding(0, dp(5), 0, 0);
        tvDef.setMaxLines(4);
        tvDef.setVisibility(View.GONE);
        card.addView(tvDef);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(6), 0, 0);
        row.addView(btn("Save", () -> startSave(term, sentence, tvDef)));
        row.addView(gap());
        // 唯一一个「主动进 Nyx」的出口（D-404①：除此之外谁都不许拉起界面）
        row.addView(dimBtn("打开 Nyx ↗", () -> {
            SharePlugin.pendingText = term;
            SharePlugin.pendingQuote = sentence;
            SharePlugin.pendingPkg = hostPkg;
            SharePlugin.pendingMode = "open";
            Intent i = new Intent(NyxAssistService.this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
            exitMode();
        }));
        card.addView(row);

        // 首现定位：选区末行正下方；下方不足 → 首行上方；水平贴近选区并夹在屏内
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = screenBottom();
        int bw = Math.min(dp(300), screenW - dp(24));
        card.measure(View.MeasureSpec.makeMeasureSpec(bw, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        int bh = card.getMeasuredHeight();
        int x = Math.max(dp(12), Math.min(firstBox.left, screenW - bw - dp(12)));
        int y = lastBox.bottom + dp(10);
        if (y + bh > screenH - dp(24)) y = firstBox.top - bh - dp(10);
        if (y < dp(24)) y = dp(24);

        final FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(bw, -2);
        blp.leftMargin = x - winX;
        blp.topMargin = y - winY;
        // 之后可拖（拖动手柄=整卡空白区）
        card.setOnTouchListener(new View.OnTouchListener() {
            float dx, dy; int sx, sy; boolean moved;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        probe("card-down");
                        dx = e.getRawX(); dy = e.getRawY(); sx = blp.leftMargin; sy = blp.topMargin; moved = false; return true;
                    case MotionEvent.ACTION_MOVE:
                        if (Math.abs(e.getRawX() - dx) > 10 || Math.abs(e.getRawY() - dy) > 10) moved = true;
                        blp.leftMargin = sx + (int) (e.getRawX() - dx);
                        blp.topMargin = sy + (int) (e.getRawY() - dy);
                        card.setLayoutParams(blp); return true;
                    case MotionEvent.ACTION_UP:
                        return moved;
                }
                return false;
            }
        });
        // 高度一变就重收（展开词典/AI、回执上屏都会变高）
        card.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, orr, ob) -> {
            if (b - t != ob - ot) clampBubble();
        });
        bubble = card;
        bubbleLp = blp;
        layer.addView(card, blp);

        // L0 状态行：**判据在引擎**（`capture.ts::assistStatus` 一份 —— T-6.1 / R-004）。
        // ★ 这里原来是原生自己一句 SELECT，说是「同源移植」，实际已经漂了：
        //   少了 `il.deleted_at is null`。V36 起「从这一讲移出去」是软删、行还在，
        //   于是移出之后气泡照样报着**那一讲**的名字。同一件事两把尺子，
        //   改一边不报错 —— 所以这一份收回引擎，原生只做采集与渲染。
        // ★ 回调已经在主线程（AssistEngine.Host.result 是 ui.post 回来的），
        //   不必再起线程；引擎没热也不用等 —— call() 自己会排队。
        if (engine == null) {
            tvStat.setText((selFromOcr ? "OCR·可能有误 · " : "") + "NYX · 引擎没起来 —— 状态查不了");
        } else {
            JSONObject sa = new JSONObject();
            try { sa.put("term", term); } catch (Exception ignored) {}
            engine.call("status", sa, (ok, json) -> {
                if (bubble != card) return; // 气泡换过了 —— 陈旧答复直接丢
                tvStat.setText((selFromOcr ? "OCR·可能有误 · " : "") + statusLine(ok, json));
            });
        }

        // ★ D-403① + D-404②③ · 选区落定 = 查词开始，而且默认那条路只有 AI：
        //   卡片带着「正在理解…」出现，简明释义自动填进来。
        requestLookup("quick");
    }

    private TextView tabBtn(String label, Runnable onTap) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextSize(11.5f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setLetterSpacing(0.06f);
        t.setPadding(0, dp(2), dp(18), dp(2));
        t.setOnClickListener(v -> onTap.run());
        return t;
    }

    private void styleTabs() {
        if (tabDict == null || tabAi == null) return;
        boolean ai = "ai".equals(openTab), dt = "dict".equals(openTab);
        tabAi.setTextColor(tok(NyxAssistService.this, ai ? R.color.nyx_violet_2 : R.color.nyx_mute));
        tabDict.setTextColor(tok(NyxAssistService.this, dt ? R.color.nyx_violet_2 : R.color.nyx_mute));
        tabAi.setAlpha(ai ? 1f : 0.62f);
        tabDict.setAlpha(dt ? 1f : 0.62f);
    }

    /**
     * 卡片第一行的简明释义（D-404③④）。
     * 等待时是「正在理解 · ·」这样的轻占位 —— 不是空卡片，也不是新页面。
     */
    private void renderQuick() {
        if (tvQuick == null) return;
        if (quickText != null && !quickText.isEmpty()) {
            tvQuick.setTextColor(tok(NyxAssistService.this, R.color.nyx_ink));
            tvQuick.setText(quickText);
        } else if (quickWaiting) {
            tvQuick.setTextColor(tok(NyxAssistService.this, R.color.nyx_mute));
            tvQuick.setText("正在理解 " + dots());
        } else if (quickErr != null) {
            tvQuick.setTextColor(tok(NyxAssistService.this, R.color.nyx_mute));
            tvQuick.setText(quickErr);
        } else {
            tvQuick.setText("");
        }
        if (bubble != null) bubble.post(this::clampBubble);
    }

    /**
     * 展开区（D-404⑤⑥）：
     *   ai   —— 我们自己的分节排版（模型管内容、UI 管呈现，D-401⑦）
     *   dict —— **词典自己的** HTML 原样渲染（不重新包装成 AI 卡片的样子）
     *   null —— 收起
     */
    private void renderTab() {
        if (lkBox == null || lkContent == null || lkScroll == null) return;
        if (openTab == null) {
            lkBox.setVisibility(View.GONE);
            setBoxHeight(dp(1));
            if (bubble != null) bubble.post(this::clampBubble);
            return;
        }
        lkBox.setVisibility(View.VISIBLE);
        boolean useWeb = "dict".equals(openTab) && dictHtml != null && !dictHtml.isEmpty();
        if (useWeb) {
            showDictWeb();
            setBoxHeight(dp(240));
            if (bubble != null) bubble.post(this::clampBubble);
            return;
        }
        if (dictWeb != null) dictWeb.setVisibility(View.GONE);
        lkScroll.setVisibility(View.VISIBLE);
        lkContent.removeAllViews();
        if ("ai".equals(openTab)) {
            if (errFull != null) addNote("⚠ " + errFull);
            else if (fullWaiting) addNote("AI 生成中 " + dots());
            else if (secFull != null) {
                addSections(secFull);
                if (noteFull != null) addNote(noteFull);
            } else addNote("点 AI 生成完整解释");
        } else {
            if (errDict != null) addNote("⚠ " + errDict);
            else if (dictWaiting) addNote("查本地词典 " + dots());
            else if (secDict != null) {
                addSections(secDict);
                if (noteDict != null) addNote(noteDict);
            } else addNote("…");
        }
        // 内容最高 210dp，超出滚动 —— 气泡不吞屏
        int w = lkScroll.getWidth() > 0 ? lkScroll.getWidth() : dp(272);
        lkContent.measure(
            View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        setBoxHeight(Math.min(dp(210), Math.max(dp(22), lkContent.getMeasuredHeight())));
        if (bubble != null) bubble.post(this::clampBubble);
    }

    private void setBoxHeight(int h) {
        if (lkBox == null) return;
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) lkBox.getLayoutParams();
        lp.height = h;
        lkBox.setLayoutParams(lp);
    }

    /**
     * D-404⑤ · 词典按词典自己的结构显示。
     * .mdx 的正文本来就是 HTML（词头/音标/词性/义项/例句的层次全在标签里），
     * 所以这里**原样渲染**，只包一层可读的基线样式；不联网、不跑脚本。
     */
    private void showDictWeb() {
        if (lkBox == null) return;
        lkScroll.setVisibility(View.GONE);
        if (dictWeb == null) {
            WebView w = new WebView(this);
            // JS 只为我们自己：锚点滚动 + 高度测量。词典自带 <script> 已在判据层
            // 剥掉（dict.ts::stripDictScripts）—— D-404⑤「不跑脚本」承诺不变
            w.getSettings().setJavaScriptEnabled(true);
            w.getSettings().setBlockNetworkLoads(true); // 词典资源全部内联，不上网
            w.getSettings().setDefaultFontSize(13);
            w.setBackgroundColor(0x00000000);
            w.setVerticalScrollBarEnabled(true);
            // 词条有长有短 —— 排完版按真实高度收（上限 240dp，超了自己滚）
            w.setWebViewClient(new android.webkit.WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest req) {
                    return handleDictLink(req.getUrl().toString());
                }
                @SuppressWarnings("deprecation")
                @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
                    return handleDictLink(url);
                }
                @Override public void onPageFinished(WebView v, String url) {
                    if (pendingDictAnchor != null) { scrollDictAnchor(pendingDictAnchor); pendingDictAnchor = null; }
                    v.evaluateJavascript("document.body.scrollHeight", s -> {
                        try {
                            int px = (int) (Float.parseFloat(s.replace("\"", "")) * density);
                            if ("dict".equals(openTab)) {
                                setBoxHeight(Math.max(dp(40), Math.min(dp(240), px + dp(6))));
                            }
                        } catch (Exception ignored) {
                            /* 量不到就保持上限 */
                        }
                    });
                }
            });
            dictWeb = w;
            lkBox.addView(w, new FrameLayout.LayoutParams(-1, -1));
        }
        dictWeb.setVisibility(View.VISIBLE);
        // 基线只管「读得下去」；**词典自带的样式表排在后面 —— 它说了算**（D-404④）。
        // 朗文那份 CSS 里就藏着「词头只显示一次」这类规则，不加载就会看到
        // 「deprecatedeprecate」这种重复片段（真机 2026-08-30）。
        String head = "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<style>"
            + "html,body{margin:0;padding:0 0 6px;background:transparent;color:#474460;"
            + "font-size:13px;line-height:1.62;word-wrap:break-word;-webkit-text-size-adjust:100%}"
            + "img{max-width:100%;height:auto}"
            // 内联进来的都是词典自带的小图标（喇叭那种，原图 200×200）——
            // 词典自己有尺寸规则时它排在后面会赢；没有就按图标大小收着
            + "img[src^=\"data:\"]{max-height:2.4em;width:auto}"
            + "a{color:#5B44D6;text-decoration:none}"
            + ".nyx-book{font-size:9.5px;letter-spacing:.12em;color:#5B44D6;"
            + "text-transform:uppercase;padding:2px 0 4px}"
            + "</style>"
            + (dictCss == null || dictCss.isEmpty() ? ""
                // 防止 css 里出现 </style 提前收尾（正常 CSS 不会有；有就当噪音丢掉）
                : "<style>" + dictCss.replace("</style", "") + "</style>"
                  // 词典的 CSS 常给 body 铺白底/大边距 —— 卡片是自己的容器，收回来
                  + "<style>html,body{background:transparent!important;margin:0!important;"
                  + "padding:0 0 6px!important;max-width:100%!important}</style>");
        String body = "<div class=\"nyx-book\">" + esc(dictBook == null ? "" : dictBook) + "</div>" + dictHtml;
        dictWeb.loadDataWithBaseURL(null, "<!doctype html><meta charset=\"utf-8\">" + head + body,
            "text/html", "utf-8", null);
    }

    private static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /**
     * 词条里的链接（阶段 7 第一件 —— 「方框链点了没反应」的修法）。
     * 真机 .mdx 实探过的全部形状：entry://#锚（同页）· entry://词#锚（跨词条，
     * THESAURUS 方框那种）· sound://路径（词头/例句真人音频）。
     * ★ 这里只认**协议前缀**做分发；entry:// 的语法解析在引擎里
     *  （dict.ts::parseEntryLink 一份）—— 不许在 Java 里抄第二份（§三）。
     */
    private boolean handleDictLink(String url) {
        if (url == null) return false;
        if (url.startsWith("entry://#")) { scrollDictAnchor(url.substring(9)); return true; }
        if (url.startsWith("entry://")) { followEntryLink(url); return true; }
        if (url.startsWith("sound://")) { playDictSound(url.substring(8)); return true; }
        // data:/about: 让它去；http(s) 拦下（blockNetworkLoads 之外再明确一层）
        return url.startsWith("http");
    }

    /** 跨词条跳：引擎解析 + 查目标词条，回来仍走 applyLookup("dict") 那条渲染路 */
    private void followEntryLink(final String href) {
        if (engine == null || bubbleTerm == null) return;
        final String owner = bubbleTerm;
        JSONObject a = new JSONObject();
        try { a.put("href", href); } catch (Exception ignored) {}
        dictWaiting = true; errDict = null; renderTab(); beat();
        engine.call("dictFollow", a, (ok, json) -> {
            if (!owner.equals(bubbleTerm)) return;
            if (ok) {
                try {
                    JSONObject o = new JSONObject(json);
                    String w2 = o.optString("word", "");
                    if (!w2.isEmpty()) dictTerm = w2;
                    String an = o.optString("anchor", "");
                    pendingDictAnchor = an.isEmpty() ? null : an;
                } catch (Exception ignored) {}
            }
            applyLookup("dict", ok, json);
        });
    }

    /** 在当前词条里滚到锚点；不在（词条被裁短）就如实说，绝不「点了没反应」 */
    private void scrollDictAnchor(String anchor) {
        if (dictWeb == null || anchor == null) return;
        String x = anchor.replaceAll("[^\\w-]", "");
        dictWeb.evaluateJavascript(
            "(function(){var el=document.getElementById('" + x + "')||document.getElementsByName('" + x + "')[0];"
                + "if(el){el.scrollIntoView();return 'ok'}return 'miss'})()",
            r -> { if (r != null && r.contains("miss")) toast("这个跳转点不在卡片里（词典条目被裁短了）"); });
    }

    /** 词条里点的 sound://（例句/词头真人音频）—— 字节由引擎按需读数字卷 */
    private void playDictSound(final String path) {
        if (engine == null) return;
        // ★ T-6.5 · 这条路（词条里点 sound://）与词头发音共用 playFile，同样量它的 TTFA
        final long t0 = System.currentTimeMillis();
        JSONObject a = new JSONObject();
        try { a.put("path", path); } catch (Exception ignored) {}
        engine.call("dictSound", a, (ok, json) -> ui.post(() -> {
            String audio = "";
            String why = "";
            if (ok) {
                try {
                    JSONObject o = new JSONObject(json);
                    audio = o.optString("audioB64", "");
                    why = o.optString("why", "");
                } catch (Exception ignored) {}
            }
            if (audio.isEmpty()) {
                probe("dictSound miss " + path + " why=" + why);
                toast("这本词典的音频卷里没有这段音频");
                return;
            }
            try {
                stopPronounce();
                File c = new File(getCacheDir(), "dictsound.mp3");
                java.io.FileOutputStream w = new java.io.FileOutputStream(c);
                w.write(android.util.Base64.decode(audio, android.util.Base64.DEFAULT));
                w.close();
                playFile(c, null, t0);
            } catch (Exception e) {
                probe("dictSound play " + e);
            }
        }));
    }

    /** 分节渲染（AI 那一侧的呈现由我们负责，D-401⑦；词典那侧走它自己的 HTML） */
    private void addSections(JSONArray arr) {
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            String label = o.optString("label", "");
            String text = o.optString("text", "");
            if (!label.isEmpty()) {
                TextView tl = new TextView(this);
                tl.setText(label);
                tl.setTextSize(9.5f);
                tl.setTextColor(tok(NyxAssistService.this, R.color.nyx_violet_2));
                tl.setLetterSpacing(0.12f);
                tl.setPadding(0, dp(i == 0 ? 4 : 9), 0, dp(1));
                lkContent.addView(tl);
            }
            if (!text.isEmpty()) {
                TextView tb = new TextView(this);
                tb.setText(text);
                tb.setTextSize(12.5f);
                tb.setTextColor(tok(NyxAssistService.this, R.color.nyx_ink_2));
                tb.setLineSpacing(dp(3), 1f);
                lkContent.addView(tb);
            }
        }
    }

    private void addNote(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(10.5f);
        t.setTextColor(tok(NyxAssistService.this, R.color.nyx_mute));
        t.setPadding(0, dp(5), 0, 0);
        lkContent.addView(t);
    }

    /** 次要动作：唯一的「主动进 Nyx」出口，视觉上要退到后面 */
    private TextView dimBtn(String label, Runnable onTap) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextColor(tok(NyxAssistService.this, R.color.nyx_mute));
        t.setTextSize(11f);
        t.setPadding(dp(6), dp(7), dp(2), dp(6));
        t.setOnClickListener(v -> onTap.run());
        return t;
    }

    private TextView btn(String label, Runnable onTap) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextColor(tok(NyxAssistService.this, R.color.nyx_violet_2));
        t.setTextSize(12.5f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(dp(6), dp(6), dp(6), dp(6));
        t.setOnClickListener(v -> onTap.run());
        return t;
    }

    private View gap() {
        View v = new View(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, 1, 1f);
        v.setLayoutParams(lp);
        return v;
    }

    /**
     * L0 状态行的**渲染**（T-6.1 / R-004）—— 判据不在这儿。
     *
     * 字段全部来自引擎的 `capture.ts::assistStatus`：认不认得（known）、
     * 产出线状态、认读卡静默没有、挂在哪一讲。这里只把它们摆成一句话，
     * 措辞与 App 那侧 `Assist.svelte::stateLine` 同一句。
     * ★ 查不到就说查不到（D-412 文案说真话）：库还没建过时引擎给的
     *   「Nyx 还没建过库 —— 先打开一次 Nyx」原样带出来，比「不在 Atlas」诚实。
     */
    private static String statusLine(boolean ok, String json) {
        JSONObject o;
        try {
            o = new JSONObject(json == null ? "{}" : json);
        } catch (Exception e) {
            o = new JSONObject();
        }
        if (!ok) {
            String why = o.optString("title", "");
            if (why.length() > 40) why = why.substring(0, 40) + "…";
            return "NYX · 状态查不到" + (why.isEmpty() ? "" : " · " + why);
        }
        if (!o.optBoolean("known", false)) return "NYX · 不在 Atlas";
        String st = o.optString("productionState", "");
        String disp = o.optBoolean("cardSilent", false) && !"silent".equals(st)
            ? "RC-SILENT"
            : (st.isEmpty() ? "?" : st.toUpperCase(java.util.Locale.ROOT));
        String lec = o.isNull("lectureName") ? "" : o.optString("lectureName", "");
        return "NYX · 在 Atlas · " + disp + (lec.isEmpty() ? "" : " · " + lec);
    }

    // ── 悬浮星视图（D-402④⑤ · 品牌四角星双状态）──────────────────
    /**
     * OFF = 空心轮廓，静止（沉睡）。ON = 实心 + 柔光呼吸 + 双星芒微闪（被唤醒）。
     * 编码沿 DS §4.5「active/inactive = 实心/空心同轮廓」；颜色全部取自已冻结
     * 令牌（violet #5B44D6 · paper #FCFCFD · line #E4E1EF）。
     * 几何与动效参数是新值 —— 未冻结，登记待 DS §11 收编（D-326 纪律）。
     */
    private class StarView extends View {
        private float fill = 0f;      // 0=OFF 1=ON（转场动画驱动）
        private float breathe = 0f;   // ON 呼吸相位（0..2π 循环）
        private ValueAnimator trans, breather;
        private final Paint pCard = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint pCardLine = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint pStroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint pFill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint pGlow = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint pRay = new Paint(Paint.ANTI_ALIAS_FLAG);

        // ★ DS §十五 账③ 已结（2026-09-01）：颜色不再手抄，
        //   从 R.color.nyx_* 读 —— 那份资源由 tools/tokens-to-android.mjs
        //   从 nyx-core/src/core/design/color-tokens.css + src/ui/styles/tokens.css 解析生成，npm run build 每次都跑。
        private final int violet;

        StarView(android.content.Context c) {
            super(c);
            violet = tok(c, R.color.nyx_violet);
            pCard.setColor(tok(c, R.color.nyx_star_card));
            pCardLine.setStyle(Paint.Style.STROKE);
            pCardLine.setStrokeWidth(dp(1));
            pCardLine.setColor(tok(NyxAssistService.this, R.color.nyx_line_2));
            pStroke.setStyle(Paint.Style.STROKE);
            pStroke.setStrokeWidth(dp(1.6f));
            pStroke.setColor(violet);
            pStroke.setStrokeJoin(Paint.Join.ROUND);
            pFill.setStyle(Paint.Style.FILL);
            pFill.setColor(violet);
            // 四道衍射芒：与核同色，圆端；线宽同 SVG 的 1.6 / 24 折算到实尺
            pRay.setStyle(Paint.Style.STROKE);
            pRay.setStrokeWidth(dp(1.5f));
            pRay.setStrokeCap(Paint.Cap.ROUND);
            pRay.setColor(violet);
            setElevation(dp(3));
        }

        /**
         * 状态切换：320ms「苏醒」/ 220ms「收拢」，ON 期间起呼吸循环。
         * ★ 这两个数 2026-09-08 由 DS-Q25 冻结（此前文件头写着「值未冻结，待 DS §11 收编」）。
         *   判据在 `tokens.css` 的 --m-star-on / --m-star-off，那边也是 320 / 220。
         *   ★ 它们是**第二份抄件**：令牌生成器只导颜色，不导时长，所以这里对不上也不会红。
         *     改其中一边就必须同轮改另一边 —— 已记进交付「回报总控」栏。
         */
        void setOn(boolean on, boolean animate) {
            if (trans != null) trans.cancel();
            float target = on ? 1f : 0f;
            if (!animate) {
                fill = target;
                syncBreather(on);
                invalidate();
                return;
            }
            trans = ValueAnimator.ofFloat(fill, target);
            trans.setDuration(on ? 320 : 220);
            trans.setInterpolator(new DecelerateInterpolator(1.6f));
            trans.addUpdateListener(a -> { fill = (float) a.getAnimatedValue(); invalidate(); });
            trans.start();
            syncBreather(on);
        }

        private void syncBreather(boolean on) {
            if (on) {
                if (breather != null) return;
                breather = ValueAnimator.ofFloat(0f, (float) (Math.PI * 2));
                breather.setDuration(2600);
                breather.setRepeatCount(ValueAnimator.INFINITE);
                breather.addUpdateListener(a -> { breathe = (float) a.getAnimatedValue(); invalidate(); });
                breather.start();
            } else if (breather != null) {
                breather.cancel();
                breather = null;
                breathe = 0f;
            }
        }

        /** 品牌四角星：菱形四尖 + 内凹二次曲线（✦ 的几何本体） */
        /**
         * 星核 —— **与 Sprite.svelte 的 #nyx-core、ic_assist_tile.xml 同一份几何**
         * （DS v5 §4.2 / §4.5）。三处任何一处改动都要三处同改。
         * 凹弧系数 k = 0.214r（SVG 里是 r=5.6 / k=1.2）。此前这里写的是 0.22f。
         */
        private Path starPath(float cx, float cy, float r) {
            float k = r * 0.214f;
            Path p = new Path();
            p.moveTo(cx, cy - r);
            p.quadTo(cx + k, cy - k, cx + r, cy);
            p.quadTo(cx + k, cy + k, cx, cy + r);
            p.quadTo(cx - k, cy + k, cx - r, cy);
            p.quadTo(cx - k, cy - k, cx, cy - r);
            p.close();
            return p;
        }

        @Override protected void onDraw(Canvas c) {
            float cx = getWidth() / 2f, cy = getHeight() / 2f;
            float cardR = Math.min(cx, cy) - dp(1);
            c.drawCircle(cx, cy, cardR, pCard);
            c.drawCircle(cx, cy, cardR, pCardLine);

            // 柔光：只在 ON（随呼吸微涨落）—— 「能力醒着」的底层信号
            if (fill > 0.02f) {
                float wave = (float) (0.72f + 0.28f * Math.sin(breathe));
                float gr = dp(13) * fill * (0.85f + 0.15f * wave);
                int ga = (int) (46 * fill * wave);
                // 柔光色 = 令牌 assist.glow（tools/tokens-to-android.mjs 生成的 nyx_assist_glow），不再写死 RGB
                int glow = tok(NyxAssistService.this, R.color.nyx_assist_glow);
                pGlow.setShader(new RadialGradient(cx, cy, Math.max(1f, gr),
                    Color.argb(ga, Color.red(glow), Color.green(glow), Color.blue(glow)),
                    Color.argb(0, Color.red(glow), Color.green(glow), Color.blue(glow)), Shader.TileMode.CLAMP));
                c.drawCircle(cx, cy, gr, pGlow);
            }

            // 主星：转场途中带一个轻微「绽放」尖峰（sin 曲线，落定即归位）
            float bump = 1f + 0.10f * (float) Math.sin(fill * Math.PI);
            float r = dp(8.5f) * bump;
            Path star = starPath(cx, cy, r);
            if (fill < 1f) c.drawPath(star, pStroke);
            if (fill > 0f) {
                pFill.setAlpha((int) (255 * fill));
                c.drawPath(star, pFill);
            }

            // 四道衍射芒：只在 ON。**芒不与核相连** —— 那个间隙是这个符号的全部
            // 识别点（DS v5 §4.2 规则②）：连上就变回全行业通用的 AI sparkle。
            //
            // ★ 换代记录：此前这里画的是「双星芒」（两颗错位的小星，D-402 真机验过）。
            //   D-402 当时明写「值未冻结待 DS §11」，所以形态由 DS 定 —— v5 换了种子，
            //   四芒随之取代双星。呼吸相位错开保留，那是 D-402 真正立住的部分。
            if (fill > 0.6f) {
                float wave = (float) (0.62f + 0.38f * Math.sin(breathe));
                pRay.setAlpha((int) (255 * fill * wave));
                float gap = r * 1.55f;          // 芒的内端：与核之间留空
                float tip = r * 2.30f;          // 芒的外端
                c.drawLine(cx, cy - gap, cx, cy - tip, pRay);
                c.drawLine(cx, cy + gap, cx, cy + tip, pRay);
                c.drawLine(cx - gap, cy, cx - tip, cy, pRay);
                c.drawLine(cx + gap, cy, cx + tip, cy, pRay);
                pRay.setAlpha(255);
            }
        }
    }
}
