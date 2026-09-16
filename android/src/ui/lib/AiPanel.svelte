<script lang="ts">
  /**
   * AI 面板（Settings · 阶段 6 真接线）—— D-202 三槽 / D-220 key / D-254 默认共用。
   *
   * ★ 判据不在这里：三槽怎么存、共用时怎么复制，全在 `db/ai.ts`（与 Windows
   *   `main/ai/config.ts` 逐字同源）。这一层只是把它摆到屏幕上。
   * ★ **key 永不回显**（D-220）：只显示「已配 / 没配」；留空提交 = 不动已存的那把。
   * ★ 服务商快填：2026-08-30 事故的直接产物 —— 只填 key 不填地址时，请求会变成
   *   一条相对 URL 打到 App 自己的本地服务器，屏幕上表现为「AI 返回乱码」。
   *   一次点满地址+模型+协议，别让人猜。
   */
  import Dialog from './Dialog.svelte'
  import { store } from './store.svelte.ts'
  import { AI_SLOTS, readAiSettings, saveAiSettings, type AiSettings } from '../../db/ai.ts'
  import { PROVIDERS, SLOT_DESC, SLOT_NAMES, type Slot } from '../../core-link.ts'

  let st = $state<AiSettings | null>(null)
  let note = $state<string | null>(null)
  let provFor = $state<Slot | null>(null)
  let dlg = $state<{ slot: Slot; field: 'base' | 'model' | 'key'; title: string; value: string } | null>(
    null
  )

  let loaded = false
  $effect(() => {
    if (store.db.k !== 'ok' || loaded) return
    loaded = true
    const db = store.db.db
    void (async () => {
      st = await readAiSettings(db)
    })()
  })

  /** 当前面板上要写回去的形状（key 一律留空 = 不动） */
  function inputOf(cur: AiSettings): { split: boolean; slots: Record<Slot, { baseUrl: string; model: string; protocol: 'auto' | 'openai' | 'anthropic' | 'gemini' }> } {
    const slots = {} as Record<Slot, { baseUrl: string; model: string; protocol: 'auto' | 'openai' | 'anthropic' | 'gemini' }>
    for (const s of AI_SLOTS) {
      slots[s] = {
        baseUrl: cur.slots[s].baseUrl,
        model: cur.slots[s].model,
        protocol: cur.slots[s].protocol
      }
    }
    return { split: cur.split, slots }
  }

  async function save(mut: (i: ReturnType<typeof inputOf>) => void, keyFor?: Slot, key?: string): Promise<void> {
    if (store.db.k !== 'ok' || st === null) return
    const input = inputOf(st)
    mut(input)
    const withKey = keyFor && key ? { ...input, slots: { ...input.slots, [keyFor]: { ...input.slots[keyFor], apiKey: key } } } : input
    try {
      st = await saveAiSettings(store.db.db, withKey as Parameters<typeof saveAiSettings>[1])
    } catch (e) {
      note = `没存成：${(e as Error)?.message ?? e}`
    }
  }

/* 分组开关已后台化（指令第十则 · D-408）：ai.split 的值仍被读取与渲染跟随，
   但不再提供切换入口 —— 分槽是 Windows 侧的高级概念。 */

  async function fill(slot: Slot, id: string): Promise<void> {
    const p = PROVIDERS.find((x) => x.id === id)
    if (!p) return
    provFor = null
    await save((i) => {
      i.slots[slot] = { baseUrl: p.baseUrl, model: p.models[0] ?? '', protocol: p.protocol }
    })
    note = `已填好 ${p.name}：${p.baseUrl} · ${p.models[0]}。key 还得你自己填（下面那行）。`
  }

  async function commit(v: string): Promise<void> {
    const d = dlg
    dlg = null
    if (!d) return
    if (d.field === 'key') {
      if (!v.trim()) return // 空提交不清 key —— 防误触；要换就填新的
      await save(() => {}, d.slot, v.trim())
      note = 'key 存进了 Android Keystore（D-220：永不上云，界面也读不回来）。'
      return
    }
    await save((i) => {
      if (d.field === 'base') i.slots[d.slot].baseUrl = v.trim()
      else i.slots[d.slot].model = v.trim()
    })
  }

  /** 面板上要显示几组：共用时只显示「重任务」那一组（它就是那一套） */
  const shown = $derived(st === null ? [] : st.split ? AI_SLOTS : (['heavy'] as Slot[]))
</script>

{#if st === null}
  <div class="m blk zh">读 AI 配置…</div>
{:else}
  {#each shown as s (s)}
    {@const cfg = st.slots[s]}
    <div class="li sunkli p1">
      <span class="g"><span class="zh s12">{st.split ? SLOT_NAMES[s] : 'AI 连接'}</span>
        <small class="zh">{st.split ? SLOT_DESC[s] : '重任务 · 轻任务 · 长上下文共用这一套'}</small></span>
    </div>
    <button class="li sunkli p2" onclick={() => (provFor = provFor === s ? null : s)}>
      <span class="g"><span class="zh s12 dim">服务商快填</span>
        <small class="zh">一下填好地址+模型+协议 —— 只填 key 是连不上的</small></span>
      <span class="arr" class:open={provFor === s}><svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
    </button>
    {#if provFor === s}
      {#each PROVIDERS as p (p.id)}
        <button class="li sunkli p2" onclick={() => void fill(s, p.id)}>
          <span class="g"><span class="zh s12 dim">{p.name}</span><small class="zh">{p.baseUrl} · {p.models[0]}</small></span>
          <span class="m">填</span>
        </button>
      {/each}
    {/if}
    <button
      class="li sunkli p2"
      onclick={() => (dlg = { slot: s, field: 'base', title: '服务地址（baseUrl）', value: cfg.baseUrl })}
    >
      <span class="g"><span class="zh s12 dim">服务地址</span></span>
      <span class="m">{cfg.baseUrl || '—'}</span>
    </button>
    <button
      class="li sunkli p2"
      onclick={() => (dlg = { slot: s, field: 'model', title: '模型', value: cfg.model })}
    >
      <span class="g"><span class="zh s12 dim">模型</span></span>
      <span class="m">{cfg.model || '—'}</span>
    </button>
    <button
      class="li sunkli p2"
      onclick={() => (dlg = { slot: s, field: 'key', title: 'API key（存进 Keystore，不回显）', value: '' })}
    >
      <span class="g"><span class="zh s12 dim">API key（→ Keystore，D-220）</span></span>
      <span class="m">{cfg.hasKey ? '已存 · 不回显' : '—'}</span>
    </button>
    {#if cfg.hasKey && (!cfg.baseUrl || !cfg.model)}
      <div class="li sunkli p2">
        <span class="g"><span class="zh s12">还差{!cfg.baseUrl ? '服务地址' : ''}{!cfg.baseUrl && !cfg.model ? '和' : ''}{!cfg.model ? '模型' : ''}</span>
          <small class="zh">只有 key 连不上 —— 用上面的服务商快填一次补齐</small></span>
        <span class="tag t-w">要补</span>
      </div>
    {/if}
  {/each}

  {#if note}<div class="li sunkli p1"><span class="g"><small class="zh">{note}</small></span></div>{/if}
{/if}

{#if dlg}
  {@const d = dlg}
  <Dialog
    title={d.title}
    input={d.value}
    allowEmpty
    confirm="存"
    onclose={() => (dlg = null)}
    onconfirm={(v) => void commit(v)}
  />
{/if}
