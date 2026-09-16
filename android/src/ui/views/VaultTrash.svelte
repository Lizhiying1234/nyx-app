<script lang="ts">
  /**
   * 回收站（①f）。
   * ★★ **④（2026-09-01）：手机也能彻底删了** —— D-359「硬删仍不给」半条被修订。
   *   使用者原话「删除必须是真正删除」，裁定走 Windows 那套：
   *   **正常删除仍是三层可撤销**（确认框 → Snackbar → 回收站，天数见 TRASH_DAYS），
   *   **彻底删除只在这一页，而且要再确认一次**（这一步没有后悔药）。
   * ★ 判据在 core/purge.ts（两端唯一一份）；这一页只负责问清楚。
   * ★ 词条恢复真写（清 deleted_at + 账本 forget('deleted')）；
   *   讲/单元/项目 = **连带恢复**（restoreCascade：父级补活 + 同批 ±2000
   *   子女 + 账本撤销 —— browse.restore 逐字），阶段 5 已接真。
   * ★ 到期自动清除是两端同一规则（D-087，天数见 core 的 TRASH_DAYS）——「打开即清」已接真：
   *   进这一页先跑 purgeExpired（core/cascade 同一份级联 + 墓碑随同步走），
   *   清了几件如实说一句。
   */
  import { CANT_READ } from '../lib/copy.ts'
  import { untrack } from 'svelte'
  import { store } from '../lib/store.svelte.ts'
  import { snacks } from '../lib/snack.svelte.ts'
  import { registerBack } from '../lib/backstack.svelte.ts'
  import { loadTrash, type TrashRow } from '../../db/vault-lists.ts'
  import { undoDeleteItems } from '../../db/manage.ts'
  import { restoreCascade } from '../../db/manage-nodes.ts'
  import { purgeExpired, purgeNow } from '../../db/purge.ts'
  import { TRASH_DAYS } from '../../core-link.ts'

  let { onback }: { onback: () => void } = $props()

  let rows = $state<TrashRow[]>([])
  let stat = $state<'loading' | 'ok' | 'error'>('loading')
  let err = $state('')
  let note = $state<string | null>(null)
  let busy = $state(false)
  /** 阶段 5：容器也可选 —— 恢复走连带级联（restoreCascade） */
  let sel = $state<{ kind: TrashRow['kind']; id: number }[]>([])

  let purgedNote = $state<number>(0)
  /** ★ 彻底删除的二次确认 —— 这一步没有后悔药，不能一按就走（D-412 的精神） */
  let confirming = $state(false)
  async function load(): Promise<void> {
    if (store.db.k !== 'ok') return
    try {
      // D-087 · 打开即清：到期的先真删（级联 + 墓碑），再列
      // ★ F-015：本机时钟看着不对就不清 —— 如实说一句，不假装清过了
      const p = await purgeExpired(store.db.db)
      purgedNote = p.purged
      note = p.skipped
      if (purgedNote > 0) await store.reloadCounts()
      rows = await loadTrash(store.db.db)
      stat = 'ok'
    } catch (e) {
      stat = 'error'
      err = (e as Error)?.message ?? String(e)
    }
  }
  $effect(() => {
    untrack(() => {
      void load()
    })
  })
  $effect(() => {
    if (sel.length === 0) return
    return registerBack(() => ((sel = []), true))
  })

  const has = (r: TrashRow): boolean => sel.some((x) => x.kind === r.kind && x.id === r.id)
  function tap(r: TrashRow): void {
    sel = has(r) ? sel.filter((x) => !(x.kind === r.kind && x.id === r.id)) : [...sel, { kind: r.kind, id: r.id }]
  }

  async function doRestore(): Promise<void> {
    if (store.db.k !== 'ok' || busy || sel.length === 0) return
    const db = store.db.db
    busy = true
    try {
      let n = 0
      const itemIds = sel.filter((x) => x.kind === 'item').map((x) => x.id)
      if (itemIds.length > 0) n += await undoDeleteItems(db, itemIds)
      for (const c of sel.filter((x) => x.kind !== 'item')) {
        // 连带：父级补活 + 同批（±2000）子女 + 账本撤销
        n += await restoreCascade(db, c.kind, c.id)
      }
      sel = []
      await store.reload()
      await load()
      await store.reloadCounts()
      snacks.show(`已恢复 ${n} 条`)
    } catch (e) {
      note = `恢复没写成：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }

  /**
   * ★★ 彻底删除（④）。和到期自动清除走的是**同一条路** —— 真删行 + 写墓碑。
   * 编排在 core/purge.ts（D-091 只删独占的 · I-119 材料不牵连知识点）。
   */
  async function doPurge(): Promise<void> {
    if (store.db.k !== 'ok' || busy || sel.length === 0) return
    const db = store.db.db
    busy = true
    confirming = false
    try {
      const n = await purgeNow(db, sel)
      sel = []
      await store.reload()
      await load()
      await store.reloadCounts()
      // ★ 不给撤销按钮 —— 这一步真的撤不回来，给一个假的按钮比不给更坏
      snacks.show(`彻底删除了 ${n} 项 —— 这一步撤不回来，清除会随同步走到电脑`)
    } catch (e) {
      note = `没删成：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }

  const KIND_ZH: Record<TrashRow['kind'], string> = {
    item: '',
    lecture: '讲',
    unit: '单元',
    project: '项目'
  }
  const fmtDay = (at: number): string => {
    const d = new Date(at)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  /**
   * ★★ 2026-09-14 真机上抓到的：这里原来写死 `30`。
   *   标题那句已经改成从 `TRASH_DAYS` 取（10 天），可这个算式没跟着改 ——
   *   于是屏上同时说两件事：上面「放 10 天」、每一行「还剩 26 天」。
   *   而真正清除的是 10 天那一档，**那一行其实 6 天后就没了**。
   * ★ 上一轮我扫的是「句子」，没扫「算术」。数字漂进代码比漂进文案更难看见。
   */
  const daysLeft = (at: number): number =>
    Math.max(0, TRASH_DAYS - Math.floor((Date.now() - at) / 86400000))
</script>

<div class="view">
  <!-- ★ 子页屏顶（与 Lecture 同一形态）：back + 坐标，标题另起一行 -->
  <div class="top" style="gap:8px">
    <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
      <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
    </button>
  </div>

  {#if note}<div class="note" role="status">{note}</div>{/if}

  <!-- ★ `trash-tiers`（清单 10）的靶子：这一行说的就是那三档里的第二档（到期自动清），
       而且它在空 / 非空 / 出错三态都在。core 那句的天数从 `TRASH_KEEP_TEXT` 拼，不写死。 -->
  <div class="m blk zh" data-guide="trash-tiers">放 {TRASH_DAYS} 天，之后自动清除 —— 两端同一规则</div>
  {#if purgedNote > 0}
    <div class="note" role="status">这次打开按 {TRASH_DAYS} 天契约清除了 {purgedNote} 行 —— 清除会随同步走到电脑。</div>
  {/if}

  {#if stat === 'error'}
    <div class="empty tight"><div class="t zh2">{CANT_READ}</div><div class="s">{err}</div></div>
  {:else if stat === 'ok' && rows.length === 0}
    <div class="empty tight">
      <div class="t zh2">回收站是空的</div>
      <div class="s">删掉的东西会在这里躺 {TRASH_DAYS} 天 —— 反悔来得及。</div>
    </div>
  {:else}
    <div class="set mt3">
      {#each rows as r (`${r.kind}-${r.id}`)}
        <div class="li">
          <button class="hit" onclick={() => tap(r)}>
            <span class="selmk" class:off={!has(r)}><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href={has(r) ? '#nyx-core' : '#nyx-core-o'} /></svg></span>
            {#if r.kind === 'item'}
              <span class="g">
                <span class="term ink2">{r.title}</span>
                <small>删于 {fmtDay(r.deletedAt)} · 还剩 {daysLeft(r.deletedAt)} 天</small>
              </span>
            {:else}
              <span class="g">
                <span class="zh s14 ink2">{KIND_ZH[r.kind]} · {r.title}</span>
                <small>删于 {fmtDay(r.deletedAt)} · 还剩 {daysLeft(r.deletedAt)} 天 · 恢复=连同父级与同批子女</small>
              </span>
            {/if}
          </button>
        </div>
      {/each}
    </div>
    {#if sel.length > 0}
      {#if confirming}
        <!-- ★ 换脸而不叠层（§10.2：一个面之内不许再出现第二个面）—— 同 ItemMenu 的做法。
             类全部沿用已有的（.mnote / .btn.sec2 / .btn.dg），不为这一处新造样式（D-227）。 -->
        <div class="mnote mt3">
          <b>彻底删除这 {sel.length} 项？</b><br />
          <!-- ★ D-412：确认文案必须说真话。这一步真的没有后悔药，就得这么写。 -->
          <b>删了就没了</b>，回收站里也不再留 —— 而且清除会随同步走到电脑。
        </div>
        <div class="pillrow">
          <button class="btn sec2" disabled={busy} onclick={() => (confirming = false)}>取消</button>
          <button class="btn dg" disabled={busy} onclick={() => void doPurge()}>确认彻底删除</button>
        </div>
      {:else}
        <div class="pillrow mt3">
          <button class="pill v" disabled={busy} onclick={() => void doRestore()}>恢复所选 · {sel.length}</button>
          <button class="pill w" disabled={busy} onclick={() => (confirming = true)}>彻底删除</button>
        </div>
      {/if}
    {/if}
  {/if}

</div>
