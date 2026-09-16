package com.nyx.android;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Nyx Assist 的接词口（D-304 · I-1/I-2）。
 *
 * 冷启动时 JS 还没起，triggerWindowJSEvent 会说给空气听 ——
 * 所以文本先存在口袋里，JS 起来后主动 consume()；
 * 热启动由 MainActivity（焦点回调）或 ringBell() 摇铃。取到即清，不会收两遍。
 *
 * ★ D-400① 的教训（flex 丢失）：交接绝不许依赖「剪贴板恰好有内容」这类
 *   偶然条件 —— 口袋非空就必须有人摇铃。
 * ★★ D-404① 之后这里**只剩明确的进门动作**（分享 / 选中文本 / 磁贴 /
 *   气泡上那个「打开 Nyx ↗」）。气泡的查词与保存不再走口袋 ——
 *   它们由 AssistEngine 就地完成，一次 Activity 都不起。
 */
@CapacitorPlugin(name = "NyxShare")
public class SharePlugin extends Plugin {
    static String pendingText = null;
    static String pendingPkg = null;
    /** D-399③ · 词所在完整句子（选择层给；分享/剪贴板通道为 null） */
    static String pendingQuote = null;
    /** "open"=开浮层 · "chip"=打开时接词小条 */
    static String pendingMode = "open";

    private static SharePlugin live = null;

    @Override
    public void load() {
        live = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (live == this) live = null;
        super.handleOnDestroy();
    }

    /** 服务直连摇铃：JS 活着就不必拉起界面（真正 in-place）。false = 得走冷启动 */
    static boolean ringBell() {
        SharePlugin p = live;
        if (p == null || p.getBridge() == null || p.getBridge().getWebView() == null) return false;
        try {
            p.getBridge().triggerWindowJSEvent("nyxShare", "{}");
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void consume(PluginCall call) {
        JSObject out = new JSObject();
        out.put("text", pendingText);
        out.put("pkg", pendingPkg);
        out.put("quote", pendingQuote);
        out.put("mode", pendingMode);
        pendingText = null;
        pendingPkg = null;
        pendingQuote = null;
        pendingMode = "open";
        call.resolve(out);
    }

    /** Settings 总开关 → 立即生效（D-400⑨：星当场隐显；星随总开关，D-408） */
    @PluginMethod
    public void assistConfig(PluginCall call) {
        NyxAssistService.applyConfig(!Boolean.FALSE.equals(call.getBoolean("enabled")));
        call.resolve();
    }

    /** 无障碍授权状态 —— 选择层的系统前提，Settings 如实显示 */
    @PluginMethod
    public void assistState(PluginCall call) {
        String enabled = Settings.Secure.getString(
            getContext().getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        String pkg = getContext().getPackageName();
        boolean granted = enabled != null
            && (enabled.contains(pkg + "/" + NyxAssistService.class.getName())
                || enabled.contains(pkg + "/." + NyxAssistService.class.getSimpleName()));
        JSObject out = new JSObject();
        out.put("granted", granted);
        call.resolve(out);
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /**
     * 打开 **Nyx 自己那一页**系统设置（T-6.7）。
     *
     * 为什么要它：无障碍授权会被「强制停止」那一类事件撤销（一键清理 · 上滑杀
     * 后台 · 重装）—— 2026-09-06 在 PJE110 上量过：`am force-stop` 之后
     * `enabled_accessibility_services` 直接变成 `null`，而 `am kill` 不会。
     * 把 Nyx 加进耗电管理白名单 / 允许自启动，能显著减少被清理的次数，
     * 而那两个开关在 ColorOS 上就放在这一页。
     *
     * ★ 只**打开页面**，一个系统设置都不写 —— 写 `enabled_accessibility_services`
     *   要 `WRITE_SECURE_SETTINGS`，普通 App 拿不到；而且使用者明说了
     *   **不是要绕过系统授权机制**。第一次仍然必须由他在系统里开。
     * ★ 为什么不用 `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`：两个都能打开
     *   （真机实测），但那一个落在**全部应用的长列表**上，还要他自己翻到 Nyx；
     *   这一个直接就是 Nyx 的页面。
     */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }
}
