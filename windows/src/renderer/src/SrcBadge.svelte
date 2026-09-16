<script lang="ts">
  /**
   * 来源徽章 —— **一份几何，三处在用**（2026-09-01）
   *
   * ══ 为什么抽出来 ════════════════════════════════════════
   *
   * 这两个图形此前是**逐字复制**的：`Library` / `Workbench` / `HardZone` 各一份。
   * 而它们**已经漂了** —— `Workbench` 那份多一个角标（次数 ≥2 时显示数字，D-037），
   * 另外两处没有。同一个徽章在不同屏上说的话不一样，**而且没人会发现**，
   * 因为三处代码各自都说得通。这正是本项目定义的最贵事故形态。
   *
   * ★ 抽出来这一步**不改任何一处的观感**：角标由 `count` 参数决定，
   *   调用方传什么就画什么，各屏维持现状。
   *   「三处到底该不该一致」是产品判断，留给使用者（D-214 / D-417）。
   *
   * ══ 两个徽章各自是什么 ══════════════════════════════════
   *
   * · **被重复收集**（D-037）：描边五角星 + 金褐色。次数 ≥2 才出现数字角标。
   * · **双方共识**（D-044）：四角星 —— 我和 AI 在同一次分析里都识别到了。
   *
   * ★ 颜色暂时写死在这里（`--gold` / `--accent` 的字面值）。
   *   它们不在 Nyx 那 32 枚 sprite 里 —— sprite 是**图标**，这两个是**数据徽章**，
   *   语义不同、配给规则也不同（DS §4.4 星核配给律管的是前者）。
   */
  let { kind, count = 0 }: { kind: 'recollected' | 'both'; count?: number } = $props()
</script>

{#if kind === 'recollected'}
  <!-- D-037 · 描边星 + 金褐色角标，次数 ≥2 才出现数字 -->
  <svg width="14" height="14" viewBox="0 0 26 26" aria-label="被重复收集">
    <path
      d="M11 4.4l2.35 5.6 6.05.48-4.6 3.94 1.4 5.92L11 17.1l-5.2 3.24 1.4-5.92-4.6-3.94 6.05-.48z"
      fill="none"
      style="stroke:var(--gold)"
      stroke-width="2.1"
      stroke-linejoin="round"
    />
    {#if count >= 2}
      <circle cx="20.4" cy="6" r="5.4" style="fill:var(--gold)" />
      <text
        x="20.4"
        y="8.6"
        font-size="8"
        font-weight="700"
        style="fill:var(--color-text-inverse)"
        text-anchor="middle"
        font-family="ui-monospace,monospace">{count}</text
      >
    {/if}
  </svg>
{:else}
  <!-- D-044 · 四角星 = 我和 AI 在同一次分析中都识别到了 -->
  <svg width="12" height="12" viewBox="0 0 24 24" aria-label="双方共识">
    <path d="M12 3.2l1.9 5.35 5.4 1.9-5.4 1.9L12 17.7l-1.9-5.35-5.4-1.9 5.4-1.9z" style="fill:var(--src-both)" />
  </svg>
{/if}
