package com.nyx.android;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 讲次批量分析的**后台排班口**（T-5.13）—— 只有两个方法，各一行。
 *
 * ── 为什么需要它 ★★ ─────────────────────────────────────────
 *
 * 「有没有没做完的批次」这件事只有 JS 知道（状态在 `settings['analysis.batch']`）。
 * 而 `check:java-sql` 那道闸明写：**Java 里不许出现业务 SQL** ——
 * 让原生自己去查一句 `select value from settings where key='analysis.batch'`
 * 正是那道闸挡的东西（T-6.1 回收掉的两处判据就是这么长出来的）。
 *
 * 所以分工是：**JS 判「要不要排」，原生只管「排」**。
 * 一行判据都不在这里。
 *
 * ★ 为什么不塞进已有的插件：`NyxDevice` 是「我还是不是原来那台机器」、
 *   `NyxDict` 是词典文件面 —— 各自单一职责。把一个不相干的方法挂上去，
 *   下一个人读那个文件时要先想清楚「它为什么在这」。
 */
@CapacitorPlugin(name = "NyxAnalysis")
public class AnalysisPlugin extends Plugin {

    /** 有没做完的批次 + App 要进后台了 → 排一次「接着跑」 */
    @PluginMethod
    public void scheduleBackground(PluginCall call) {
        AnalysisWorker.schedule(getContext());
        call.resolve();
    }

    /** 批次做完 / 他取消了 → 别让一个没活干的任务醒来 */
    @PluginMethod
    public void cancelBackground(PluginCall call) {
        AnalysisWorker.cancel(getContext());
        call.resolve();
    }
}
