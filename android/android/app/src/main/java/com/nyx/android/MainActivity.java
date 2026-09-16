package com.nyx.android;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Nyx Assist 的原生半场（D-394 三通道）：
 *   ① PROCESS_TEXT / SEND（Manifest intent-filter）→ 文本直接进口袋
 *   ② 磁贴（ACTION_ASSIST_CLIP）→ 等拿到窗口焦点后读剪贴板（Android 10+ 合规点）→ 口袋（open）
 *   ③ 打开时接词 → 每次焦点顺手读剪贴板放 chip 口袋 —— 显不显示由 JS 按设置与去重判
 * 原生保持傻：判据（英文判定/去重/开关）全在 JS 侧。
 */
public class MainActivity extends BridgeActivity {
    public static final String ACTION_ASSIST_CLIP = "com.nyx.android.ASSIST_CLIP";
    private boolean pendingClip = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SharePlugin.class);
        registerPlugin(DictPlugin.class);
        registerPlugin(TtsPlugin.class);
        registerPlugin(NotifyPlugin.class);
        registerPlugin(DevicePlugin.class);
        // T-5.13 · 批量分析的后台排班口（判据在 JS，这里只管排）
        registerPlugin(AnalysisPlugin.class);
        super.onCreate(savedInstanceState);
        takeIntent(getIntent());
        // F-003 · 排后台周期同步（重复调用安全 —— KEEP）。排不上不影响前台那两条路径
        SyncWorker.schedule(this);
    }

    /**
     * ★ F-003 闸① 的开关：前台的时候后台任务跳过。
     *   前台自己会同步（冷启动 + 切回前台 + 练完），两条连接同时写同一个库
     *   只会互相撞 BUSY，没有任何收益。
     */
    @Override
    public void onResume() {
        super.onResume();
        SyncWorker.appInForeground = true;
    }

    @Override
    public void onPause() {
        SyncWorker.appInForeground = false;
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (takeIntent(intent) && this.bridge != null) {
            // 热启动：文本已在口袋里 —— 事件只当铃铛（data 是 CustomEventInit，别传值）
            this.bridge.triggerWindowJSEvent("nyxShare", "{}");
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) return;
        // ★ D-400①（flex 丢失的根因修复）：这里以前「剪贴板空就 return」——
        //   把口袋里等着交接的 save 一起吞了。现在：剪贴板只管 chip/磁贴那半，
        //   口袋非空就必摇铃，交接绝不依赖「剪贴板恰好有内容」。
        String clip = readClip();
        if (clip != null) {
            if (pendingClip) {
                SharePlugin.pendingText = clip;
                SharePlugin.pendingPkg = null;
                SharePlugin.pendingMode = "open";
            } else if (SharePlugin.pendingText == null) {
                // 打开时接词：只递 chip，不抢屏；JS 按设置与去重决定显不显
                SharePlugin.pendingText = clip;
                SharePlugin.pendingPkg = null;
                SharePlugin.pendingMode = "chip";
            }
        }
        pendingClip = false;
        if (SharePlugin.pendingText != null && this.bridge != null) {
            this.bridge.triggerWindowJSEvent("nyxShare", "{}");
        }
    }

    /** 三类进门 intent：分享 / 选中文本 / 磁贴（磁贴只立 flag，焦点到手才读剪贴板） */
    private boolean takeIntent(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (ACTION_ASSIST_CLIP.equals(action)) {
            pendingClip = true;
            return false;
        }
        String text = null;
        if (Intent.ACTION_SEND.equals(action) && "text/plain".equals(intent.getType())) {
            text = intent.getStringExtra(Intent.EXTRA_TEXT);
        } else if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
            CharSequence cs = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
            if (cs != null) text = cs.toString();
        }
        if (text == null || text.trim().isEmpty()) return false;
        SharePlugin.pendingText = text.trim();
        Uri ref = getReferrer();
        SharePlugin.pendingPkg =
            (ref != null && "android-app".equals(ref.getScheme())) ? ref.getHost() : null;
        SharePlugin.pendingMode = "open";
        return true;
    }

    private String readClip() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return null;
            ClipData cd = cm.getPrimaryClip();
            if (cd == null || cd.getItemCount() == 0) return null;
            CharSequence cs = cd.getItemAt(0).coerceToText(this);
            if (cs == null) return null;
            String t = cs.toString().trim();
            return t.isEmpty() ? null : t;
        } catch (Exception e) {
            return null;
        }
    }
}
