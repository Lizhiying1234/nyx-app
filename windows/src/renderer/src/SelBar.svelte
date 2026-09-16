<script lang="ts">
  import { SILENCE_ACTIONS } from '@core/silence.ts'
  import Dialog from './Dialog.svelte'
  import { TRASH_KEEP_TEXT } from '@core/sql/trash.ts'
  import { sayUndo } from './toast.svelte.ts'
  import { cleanMessage } from '@shared/api.ts'
  import { selectAllState, toggleSelectAll } from '@core/selection.ts'

  /**
   * 勾选之后的操作栏 · I-097 / I-098
   *
   * 使用者：「所有词条都有复选框可以点击，点击某几个之后，在下方可以出现
   *          测试（2 个）、导出、删除、静默等等功能。」
   *
   * **所有**是关键词。以前只有综合知识库那一份是真的能勾 ——
   * 讲次工作台和攻坚区的 `.ck` 是从总原型抄过来的**死占位符**：
   * 画着一个方框，点上去什么都不会发生。上传库改成 `.ur` 之后干脆连方框都没了。
   *
   * 所以抽成一个组件，四处共用同一套动作，行为一致：
   * 知识库 · 讲次工作台 · 攻坚区 · 我的上传库。
   */
  let {
    ids,
    /**
     * ★ T-9.15 · 这一屏**现在列着**的全部 id（不是库里全部）——「全选」只对眼前这一屏说话。
     *   不给就没有那颗按钮：不是每一屏都适合全选（比如筛出来一半的列表）。
     */
    allIds,
    /** 全选 / 取消全选。判据在 `@core/selection.ts`（两端一份） */
    onselectall,
    /** 静默库里给的是「打回轮转」，别处给「静默」 */
    silentScope = false,
    /** 上传库装的是整句，不出产出题（D-006）—— 那一栏不给「产出练习」 */
    allowPractice = true,
    onchanged,
    onreading,
    onpractice,
    onclear
  }: {
    ids: number[]
    allIds?: number[]
    onselectall?: (next: number[] | null) => void
    silentScope?: boolean
    allowPractice?: boolean
    onchanged: (note: string) => Promise<void> | void
    onreading?: (ids: number[]) => void
    onpractice?: (ids: number[]) => void
    onclear: () => void
  } = $props()

  let busy = $state(false)

  /**
   * ★ B5 · 批量删除**在这之前一句都不问就删了**（IX-13 / BTN-Q4：软删一律先弹确认框）。
   *   放在 SelBar 里而不是三个调用方各写一份 —— 知识库 · 讲次工作台 · 攻坚区 · 上传库
   *   四处共用这一栏，确认框也该只有一份（X-09「三种确认形态收成一种」）。
   */
  let askDel = $state(false)

  async function run(
    action: 'del' | 'A' | 'B' | 'silence' | 'unsilence' | 'export' | 'copy'
  ): Promise<void> {
    // `[...ids]` 不能省：ids 来自上层的 $state，是 Proxy，过不了 contextBridge
    const list = [...ids]
    if (list.length === 0 || busy) return
    busy = true
    try {
      if (action === 'del') {
        await window.nyx.study.bulkDelete(list)
        await onchanged('')
        // ★ BTN-Q5 · 删完给 6 秒撤销：确认框防误点、撤销条防手快、回收站防隔日反悔
        sayUndo(
          `${list.length} 条移到回收站，${TRASH_KEEP_TEXT}`,
          async () => {
            await window.nyx.browse
              .restoreMany(list.map((id) => ({ kind: 'item' as const, id })))
              .catch((e) => {
                throw new Error(`没能恢复：${cleanMessage(e)}`)
              })
            await onchanged('')
          },
          `${list.length} 条已从回收站恢复`
        )
      } else if (action === 'silence' || action === 'unsilence') {
        await window.nyx.study.bulkSilence(list, action === 'silence')
        await onchanged(
          action === 'silence'
            ? `${list.length} 条${SILENCE_ACTIONS.shelve}：不再排进练习，进度原样保留。`
            : `${list.length} 条${SILENCE_ACTIONS.restore}了。`
        )
      } else if (action === 'export') {
        const p = await window.nyx.exp.notesForItems(list, `Nyx 挑出的 ${list.length} 条`)
        await onchanged(p ? `笔记写在：${p}` : '取消了。')
      } else if (action === 'copy') {
        const rows = await window.nyx.study.termsOf(list)
        await navigator.clipboard.writeText(
          rows.map((r) => `${r.term}　${r.gloss ?? ''}`.trim()).join(String.fromCharCode(10))
        )
        // 5.2 · 复制成功不再回话 —— 剪贴板里有没有他自己一试就知道。
        // 但这里要清掉选中态，所以还是要调 onchanged，只是不带话
        await onchanged('')
      } else {
        await window.nyx.study.bulkSetLayer(list, action)
        await onchanged(`${list.length} 条改成了${action === 'B' ? '写作层' : '理解层'}。`)
      }
    } catch (err) {
      await onchanged(`没做成：${cleanMessage(err)}`)
    } finally {
      busy = false
    }
  }
</script>

{#if ids.length > 0}
  <div class="selbar" data-testid="selbar" style="flex-wrap:wrap;row-gap:8px">
    <span>已选 <span class="n">{ids.length}</span> 条</span>
    <!--
      ★★ T-9.15 · 全选三态。**字面由 core 判据决定**（`@core/selection.ts`，两端一份）：
        选了一部分 → 「全选这 N 条」· 全选了 → 「取消全选」（＝退出多选）。
        判据错的时候界面不报错，只会**说错话**：明明只选了 3 条，按钮写着「已全选这 20 条」。
    -->
    {#if allIds && allIds.length > 0}
      {@const st = selectAllState(ids, allIds)}
      <button
        data-testid="bulk-all"
        onclick={() => onselectall?.(toggleSelectAll(ids, allIds))}
        >{st === 'all' ? '取消全选' : `全选这 ${allIds.length} 条`}</button
      >
    {/if}
    <button data-testid="bulk-none" onclick={onclear}>取消选择</button>
    <span class="sp"></span>
    <button data-testid="bulk-export" disabled={busy} onclick={() => run('export')}>导出</button>
    <button data-testid="bulk-copy" disabled={busy} onclick={() => run('copy')}>复制</button>
    <button data-testid="bulk-b" disabled={busy} onclick={() => run('B')}>改为写作层</button>
    <button data-testid="bulk-a" disabled={busy} onclick={() => run('A')}>改为理解层</button>
    {#if silentScope}
      <button data-testid="bulk-unsilence" disabled={busy} onclick={() => run('unsilence')}
        >{SILENCE_ACTIONS.restore}</button
      >
    {:else}
      <button data-testid="bulk-silence" disabled={busy} onclick={() => run('silence')}
        >{SILENCE_ACTIONS.shelve}</button
      >
    {/if}
    <button data-testid="bulk-del" disabled={busy} onclick={() => (askDel = true)}>删除</button>
    {#if onreading}
      <!-- ★ 文案按术语表：TM-42「测试」退役（它就是产出练习）· TM-43 随时认读 / 随时练习 -->
      <button data-testid="bulk-reading" onclick={() => onreading?.([...ids])}>随时认读</button>
    {/if}
    {#if onpractice && allowPractice}
      <button class="go" data-testid="bulk-practice" onclick={() => onpractice?.([...ids])}
        >随时练习 ›</button
      >
    {/if}
  </div>
{/if}

<!-- ★ B5 · 批量删除的确认框。标题带上条数（对象名就是「这 N 条」），
     正文说真正会发生什么 —— **不写「不可撤销」**，因为那是假的。 -->
{#if askDel}
  <Dialog
    testid="bulk-del-dlg"
    title={`删除这 ${ids.length} 条知识点？`}
    body={`移到回收站，${TRASH_KEEP_TEXT}。它们的练习记录跟着一起走。`}
    confirmLabel="删除"
    danger
    busy={busy}
    onconfirm={() => {
      askDel = false
      run('del')
    }}
    oncancel={() => (askDel = false)}
  />
{/if}
