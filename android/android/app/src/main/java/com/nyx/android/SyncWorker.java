package com.nyx.android;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.concurrent.futures.CallbackToFutureAdapter;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ListenableWorker;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.WorkerParameters;

import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

/**
 * ══ 后台周期同步（2026-09-01 · X-Ray 审计 F-003）════════════════
 *
 * ★★★ 病：在这之前，手机只有**冷启动**和**练完**会同步。
 *   于是「电脑上删了一个词，手机上什么时候消失」的答案是
 *   「下次你打开 App 的时候」—— **没有上界**。手机在口袋里放三天，
 *   它就三天不知道电脑那边发生了什么。
 *   （同一轮已经先补了「切回前台就同步」，见 App.svelte。这一份补的是
 *    「连前台都没回」的那一档。）
 *
 * ══ 为什么跑在 AssistEngine 的无头 WebView 里 ★★ ═══════════════
 *
 * 同步的判据是 TypeScript（`core/sync/engine.ts`，两端同一份）。
 * 在原生侧再写一遍 = 这个项目最贵的事故形态（同一件事两份判据）。
 * 而 App 主进程的那个 WebView 只活在 MainActivity 里、后台会被系统冻结
 * （2026-08-30 实证）—— 叫醒它只能 startActivity，那就成了「后台把 App 弹到前台」。
 *
 * 所以复用 D-404 已经建好的那条路：**服务自带的无头 WebView**。
 * 它已经有 sql / secret / http 三个端口；这一轮给它补上 filesDir / dirList /
 * fileRead / fileWrite / fileDelete，同步引擎需要的 backup 与 audio 就齐了。
 *
 * ══ 三条闸（都在这里，不在 JS 里）═════════════════════════════
 *
 *   ① **App 在前台就跳过** —— 前台自己会同步（冷启动 + resume + 练完）。
 *      两条连接同时写同一个库文件只会互相撞 BUSY，没有任何收益。
 *   ② **超时 5 分钟** —— WorkManager 给 10 分钟；留一半余量，
 *      超时按「这次没成」处理（retry），绝不把 Worker 挂死。
 *   ③ **失败一律 retry，不 failure** —— 网络抖动、BUSY、云端 5xx 都是暂时的；
 *      真正的失败（结构不合、桶不存在）由引擎自己留痕（R-4-D），
 *      设置页的同步区看得见。**后台绝不弹窗**（D-100「不催」）。
 */
public final class SyncWorker extends ListenableWorker {

    private static final String TAG = "NyxSyncWorker";

    /** 系统的周期下限是 15 分钟；我们要的是「大约每小时」（D-347 的手机对称面 + Q-4 裁决） */
    private static final long PERIOD_MINUTES = 60;

    /**
     * ★★ 唯一任务名**带着周期**，改周期就必须改名 —— 这一条是真机撞出来的（2026-09-01）。
     *
     * `ExistingPeriodicWorkPolicy.KEEP` 的意思是「已经排上了就一个字都不动」，
     * 于是**改了 `PERIOD_MINUTES` 也不会生效** —— 验收时把周期从 60 调到 15 跑通，
     * 再改回 60 重装，`dumpsys` 里那条任务**还是 15 分钟**。
     * 它不报错、界面上也看不出来，正是这个项目定义的那类最贵的失败形态。
     *
     * 不改用 `UPDATE` 的理由：`UPDATE` 每次启动都会重排下一次触发时间 ——
     * 使用者只要开 App 比周期勤，这个任务就**永远轮不到**。那更糟。
     *
     * 所以：名字里带周期，改周期 = 换新任务；顺手把老名字取消掉。
     */
    private static final String WORK_NAME = "nyx-periodic-sync-" + PERIOD_MINUTES + "m";
    /** 历史名字（改周期时留下的）—— 排新的之前先取消，免得两条一起跑 */
    private static final String[] LEGACY_WORK_NAMES = { "nyx-periodic-sync" };
    private static final long TIMEOUT_MS = 5 * 60 * 1000;

    /**
     * App 有没有 Activity 在前台。MainActivity 的 `onResume` / `onPause` 维护。
     *
     * ★★ I-152（真机 2026-09-07）· **它一个人说了不算。**
     *   这里原来的注释写着「判错的代价只是白跑一次或少跑一次」—— **那句话被真机证伪了**：
     *   ColorOS 上锁屏之后这个标志停在 `true`（`onPause` 没按预期来），于是
     *   **连续 5 次准点醒全部 `fg=true` 而跳过，四个小时一次真同步都没有**。
     *   代价不是「少跑一次」，是「后台同步整段时间形同不存在」。
     */
    static volatile boolean appInForeground = false;

    /**
     * ★★ I-152 · 前台闸真正的判据：**Activity 说自己在前台，而且屏幕真的亮着、没锁**。
     *
     * 闸① 想拦的是「人正在用 App，前台自己会同步，两条连接同时写只会互相撞 BUSY」。
     * 屏幕灭着或锁着的时候，这句话的前提**不成立** —— 不管那个静态标志说什么，
     * 人都不在看它，前台那三条同步路径（冷启动 / 切回前台 / 练完）一条都不会触发。
     *
     * ★ 两个系统信号都取不到时（`null`）按「不在前台」算：宁可多同步一次，
     *   也不要再来一次四小时的空窗 —— 撞 BUSY 有重试，不同步没有。
     * ★ 判据写成一个只吃三个布尔的静态方法，是为了让它在真机探针里**看得见**
     *   （下面 `probe` 三个值一起记）：Java 这一侧没有 ② 档用例，
     *   唯一的验收面就是 `sync-worker.txt` 那一行。
     */
    static boolean skipForeground(boolean flag, boolean interactive, boolean locked) {
        return flag && interactive && !locked;
    }

    /** 问一次系统：屏幕亮着吗、锁着吗（取不到就当「灭着 / 锁着」） */
    private boolean[] screenState() {
        boolean interactive = false;
        boolean locked = true;
        try {
            android.os.PowerManager pm =
                (android.os.PowerManager) getApplicationContext().getSystemService(Context.POWER_SERVICE);
            if (pm != null) interactive = pm.isInteractive();
            android.app.KeyguardManager km =
                (android.app.KeyguardManager) getApplicationContext().getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) locked = km.isKeyguardLocked();
        } catch (Throwable t) {
            Log.w(TAG, "screenState failed", t);
        }
        return new boolean[] { interactive, locked };
    }

    public SyncWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    /**
     * 真机探针 —— **这一条对后台任务是必需的，不是调试残留**。
     *
     * 这台 ROM 的 logcat 被限流（`tools/device/README` 的老坑，D-406 也撞过）：
     * 前台还能靠 `globalThis.nyx` 让页面自己报数，**后台连页面都没有**。
     * 落文件是唯一能回答「它到底跑没跑、跑成什么样」的办法：
     *   `adb shell run-as com.nyx.android cat files/sync-worker.txt`
     *
     * ★ 只记一句结果，且到 32KB 就重来 —— 它是探针，不许长成日志系统
     *   （同 `NyxAssistService::probe` 的自律）。
     * ★ 不记任何内容，只记「几点、什么结果」—— 同步的内容留痕在
     *   `settings['sync.problems']`（R-4-D），那才是给他看的地方。
     */
    private void probe(String msg) {
        try {
            java.io.File f = new java.io.File(getApplicationContext().getFilesDir(), "sync-worker.txt");
            if (f.length() > 32768) //noinspection ResultOfMethodCallIgnored
                f.delete();
            try (java.io.FileWriter w = new java.io.FileWriter(f, true)) {
                w.write(System.currentTimeMillis() + " " + msg + (char) 10);
            }
        } catch (Exception ignored) {
        }
    }

    /** 排一次周期任务。重复调用是安全的（KEEP：已经排上了就不动它） */
    static void schedule(Context ctx) {
        try {
            WorkManager wm = WorkManager.getInstance(ctx.getApplicationContext());
            // 换过周期的话，老名字那条还排着 —— 先收掉，免得两条一起跑
            for (String old : LEGACY_WORK_NAMES) {
                if (!old.equals(WORK_NAME)) wm.cancelUniqueWork(old);
            }
            Constraints c = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)   // 没网就别醒
                .build();
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
                SyncWorker.class, PERIOD_MINUTES, TimeUnit.MINUTES)
                .setConstraints(c)
                .build();
            wm.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req);
        } catch (Throwable t) {
            // 排不上不该拖垮启动 —— 前台那两条同步路径照旧
            Log.w(TAG, "schedule failed", t);
        }
    }

    @NonNull
    @Override
    public ListenableFuture<Result> startWork() {
        // ★ startWork() 在主线程 —— WebView 必须在主线程建，正好
        return CallbackToFutureAdapter.getFuture(completer -> {
            // ★★ I-152 · 判定依据三个值一起记 —— 这一行就是它在真机上唯一的验收面
            final boolean[] scr = screenState();
            final boolean skip = skipForeground(appInForeground, scr[0], scr[1]);
            probe("start fg=" + appInForeground + " interactive=" + scr[0]
                + " locked=" + scr[1] + " -> " + (skip ? "skip" : "run"));
            if (skip) {
                // 闸① —— 人真的在看着 App，前台自己会同步；两条连接同时写只会互相撞 BUSY
                completer.set(Result.success());
                return TAG + ":skip-foreground";
            }

            final AssistEngine engine = new AssistEngine(getApplicationContext());
            final Handler ui = new Handler(Looper.getMainLooper());
            final boolean[] settled = { false };

            final Runnable finish = () -> {
                // 引擎与它的 WebView 都在主线程上收
                try { engine.destroy(); } catch (Throwable ignored) {}
            };

            // 闸② —— 超时兜底：绝不把 Worker 挂死
            final Runnable onTimeout = () -> {
                if (settled[0]) return;
                settled[0] = true;
                Log.w(TAG, "timeout");
                probe("timeout " + TIMEOUT_MS + "ms");
                finish.run();
                completer.set(Result.retry());
            };
            ui.postDelayed(onTimeout, TIMEOUT_MS);

            try {
                engine.call("sync", new JSONObject(), (ok, json) -> {
                    if (settled[0]) return;
                    settled[0] = true;
                    ui.removeCallbacks(onTimeout);
                    finish.run();
                    if (ok) {
                        Log.i(TAG, "sync ok");
                        probe("ok " + json);
                        completer.set(Result.success());
                    } else {
                        // 闸③ —— 失败一律 retry。真正的失败引擎自己留痕（R-4-D）
                        Log.w(TAG, "sync failed");
                        probe("fail " + json);
                        completer.set(Result.retry());
                    }
                });
            } catch (Throwable t) {
                settled[0] = true;
                ui.removeCallbacks(onTimeout);
                finish.run();
                Log.e(TAG, "sync threw", t);
                probe("threw " + t);
                completer.set(Result.retry());
            }
            return TAG + ":run";
        });
    }
}
