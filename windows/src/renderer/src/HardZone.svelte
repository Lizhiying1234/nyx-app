<script lang="ts">
  import { GRADE_NAMES } from '@core/types.ts'
  import Skel from './Skel.svelte'
  import type { HardRow } from '@shared/api.ts'
  import { cleanMessage } from '@shared/api.ts'
  import SelBar from './SelBar.svelte'
  import Ic from './Ic.svelte'
  import SrcBadge from './SrcBadge.svelte'
  import { say } from './toast.svelte.ts'
  import { askGuide } from './guide.svelte.ts'

  let {
    onpractice,
    onopen,
    /** I-098 · 勾选之后的两个测试入口，和知识库那边同一套 */
    onpracticeItems,
    onreading
  }: {
    onpractice?: () => void
    onopen?: (id: number) => void
    onpracticeItems?: (ids: number[]) => void
    onreading?: (ids: number[]) => void
  } = $props()

  /** I-098 · 攻坚区的 .ck 一直是死的占位符 —— 现在真的能勾 */
  let selected = $state<number[]>([])
  const toggleSel = (id: number): void => {
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
  }

  type View = { k: 'loading' } | { k: 'error'; message: string } | { k: 'ok'; rows: HardRow[] }

  let view = $state<View>({ k: 'loading' })
  let openId = $state<number | null>(null)

  /**
   * ★ 屏上按 0 起数，core 那份按档位 1–4 记 —— 这里只转位置，**不再抄一遍字**（R-02）。
   *   以前这一行是 `['用错', '可懂但不地道', …]`，和 `core/types.ts` 各写一份；
   *   改档位名的时候必漏一处，而且没有任何东西会报错。
   */
  const GRADES = [GRADE_NAMES[1], GRADE_NAMES[2], GRADE_NAMES[3], GRADE_NAMES[4]]

  async function load(): Promise<void> {
    view = { k: 'loading' }
    try {
      const rows = await window.nyx.study.hardList()
      view = { k: 'ok', rows }
      /**
       * D-484 · B-7 · **进了攻坚区这一页就讲一句它是什么**（I-190 改的就是这里）。
       *
       * ★ 原来的条件是 `rows.length > 0`（「真有条目才讲」）—— 听着有道理，
       *   实测却是**永远不讲**：他点进攻坚区的时候多半是空的（那是好事），
       *   而等到真有条目那天，他早就自己进来看过好几回了。
       *   「第一次容易不理解」说的是**这一页是什么**，不是「这一行是什么」。
       * ★ 放在读完之后：页头虽然常在，但和别处保持同一种写法 ——
       *   页面自己说「我这儿碰到 X 了」，出不出不归这里判。
       */
      void askGuide('vault-hard')
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }
  load()

  /**
   * 这一页该给的是**横向视角** —— 这几条的共同点是什么（C-005）。
   * 单条的完整诊断在词条详情里已经有了，在列表里再摊一遍只会让人一直往下滑。
   *
   * AI 诊断（D-097）还没接，所以这里先做**能算出来的那部分**：
   * 按标注标签统计，把反复出现的错误类型摆出来。这不是 AI 写的分析，
   * 但它是真数据，而且是「这 6 条为什么都卡住」这个问题的第一层答案。
   */
  const shared = $derived.by(() => {
    if (view.k !== 'ok') return []
    const tally = new Map<string, number>()
    for (const r of view.rows) {
      for (const h of r.history) {
        for (const l of h.labels) tally.set(l, (tally.get(l) ?? 0) + 1)
      }
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])
  })

  /** 诊断存的是 JSON，坏了也不能把整页拖垮 */
  function parseDiag(raw: string): { pattern: string; drill?: string } | null {
    try {
      const d = JSON.parse(raw) as { pattern?: string; drill?: string }
      return d.pattern ? { pattern: d.pattern, drill: d.drill } : null
    } catch {
      return null
    }
  }

  const LABEL_ZH: Record<string, string> = {
    collocation: '搭配',
    register: '语域',
    grammar: '语法',
    nuance: '分寸'
  }
</script>

<div class="vh" data-guide="vault-hard">
  <h1>攻坚区</h1>
  <span class="c">{view.k === 'ok' ? `${view.rows.length} 条` : ''}</span>
  <div class="sp"></div>
  {#if view.k === 'ok' && view.rows.length > 0}
    <!-- BUTTON_SYSTEM 8.1：攻坚区这颗归 **Secondary 小号**（不是 Primary —— 这一屏的主动作不在这里）-->
    <button class="btn sm sec" data-testid="hard-practice" onclick={() => onpractice?.()}>测试</button>
  {/if}
</div>

{#if view.k === 'error'}
  <div class="errbox" data-testid="hard-error">
    <div class="h">攻坚区打不开</div>
    <div>{view.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={load}>重试</button></div>
  </div>
{:else if view.k === 'loading'}
  <div class="card blk"><Skel rows={5} widths={['w100', 'w85', 'w100', 'w70', 'w85']} testid="hard-skel" /></div>
{:else if view.rows.length === 0}
  <!-- D-184 第②类空状态：「空是好事」，说一句肯定的话，**不给按钮** -->
  <div class="empty" data-testid="hard-empty">
    <div class="i">✦</div>
    <h4>攻坚区是空的</h4>
    <p>没有卡住的知识点。这是好事。</p>
  </div>
{:else}
  {#if shared.length > 0}
    <div class="xdiag" data-testid="hard-shared">
      <div class="h">这 {view.rows.length} 条的共同点</div>
      <p>
        反复出现的错误类型：{#each shared as [label, n], i (label)}{i > 0 ? ' · ' : ''}<b
            >{LABEL_ZH[label] ?? label}</b
          >
          {n} 次{/each}。
        <br />
        <span class="dim"
          >一条练了 5 次还不过，再练第 6 次大概率还是不过 —— 因为重复的是同一个错误。
          所以攻坚区先看错在哪，再针对性出题。</span
        >
      </p>
    </div>
  {/if}

  <SelBar
    ids={selected}
    allIds={view.k === 'ok' ? view.rows.map((x) => x.id) : []}
    onselectall={(next) => (selected = next ?? [])}
    onclear={() => (selected = [])}
    onchanged={async (note) => {
      say(note)
      selected = []
      await load()
    }}
    onreading={onreading}
    onpractice={onpracticeItems}
  />

  <div data-testid="hard-rows">
    {#each view.rows as r (r.id)}
      <div
        class="lrow"
        class:sel={selected.includes(r.id)}
        role="button"
        tabindex="0"
        data-testid="hard-row-{r.id}"
        onclick={() => (openId = openId === r.id ? null : r.id)}
        onkeydown={(e) => e.key === 'Enter' && (openId = openId === r.id ? null : r.id)}
      >
        <span>
          {#if r.recollected > 0}
            <SrcBadge kind="recollected" count={r.recollected} />
          {/if}
        </span>
        <!-- I-098 ·「所有词条都有复选框可以点击」。这个 .ck 一直是死的占位符 -->
        <span
          class="ck"
          role="checkbox"
          aria-checked={selected.includes(r.id)}
          tabindex="0"
          aria-label="选中 {r.term}"
          data-testid="ck-{r.id}"
          onclick={(e) => {
            e.stopPropagation()
            toggleSel(r.id)
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation()
              toggleSel(r.id)
            }
          }}
        ><Ic n="check" s={10} /></span>
        <span class="lt">{r.term}</span>
        <span class="lg">{r.gloss || '—'}</span>
        <span class="ln p">{r.attempts} 次</span>
        <button
          class="dt3 xbtn"
          title="打开知识点"
          aria-label="打开知识点 {r.term}"
          data-testid="hard-open-{r.id}"
          onclick={(e) => {
            e.stopPropagation() // 整行是「展开历次作答」，这个按钮才是「进详情」
            onopen?.(r.id)
          }}><Ic n="caret" s={12} /></button
        >
      </div>

      {#if openId === r.id}
        <!-- M-032 · 一条练了 5 次还不过，再练第 6 次大概率还是不过 ——
             因为重复的是同一个错误。**攻坚区必须告诉你错在哪。** -->
        {#if r.diagnosis}
          {@const d = parseDiag(r.diagnosis)}
          {#if d}
            <div class="diag" data-testid="hard-diag-{r.id}">
              <div class="h">这一条为什么反复错</div>
              <p>{d.pattern}</p>
              {#if d.drill}
                <p style="margin-top:6px">
                  <b>下次要做对的：</b><span>{d.drill}</span>
                  <span class="dim"> —— 这句会出现在攻坚区的题面上</span>
                </p>
              {/if}
            </div>
          {/if}
        {:else}
          <div class="dim" style="padding:6px 0 10px 33px;font-size:var(--fs-2)">
            还没有诊断。<b>练完一轮就会有</b> —— 诊断在结算时顺便生成，不额外花钱。
          </div>
        {/if}

        <div class="evo" data-testid="hard-history-{r.id}">
          {#if r.history.length === 0}
            <div class="dim" style="padding:8px 0 12px 33px;font-size:var(--fs-2)">
              还没有记录在案的作答。
            </div>
          {:else}
            {#each r.history as h, i (i)}
              <div class="ev a{h.grade}">
                <div class="m">
                  <span>{new Date(h.at).toLocaleDateString('zh-CN')}</span>
                  <span class="gr a{h.grade}">{GRADES[h.grade - 1]}</span>
                  {#each h.labels as l (l)}<span>{LABEL_ZH[l] ?? l}</span>{/each}
                </div>
                <div class="s">{h.text}</div>
              </div>
            {/each}
          {/if}
          <div class="dim" style="padding:4px 0 12px 33px;font-size:var(--fs-2)">
            出自 {r.lectureName ?? '—'} · 进过攻坚区 {r.hardEntries} 次{#if r.hardEntries >= 2}
              · <b>进过两次以上，值得复核判层</b>{/if}
          </div>
        </div>
      {/if}
    {/each}
  </div>

  <div style="font-size:var(--fs-2);color:var(--muted);margin-top:14px">
    点任意一行展开历次作答 · 攻出去的条件是 3 连正确，然后<b>回原 lecture 继续在练，不直接算练成</b>
  </div>
{/if}
