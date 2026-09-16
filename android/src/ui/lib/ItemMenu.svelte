<script lang="ts">
  /**
   * 知识点 ⋮（Lecture 行 / 详情屏共用）—— 面孔照已批审计：
   *   分析 · 随时认读这一条 · 随时练习这一条 · 静默 / 打回轮转 · 复制知识点 · 修改 · 删除
   *   ~~移动~~：D-354 说移动=改 item_lectures 收录关系，Windows 还没有同款
   *   方法 —— 不发明第二判据，等两端一起定（行上如实说）。
   * 写动作全走 manage 的真调用；结果交给宿主的 Snackbar。
   */
  import { RESTORED_CARD, deletedItems } from './copy.ts'
  import MenuShell from './MenuShell.svelte'
  import EditItemDialog from './EditItemDialog.svelte'
  import { store } from './store.svelte.ts'
  import { practice } from './practice.svelte.ts'
  import { bulkSilence, restoreItem, softDeleteItems, undoDeleteItems } from '../../db/manage.ts'
  import { copyLines } from '../../db/manage-nodes.ts'
  import { analyseItem, analyseErrorText, hasFullAnalysis } from '../../db/analyse.ts'
  import { SILENCE_ACTIONS, TRASH_KEEP_TEXT, TRASH_DAYS } from '../../core-link.ts'

  let {
    id,
    term,
    silent = false,
    onclose,
    onwrote,
    onchanged,
    ondeleted
  }: {
    id: number
    term: string
    /** 已静默 → 给「恢复轮转」；否则给「静默」 */
    silent?: boolean
    onclose: () => void
    /** 写完把话交给宿主（Snackbar），undo 可选 */
    onwrote: (msg: string, undo?: (() => Promise<void>) | null) => void
    /**
     * ★ T-5.12 · 这一条的内容变了，请宿主重读（分析写完解析块之后）。
     * 列表宿主不必给（列表上看不出解析）；**详情屏要给**，
     * 否则解析已经写进库了，屏幕还停在「还没有完整解析」。
     */
    onchanged?: () => void | Promise<void>
    /**
     * ★ 删成功之后再喊一声（第十九则指令 §四）。
     * 列表宿主不必给 —— 重查一遍列表，那条自然就没了。
     * **详情屏必须给**：这一屏整页画的就是被删掉的那条，
     * 不退回上一级的话，数据已经删对了，屏幕还站在原地。
     */
    ondeleted?: () => void
  } = $props()


  /**
   * ★ 快照（2026-08-30 真机修）：`act` 先 onclose() —— 宿主随即把状态置空，
   * 之后闭包再读 `id`/`term` 这两个 **prop getter** 就是读 null 的属性。
   * 打开这一面时值就定了，先落成本地常量。
   */
  const iid = id
  const trm = term
  const sil = silent

  const db = (): import('../../db/types.ts').Db => (store.db as { k: 'ok'; db: import('../../db/types.ts').Db }).db

  async function act(fn: () => Promise<void>): Promise<void> {
    if (store.db.k !== 'ok') return
    onclose()
    try {
      await fn()
      await store.reloadCounts()
    } catch (e) {
      // ③ 档验收通道：真机没有 console，把栈挂出来给 eval 读
      ;(globalThis as Record<string, unknown>)['__lastErr'] = (e as Error)?.stack ?? String(e)
      onwrote(`没写成：${(e as Error)?.message ?? e}`)
    }
  }
  /** 删除确认（D-412 第一层）—— 菜单就地换脸，不叠浮层 */
  let confirming = $state(false)

  /**
   * ══ 分析 / 重新分析（T-5.12 · D-R22）═══════════════════════════
   *
   * ★ 「有没有完整解析」不在这里判 —— `hasFullAnalysis` 用的是 core 那句
   *   `NO_FULL_ANALYSIS`（「只有 summary 不算」），与讲次队列同一份。
   *   `null` = 还没问出来：那一刻按钮先禁着，不猜一个词摆上去。
   */
  let hasFull = $state<boolean | null>(null)
  let analysing = $state(false)
  $effect(() => {
    if (store.db.k !== 'ok') return
    const d = db()
    void hasFullAnalysis(d, iid)
      .then((v) => (hasFull = v))
      .catch(() => (hasFull = false)) // 问不出来就按「还没分析过」说话，不卡住入口
  })

  /**
   * ★ 这一件**不走 `act()`**：`act` 第一步就 `onclose()`，菜单当场消失 ——
   *   而分析要等 AI，几秒到几十秒。入口一关，屏幕上就没有任何「它在跑」的痕迹，
   *   那正是 I-109/I-112 那一族「点了没反应」。所以菜单留着、这一项禁用并改字，
   *   跑完再关、再把话交给 Snackbar。
   */
  async function runAnalyse(): Promise<void> {
    if (store.db.k !== 'ok' || analysing) return
    analysing = true
    try {
      const r = await analyseItem(db(), iid, { force: hasFull === true })
      onclose()
      await store.reloadCounts()
      await onchanged?.()
      onwrote(
        r.skipped
          ? '这一条已经有完整解析了'
          : `解析好了 · ${r.shown} 块${r.gloss > 0 ? ` · 释义也更新了` : ''}${
              r.sync.ran ? '' : ` · 分析前没同步上（${r.sync.note}）`
            }`
      )
    } catch (e) {
      ;(globalThis as Record<string, unknown>)['__lastErr'] = (e as Error)?.stack ?? String(e)
      onclose()
      onwrote(analyseErrorText(e))
    } finally {
      analysing = false
    }
  }

  /**
   * 「修改」（T-5.14）—— 三个字段装不进菜单那一行，所以换成 Dialog。
   * ★ 仍然是**换脸不叠层**（§10.2：一个面之内不许再出现第二个面）：
   *   开着对话框时这个菜单整个不渲染，屏幕上永远只有一个面。
   */
  let editing = $state(false)
</script>

{#if editing}
  <EditItemDialog
    id={iid}
    onclose={() => {
      editing = false
      onclose()
    }}
    ondone={(msg) => {
      onwrote(msg)
      // ★ 用 T-5.12 立的那条 `onchanged` 契约，不另造一条：
      //   「这一条的内容变了，请宿主重读」—— 改词条与写解析块是同一件事的两个来源。
      //   列表宿主不给 `onchanged`，但它们本来就在 `onwrote` 里重读，所以两处都刷得到。
      void onchanged?.()
    }}
  />
{:else}
<MenuShell {onclose}>
  {#snippet title()}<span class="term">{trm}</span>{/snippet}
  <!-- ★ T-5.12 · 放在最上面第一项（D-R22：手机也能做单条解析）。
       分析中不关菜单：这一项禁用 + 改字，是这几十秒里唯一看得见的「它在跑」。 -->
  <button class="mi" disabled={analysing || hasFull === null} onclick={() => void runAnalyse()}>
    <span class="zh">{analysing ? '分析中…' : hasFull ? '重新分析' : '分析'}</span>
  </button>
  {#if analysing}
    <div class="mnote">正在让 AI 写这一条的完整解析 —— 手改过的段落不会被覆盖。</div>
  {/if}
  <button
    class="mi"
    onclick={() => {
      onclose()
      practice.open = { kind: 'reading', ids: [iid] }
    }}><span class="zh">随时认读这一条</span></button
  >
  <button
    class="mi"
    onclick={() => {
      onclose()
      practice.open = { kind: 'production', ids: [iid] }
    }}><span class="zh">随时练习这一条</span></button
  >
  {#if sil}
    <button
      class="mi"
      onclick={() =>
        void act(async () => {
          await restoreItem(db(), iid)
          onwrote(RESTORED_CARD)
        })}><span class="zh">{SILENCE_ACTIONS.restore}</span></button
    >
  {:else}
    <button
      class="mi"
      onclick={() =>
        void act(async () => {
          await bulkSilence(db(), [iid], true)
          onwrote(`已${SILENCE_ACTIONS.shelve} 1 条`, async () => {
            await bulkSilence(db(), [iid], false)
            await store.reloadCounts()
          })
        })}><span class="zh">{SILENCE_ACTIONS.shelve}</span></button
    >
  {/if}
  <button
    class="mi"
    onclick={() =>
      void act(async () => {
        const text = await copyLines(db(), [iid])
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          // WebView 里 Clipboard API 要权限面 —— 老路子兜底（用户手势内有效）
          const ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        onwrote('已复制到剪贴板')
      })}><span class="zh">复制知识点</span></button
  >
  <!-- ★ 「修改」（T-5.14 · D-R23 已裁「可以」）：只改正文三列（词条 / 释义 / 中文释义），
       uid 不变、不新建条目、出处摘句跟着改、每改一列留一笔痕。
       归类 / 归属仍然不给（D-354 未定），删除 / 合并各有各的入口。
       ★ 放在「复制词条」之后：T-5.12 的「分析」进菜单**最上面第一项**，
         两处不挨着，合并时不撞。 -->
  <button class="mi" onclick={() => (editing = true)}><span class="zh">修改</span></button>
  <!-- ★ 「移动…」已移除（§十九 授权的减法）：它此前只能弹一句「还没接上」——
       **一个只会道歉的菜单项没有价值**，正是 D-411 点名的七个死胡同之一。
       词条的移动 = 改收录关系，D-354 明写「两端同款方法一起定」，方法未定。
       方法定了再回来，记在 docs/nyx-system/PLAN.md。 -->
  <!-- ★ D-412 第一层：删除给确认。菜单先换脸成确认态，
       不另开一个浮层压在浮层上（§10.2：一个面之内不许再出现第二个面）。 -->
  {#if !confirming}
    <button class="mi dg" onclick={() => (confirming = true)}><span class="zh">删除</span></button>
  {:else}
    <div class="mnote">
      <b>删除这一条？</b><br />移到回收站，<b>{TRASH_KEEP_TEXT}</b>。
    </div>
    <div class="mrow" style:padding="4px 16px 8px">
      <button class="btn sm sec2" onclick={() => (confirming = false)}>取消</button>
      <button
        class="btn sm dg"
        onclick={() =>
          void act(async () => {
            await softDeleteItems(db(), [iid])
            onwrote(deletedItems(1), async () => {
              await undoDeleteItems(db(), [iid])
              await store.reloadCounts()
            })
            ondeleted?.()
          })}>删除</button
      >
    </div>
  {/if}
</MenuShell>
{/if}
