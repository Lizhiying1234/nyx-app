<script lang="ts">
  /**
   * 「查重」对话框（T-9.13 · D-478②）—— **先看结果，再决定动不动手**。
   *
   * ★ 形状与文案照 Windows `renderer/src/Workbench.svelte` 那个对话框搬，
   *   只把「讲次」换成这一端的可见名 **Lecture**（`SavePicker` 的术语表就是这么写的）。
   * ★ 判据一行都不在这里：分组 / 分档 / 选主在 core（`dedup/plan.ts`），
   *   「Review 不自动处理」在 `db/merge.ts` —— 放界面的话，别的调用点绕过去
   *   不会有人发现，而后果是跨层 / 有学习史的条目被自动并掉，不可逆且他没看见。
   * ★ 复用 `Dialog.svelte` 这一个居中原语（D-393），只把内容放进它的 `children`；
   *   D-227 零样式：只用已有的类（`dlg-lab` · `li` · `g` · `m` · `tag` · `pill` · `note`）。
   */
  import Dialog from './Dialog.svelte'
  import { store } from './store.svelte.ts'
  import { dedupMerge, dedupScan, type DedupPick, type DedupReport } from '../../db/merge.ts'
  import { TRASH_KEEP_TEXT } from '../../core-link.ts'

  let {
    lectureId,
    onclose,
    ondone
  }: {
    lectureId: number
    onclose: () => void
    /** 并完了 —— 话交给宿主的 Snackbar，宿主随即刷新那一屏 */
    ondone: (msg: string) => void
  } = $props()

  let busy = $state(true)
  let err = $state<string | null>(null)
  let report = $state<DedupReport | null>(null)
  /** 刚做完那一次的回执，就显示在顶上 */
  let done = $state<string | null>(null)

  let started = false
  $effect(() => {
    if (started || store.db.k !== 'ok') return
    started = true
    void scan()
  })

  const theDb = (): import('../../db/types.ts').Db =>
    (store.db as { db: import('../../db/types.ts').Db }).db

  /** 扫描**只读**，一个字都不写 —— 打开这一面不会改任何东西 */
  async function scan(): Promise<void> {
    if (store.db.k !== 'ok') return
    busy = true
    err = null
    try {
      report = await dedupScan(theDb(), lectureId)
    } catch (e) {
      err = (e as Error)?.message ?? String(e)
    } finally {
      busy = false
    }
  }

  async function run(pick: DedupPick): Promise<void> {
    if (store.db.k !== 'ok' || busy) return
    busy = true
    err = null
    try {
      const out = await dedupMerge(theDb(), lectureId, pick)
      report = await dedupScan(theDb(), lectureId)
      done = `并掉 ${out.merged} 条，进了回收站（${TRASH_KEEP_TEXT}）`
      ondone(done)
    } catch (e) {
      err = (e as Error)?.message ?? String(e)
    } finally {
      busy = false
    }
  }
</script>

<!-- ★ 单动作形态：这一屏只有一个出路。此前传 confirm="关闭"，屏上就并排出现了
     「取消」和「关闭」两颗同义键（TM-58）。现在交给原语，只出一颗 Ghost「关闭」。 -->
<Dialog title="这个 Lecture 里的重复" input={null} single {onclose} onconfirm={onclose}>
  {#if busy}
    <div class="dlg-lab">正在看…</div>
  {:else if err}
    <div class="note" role="alert">{err}</div>
  {:else if report}
    {@const r = report}
    {#if done}<div class="dlg-lab">{done}</div>{/if}
    {#if r.groups.length === 0}
      <div class="dlg-lab">没有重复。</div>
    {:else}
      <div class="dlg-lab">
        {r.groups.length} 组 · {r.affected} 条受影响 · {r.safe} 组可安全合并 · {r.review} 组需要你看
      </div>
      <!-- ★ 一键那一档只并判据说 Safe 的组；没有就说没有，不给一个按不动的按钮找借口 -->
      <button class="pill v" disabled={r.safe === 0} onclick={() => void run({ kind: 'safe' })}>
        {r.safe === 0 ? '没有可以安全合并的' : `合并那 ${r.safe} 组`}
      </button>
      <div class="dlg-lab">合并 = 信息并到一条，另一条进回收站，{TRASH_KEEP_TEXT}。</div>

      {#each r.groups as g (g.norm)}
        <div class="sec"><span class="zh">{g.norm}</span>
          <span class="tag {g.bucket === 'safe' ? 't-v' : 't-w'}">
            {g.bucket === 'safe' ? '可安全合并' : '需要你看'}
          </span>
        </div>
        {#each g.reasons as why (why)}
          <div class="li sunkli p1"><span class="g"><small class="zh">{why}</small></span></div>
        {/each}
        {#each g.members as m (m.id)}
          <div class="li">
            <span class="g">
              <span class="zh s12">{m.gloss || '（没有释义）'}</span>
              <small class="zh">
                {m.layer} · 作答 {m.answers} · 复习 {m.reviewLogs}{m.blocks.length > 0
                  ? ` · 分析块 ${m.blocks.join('、')}`
                  : ''}
              </small>
            </span>
            {#if g.bucket === 'review'}
              <button
                class="pill"
                onclick={() =>
                  void run({
                    kind: 'one',
                    canonicalId: m.id,
                    loserIds: g.members.filter((x) => x.id !== m.id).map((x) => x.id)
                  })}>以这条为主</button
              >
            {:else if m.id === g.canonicalId}
              <span class="m">留下这条</span>
            {/if}
          </div>
        {/each}
      {/each}
    {/if}
  {/if}
</Dialog>
