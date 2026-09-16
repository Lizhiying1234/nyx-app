package com.nyx.android;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.concurrent.futures.CallbackToFutureAdapter;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.ListenableWorker;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import androidx.work.WorkerParameters;

import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONObject;

/**
 * ══ 讲次批量分析 · 后台接着跑（T-5.13 · D-R22）════════════════════
 *
 * 他点了「分析这一讲」，一百条要跑十几分钟。中途他会切走、会锁屏 ——
 * App 的 WebView 一到后台就被系统冻住（2026-08-30 实证），批次就停在那里。
 * 这一份负责把它**尽力**接着跑完。
 *
 * ══ 与 SyncWorker 的三点不同 ═══════════════════════════════════
 *
 *   ① **一次性，不是周期** —— 它不是「每小时看一眼」，是「手上有活没干完」。
 *      干完就没有下一次；没干完自己重新排（`Result.retry()` 或再 enqueue）。
 *   ② **expedited** —— 他刚放下手机，进度条停在 37/100。这一档要尽快接上，
 *      而不是等系统觉得合适。配额用完时 `setExpedited` 会自己降级成普通任务
 *      （`RUN_AS_NON_EXPEDITED_WORK_REQUEST`），不会失败。
 *   ③ **前台不跳过** —— SyncWorker 有「App 在前台就跳过」那道闸，因为前台
 *      自己会同步。这里相反：真正的互斥在 `settings['analysis.lock']` 那把租约上
 *      （JS 侧），前台正跑着的话这一趟自己会拿不到租约、安静返回。
 *      在 Java 里再判一次前台只会**多一份判据**，而且判错的那次代价是白跑。
 *
 * ══ 为什么跑在 AssistEngine 的无头 WebView 里 ═════════════════════
 *
 * 和 SyncWorker 同一条理由：判据是 TypeScript（`db/analysis-runner.ts` →
 * `db/analyse.ts` → `core/analysis/*`）。在原生侧再写一遍 = 这个项目最贵的
 * 事故形态。而 App 主进程那个 WebView 后台会被冻，叫醒它只能 startActivity。
 * 所以复用 D-404 已经建好的那条路。
 *
 * ★ **Java 里零业务 SQL**（`check:java-sql`）：这里连「有没有待办」都不查库 ——
 *   问 JS，它答 `idle` 就收工。谁进队、跑到哪、还剩几条，全是那一侧的事。
 *
 * ══ 承诺的边界 —— 尽力，不承诺更多 ═══════════════════════════════
 *
 * Force Stop 之后 WorkManager 的任务也停（Android 的规矩，App 侧改不掉），
 * 下次他打开 App 时前台自己会接着跑。厂商的省电策略也可能压掉这一档。
 * 所以界面上不许说「后台会跑完」，只能说「会尽量接着跑」。
 */
public final class AnalysisWorker extends ListenableWorker {

    private static final String TAG = "NyxAnalysisWorker";
    private static final String WORK_NAME = "nyx-analysis-continue";

    /**
     * 这一趟的硬超时。WorkManager 给 10 分钟；expedited 的实际配额更短。
     * ★ 引擎那边拿到的预算比它**少一分钟**（见下）：让 JS 有时间把
     *   最后一条的状态写完、把租约还回去，而不是被这里一刀砍在半路。
     */
    private static final long TIMEOUT_MS = 5 * 60 * 1000;
    private static final long ENGINE_BUDGET_MS = 4 * 60 * 1000;

    public AnalysisWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    /**
     * 真机探针 —— 后台任务的唯一诊断口（同 SyncWorker 的理由：这台 ROM 的
     * logcat 被限流，而后台连页面都没有）：
     *   `adb shell run-as com.nyx.android cat files/analysis-worker.txt`
     * ★ 只记「几点、什么结果」，到 32KB 就重来 —— 它是探针，不许长成日志系统。
     */
    private void probe(String msg) {
        try {
            java.io.File f =
                new java.io.File(getApplicationContext().getFilesDir(), "analysis-worker.txt");
            if (f.length() > 32768) //noinspection ResultOfMethodCallIgnored
                f.delete();
            try (java.io.FileWriter w = new java.io.FileWriter(f, true)) {
                w.write(System.currentTimeMillis() + " " + msg + (char) 10);
            }
        } catch (Exception ignored) {
        }
    }

    /**
     * 排一次「接着跑」。
     * ★ `REPLACE` 而不是 `KEEP`：这是一次性任务，重复排的意思是
     *   「刚才那次可能已经过期了，以现在这次为准」。
     * ★ 谁来调：JS 侧发现「有没做完的批次」并且 App 要进后台时
     *   （`AnalysisPlugin.scheduleBackground`）。**Java 自己不查库判**。
     */
    static void schedule(Context ctx) {
        try {
            Constraints c = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)   // 分析要连 AI，没网就别醒
                .build();
            OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(AnalysisWorker.class)
                .setConstraints(c)
                // 配额用完自动降级成普通任务，不会因此失败
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build();
            WorkManager.getInstance(ctx.getApplicationContext())
                .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, req);
        } catch (Throwable t) {
            // 排不上不该拖垮任何东西 —— 下次他打开 App，前台自己会接着跑
            Log.w(TAG, "schedule failed", t);
        }
    }

    /** 取消（批次做完 / 他取消了）—— 别让一个没活干的任务醒来 */
    static void cancel(Context ctx) {
        try {
            WorkManager.getInstance(ctx.getApplicationContext()).cancelUniqueWork(WORK_NAME);
        } catch (Throwable t) {
            Log.w(TAG, "cancel failed", t);
        }
    }

    @NonNull
    @Override
    public ListenableFuture<Result> startWork() {
        // ★ startWork() 在主线程 —— WebView 必须在主线程建，正好
        return CallbackToFutureAdapter.getFuture(completer -> {
            probe("start");
            final AssistEngine engine = new AssistEngine(getApplicationContext());
            final Handler ui = new Handler(Looper.getMainLooper());
            final boolean[] settled = { false };

            final Runnable finish = () -> {
                try { engine.destroy(); } catch (Throwable ignored) {}
            };

            // 超时兜底：绝不把 Worker 挂死
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
                JSONObject a = new JSONObject();
                a.put("budgetMs", ENGINE_BUDGET_MS);
                engine.call("analysis", a, (ok, json) -> {
                    if (settled[0]) return;
                    settled[0] = true;
                    ui.removeCallbacks(onTimeout);
                    finish.run();
                    if (!ok) {
                        // 失败一律 retry（同 SyncWorker 闸③）：网络抖动、BUSY 都是暂时的。
                        // 真正的失败（key 不对之类）JS 那侧已经把整批停了并留了痕。
                        probe("fail " + json);
                        completer.set(Result.retry());
                        return;
                    }
                    probe("ok " + json);
                    /**
                     * ★ 还有剩的就再排一次 —— 一次 expedited 只给几分钟，
                     *   一百条跑不完。`Result.retry()` 会按 WorkManager 的退避
                     *   重新排同一条任务，正是我们要的「有待办就继续」。
                     */
                    completer.set(hasLeft(json) ? Result.retry() : Result.success());
                });
            } catch (Throwable t) {
                settled[0] = true;
                ui.removeCallbacks(onTimeout);
                finish.run();
                Log.e(TAG, "analysis threw", t);
                probe("threw " + t);
                completer.set(Result.retry());
            }
            return TAG + ":run";
        });
    }

    /** 引擎回的 `left` 是「队列里还剩几条」—— 只读这一个数，不解释别的 */
    private static boolean hasLeft(String json) {
        try {
            return new JSONObject(json == null ? "{}" : json).optInt("left", 0) > 0;
        } catch (Exception e) {
            return false; // 读不懂就当没剩的，别无限重排
        }
    }
}
