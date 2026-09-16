package com.nyx.android;

import android.content.Context;

import java.io.File;

/**
 * 探针写在哪、什么时候写 —— **一份，谁都用这一份**（T-6.5）。
 *
 * ══ 为什么单独拎出来 ═══════════════════════════════════════
 *
 * 这段逻辑原来长在 `NyxAssistService.probe()` 里（那台 ROM 限流吞 `Log.d`，
 * 诊断只能靠文件探针 —— 见 CLAUDE.md §七）。T-6.5 要在**引擎那一侧**
 * （`AssistEngine`，无头 WebView）也记时间戳，而 `AssistEngine` 不是那个
 * Service 的一部分。照抄一份写文件的代码 = 两份格式、两个开关、两个大小上限，
 * 而这个仓库为「同一件事两份实现」付过好几次学费。
 *
 * ══ 行为与原来逐字相同 ═════════════════════════════════════
 *
 * 同一个文件（`filesDir/probe.txt`）· 同一个格式（`<毫秒> <消息>\n`）·
 * 同一个 64 KB 上限（超了整个删掉重来，它是探针不是日志系统）·
 * 同一个开关（`settings['assist.probe']`，`collect err` 那一类照旧无条件写）。
 *
 * ★ 开关由 `NyxAssistService.readConfig()` 拨到 `on` 上 —— **判据仍然只有那一处**
 *   （拨一下星就生效、不必重装，见那边的注释）。这里只是它的写入口。
 */
final class Probe {
    /** `settings['assist.probe']` 的当前值。★ volatile：引擎那一侧在别的线程上读 */
    static volatile boolean on = false;

    private Probe() {}

    static void write(Context ctx, String msg) {
        if (ctx == null || msg == null) return;
        // ★ 「collect err」无条件写：取词失败是**采集事故**，不该因为探针没开就丢掉
        if (!on && !msg.startsWith("collect err")) return;
        try {
            File f = new File(ctx.getFilesDir(), "probe.txt");
            if (f.length() > 65536) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(System.currentTimeMillis() + " " + msg + String.valueOf((char) 10));
            w.close();
        } catch (Exception ignored) {
        }
    }
}
