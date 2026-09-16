<script lang="ts">
  /**
   * 「修改」对话框 —— 词条 / 释义 / 中文释义（T-5.14 · D-R23 已裁「可以」）。
   *
   * ★ 复用 `Dialog.svelte` 那一套（遮罩 · 居中卡 · 系统返回 = 取消 · 右对齐动作行），
   *   只是把三个输入放进它的 `children` —— 那个口子就是为「同一原语、内容不同」开的。
   *   **不新造弹窗、不加大按钮。**
   * ★ 自己去库里取这三列，而不是让 `ItemMenu` 多传两个 prop：
   *   ItemMenu 有三个宿主（详情 / 讲次 / 馆藏），加 prop 要改三处，
   *   而这三个值本来就在库里，取一次的代价比让三个宿主都认识它们小得多。
   * ★ 判据一行都不在这里：写入与校验全在 `db/edit-item.ts::editItem`，
   *   它拒绝时抛的就是给他看的那句人话，这里原样转述。
   * ★ D-227 零组件样式（`.dlg-lab` 在 mobile.css）。
   */
  import Dialog from './Dialog.svelte'
  import { store } from './store.svelte.ts'
  import { editItem } from '../../db/edit-item.ts'

  let {
    id,
    onclose,
    ondone
  }: {
    id: number
    onclose: () => void
    /** 改成了 —— 把话交给宿主的 Snackbar（宿主随即刷新） */
    ondone: (msg: string) => void
  } = $props()

  let term = $state('')
  let gloss = $state('')
  let glossZh = $state('')
  let err = $state<string | null>(null)
  let busy = $state(false)
  let started = false
  /** 三列取回来了吗 —— 取回来之前不渲染输入框（见下面那段） */
  let ready = $state(false)

  /**
   * ★★ T-5.15 · **先同步一趟，再取那三列**。
   *
   * 他要在这三个框里改的是「现在的正文」—— 如果电脑刚改过而手机还没拉，
   * 他改的就是一份过时的正文，而且改完之后合并会把两次修改叠在一起。
   * 所以打开这一面时先跑一趟自动档同步（与 `editItem` 保存前那一趟同源）。
   *
   * ★ 失败 / 跳过 **照常打开**，用本机那一版 —— 没网也得能改错字。
   * ★ 不另设超时：等的就是那一趟自己的时间。这一面**先渲染**（标题与取消/保存
   *   立刻在），只有三个输入框等值到齐才出现 —— 否则他可能在空框里先敲了字，
   *   随后被取回来的值覆盖掉（那种「我打的字没了」是最难解释的一种 bug）。
   */
  $effect(() => {
    if (started || store.db.k !== 'ok') return
    started = true
    const db = (store.db as { db: import('../../db/types.ts').Db }).db
    void (async () => {
      try {
        const { runSyncAuto } = await import('../../db/sync.ts')
        await runSyncAuto(db, '修改前同步', { gateAuto: true })
      } catch {
        // 没同步上也照常打开 —— 保存那一步还会再试一次，并把账带回来
      }
      const r = await db.get(
        `select term, gloss, gloss_zh as glossZh from items where id = ?`,
        [id]
      )
      term = String(r?.['term'] ?? '')
      gloss = String(r?.['gloss'] ?? '')
      glossZh = String(r?.['glossZh'] ?? '')
      ready = true
    })()
  })

  async function save(): Promise<void> {
    if (store.db.k !== 'ok' || busy || !ready) return
    busy = true
    err = null
    try {
      const r = await editItem((store.db as { db: import('../../db/types.ts').Db }).db, id, {
        term,
        gloss,
        glossZh
      })
      // ★ 重名不拦（合并按归一分组，改完自然落新组）—— 只提一句，让他自己去讲次页看
      // ★ T-5.15 · 保存前那一趟没跑成就如实带一句：它不阻塞保存，但他该知道
      //   「这一次是在可能过时的正文上改的」（D-400① 回执如实的同一条精神）
      ondone(
        [
          r.duplicateOf ? `改好了 —— 与「${r.duplicateOf.term}」重复了，Lecture 页可以查重` : '改好了',
          r.sync.ran ? '' : ` · 保存前没同步上（${r.sync.why ?? r.sync.note}）`
        ].join('')
      )
      onclose()
    } catch (e) {
      // 拒绝的理由本身就是给他看的那句话（空词条 / 没有改动 / 条目不在了）
      err = (e as Error)?.message ?? String(e)
    } finally {
      busy = false
    }
  }
</script>

<Dialog title="修改" input={null} confirm="保存" {onclose} onconfirm={() => void save()}>
  {#if !ready}
    <!-- ★ 值到齐之前不给输入框：先渲染这一行，比给三个空框然后把他打的字覆盖掉诚实 -->
    <div class="dlg-lab">正在取最新的…</div>
  {:else}
    <div class="dlg-lab">知识点</div>
    <!-- svelte-ignore a11y_autofocus -->
    <input class="dlg-in" bind:value={term} autofocus autocapitalize="none" autocomplete="off" />
    <div class="dlg-lab">释义</div>
    <input class="dlg-in" bind:value={gloss} autocapitalize="none" autocomplete="off" />
    <div class="dlg-lab">中文释义</div>
    <input class="dlg-in" bind:value={glossZh} autocomplete="off" />
  {/if}
  {#if err}<div class="note" role="alert">{err}</div>{/if}
</Dialog>
