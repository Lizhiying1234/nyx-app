<script lang="ts">
  /**
   * 启动页 —— **只有这一帧**（使用者 2026-09-09 裁「我就要 1 个」），
   * 而且 **2026-09-13 起这个文件不画它，只负责把它收走**。
   *
   * ══ 为什么不画了 ════════════════════════════════════════════
   * 使用者 2026-09-13：「启动时会先出现一段空白，然后才显示图标或图片 ——
   * 让启动页面一开始就直接显示图，不要先出现空白」。
   * 真机量到那段空白约 1 秒，而**其中绝大部分是这一帧自己迟到**：
   * 它是个 Svelte 组件，要等 564 KB 的 JS 包下载 + 解析 + 挂载完才出现。
   * 所以那一帧挪进了 `index.html`（静态标记，跟着 HTML 一起画，第一帧就有图），
   * 这里只剩「什么时候让开」这一件事 —— 那恰好是它唯一需要状态的地方。
   *
   * ★ 剩下的那点空白是**系统那一帧**（进程起来之前，Android 自己画的一块纯色底，
   *   `styles.xml` 里指着一张全透明的 drawable）。那一段删不掉：
   *   系统帧画什么是写死在主题里的，运行时换不了。
   *
   * ══ 什么时候让开 ════════════════════════════════════════════
   *   下限 500ms：库开得快时不让它一闪而过（那等于「启动页没了」）
   *   上限 800ms：到点就让开，各屏本来就有自己的加载态
   * 两条都没动 —— 这一轮只改「什么时候出现」，不改「待多久」。
   *
   * ★ `index.html` 里还有一个 8 秒兜底：JS 包要是根本没起来，
   *   这一帧不能把人永远挡在外面。两条命各管各的失败。
   * ★ D-227：这个文件里一行样式都没有（现在连标记都没有了）。
   */
  import { store } from './store.svelte.ts'

  /** 下限到了没（没到就不让走） */
  let minDone = $state(false)
  /** 上限到了没（到了就必须走，不管库开好没有） */
  let capDone = $state(false)

  const ready = $derived(store.db.k === 'ok' || store.db.k === 'error')
  /** 走的条件：**下限已过** 且（库开好了 或 上限到了） */
  const gone = $derived(minDone && (ready || capDone))

  $effect(() => {
    const a = setTimeout(() => (minDone = true), 500)
    const b = setTimeout(() => (capDone = true), 800)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
  })

  $effect(() => {
    if (!gone) return
    document.getElementById('nyx-splash')?.remove()
  })
</script>
