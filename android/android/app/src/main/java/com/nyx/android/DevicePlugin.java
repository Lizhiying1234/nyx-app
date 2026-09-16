package com.nyx.android;

import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 「这个库还是长在原来那台机器上吗」· F-009（2026-09-01）
 *
 * ── 它挡的是哪一种事故 ────────────────────────────────────
 *
 * AndroidManifest 里 allowBackup="true"，Android 自动备份会把 App 私有数据
 * （**包含 nyx.db**）传到云端，换机/重装时自动恢复。而同步的设备编号
 * （settings['sync.device']）**就住在那个库里**，于是：
 *
 *     旧手机 device = a3f21c08
 *         ↓ 自动备份 → 恢复到新手机（旧手机没退役）
 *     新手机 device = a3f21c08      ← 同一个编号
 *         ↓
 *     planTodo 跳过所有 "a3f21c08-" 开头的包
 *         ↓
 *     ★★ 两台各自跳过对方的**全部**包，永远收不到对方的数据 ——
 *        而且不报错、不算失败、体检也不亮：两台都显示「同步成功，收到 0 行」。
 *
 * ── 为什么用 ANDROID_ID ───────────────────────────────────
 *
 * 要的性质只有一条：**它不跟着备份走**。ANDROID_ID 正好如此 ——
 * 恢复到另一台设备上时它是另一个值，而在同一台机器上重装、升级都不变。
 *
 * ★ 它在「恢复出厂设置」「换签名重装」之后也会变。那时我们会白铸一次新编号，
 *   代价只是多一个历史编号（旧号推的包照样跳过，见 core::planTodo 的
 *   formerDevices）—— **朝安全方向错**：宁可多铸一个号，不可两台同号。
 *
 * ★ 不用它做别的：这里不是设备指纹，不上报，不进任何包。
 *   它只在本机 settings 里存一份，用来回答「我还是不是原来那台」。
 *
 * ★ 为什么不干脆 allowBackup="false"：那会让使用者换手机时丢掉
 *   **本机还没上传的孤本**，与 D-249 红线直接冲突。备份要留，号要防撞。
 */
@CapacitorPlugin(name = "NyxDevice")
public class DevicePlugin extends Plugin {

    /** 本机标识 —— 取不到就返回空串，由 JS 侧当作「这台机器说不清」处理（不换号） */
    @PluginMethod
    public void hardwareId(PluginCall call) {
        String id = "";
        try {
            id = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Throwable ignored) {
            // 取不到就空着 —— 这条链路绝不许把开库带崩
        }
        JSObject out = new JSObject();
        out.put("id", id == null ? "" : id);
        call.resolve(out);
    }
}
