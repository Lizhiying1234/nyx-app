<script lang="ts">
  /**
   * 朗读面板（Settings › Speech · D-466）。
   *
   * ★★ 使用者 2026-09-07「语音设置简化」：这一页只剩**两个开关**（默认都开）
   *   加上口音、语速、试听，与一行「上次读的是谁、为什么」。
   *   厂商 / 地址 / 密钥 / 模型 / 音色 / 测试 / 云端列表全删。
   *
   * ★ 判据不在这里：偏好默认与夹取在 `db/voice.ts::ttsPrefs`（与 Windows
   *   `Tts.settings()` 同源）；顺序（词典 → 系统）由 core 排、`db/voice.ts` 装。
   * ★ D-227 零样式：只用已有的类（`li hit` · `g` · `m` · `sunkli`），结构不动。
   */
  import Dialog from './Dialog.svelte'
  import { store } from './store.svelte.ts'
  import { lastEngine, lastTrace, speak, ttsPrefs, type TtsPrefs } from '../../db/tts.ts'
  import { prefSet } from '../../db/prefs.ts'
  import { loadSwitches, setSwitch, type VoiceSwitches } from '../../db/voice.ts'
  // ★ 两档人看的名字来自 core（`SOURCE_LABEL`）：设置页这两行、下面那行诊断、
  //   以及 Windows 那侧的日志读的是**同一份字符串** —— 各拼各的迟早漂成两个说法
  import { SOURCE_LABEL } from '../../core-link.ts'

  let p = $state<TtsPrefs | null>(null)
  let sw = $state<VoiceSwitches | null>(null)
  let note = $state<string | null>(null)
  let rateDlg = $state(false)

  let loaded = false
  $effect(() => {
    if (store.db.k !== 'ok' || loaded) return
    loaded = true
    const db = store.db.db
    void (async () => {
      p = await ttsPrefs(db)
      sw = await loadSwitches(db)
    })()
  })

  async function put(key: string, value: string): Promise<void> {
    if (store.db.k !== 'ok') return
    try {
      await prefSet(store.db.db, key, value)
      p = await ttsPrefs(store.db.db)
    } catch (e) {
      note = `没存成：${(e as Error)?.message ?? e}`
    }
  }

  /** 翻一档。**界面显示的是落库之后读回来的那一份** —— 存不下就说出来，不假装翻了 */
  async function flip(id: keyof VoiceSwitches): Promise<void> {
    if (store.db.k !== 'ok' || !sw) return
    note = null
    try {
      sw = await setSwitch(store.db.db, id, !sw[id])
    } catch (e) {
      note = `没存成：${(e as Error)?.message ?? e}`
    }
  }

  async function hear(): Promise<void> {
    if (store.db.k !== 'ok') return
    note = null
    const n = await speak(store.db.db, 'Welcome to Nyx. This is how I sound.')
    note = n || said()
  }

  /** 上次读的是谁、为什么（账本一行，D-219 他能贴给我看） */
  function said(): string {
    const who = lastEngine ? SOURCE_LABEL[lastEngine] : null
    if (!who) return '这一次没读出来。'
    const skipped = (lastTrace?.steps ?? [])
      .filter((s) => s.source !== lastEngine && s.reason)
      .map((s) => `${SOURCE_LABEL[s.source]}：${s.reason}`)
    return `上次读的是${who}${skipped.length ? `（${skipped.join('、')}）` : ''}。`
  }
</script>

{#if p === null || sw === null}
  <div class="m blk zh">读朗读配置…</div>
{:else}
  <!-- ★ 一级动作行（DS §10.2c/d）：标签用 --ink，右边补 caret —— 这几行都是可点的 -->
  <!-- ★ T-4.21（D-471）：这里原来有个组头 `Voice`。它和一级入口 `Speech` 是
       **同一个东西的两个名字**，而二级页不写页名（D-418/D-419），所以进来之后
       屏幕上只剩 Voice —— 点进「Speech」看到的却是「Voice」。
       组头是给「一页里几段」用的（SyncPanel 的 Connection / Status / Preferences），
       这一页只有一段，组头就是把页名写了第二遍。删掉它，名字只留入口那一个。
       ★ 若使用者更想要 Voice 这个词，改的是 `Settings.svelte` 的入口表那一行，仍只有一处。 -->
  <button class="li hit" onclick={() => void flip('dictionary')}>
    <span class="g"><span class="zh s12">{SOURCE_LABEL.dictionary}</span>
      <small class="zh">词典自己带的真人音。有就先用它</small></span>
    <span class="zh s12">{sw.dictionary ? '开' : '关'}</span>
    <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
  </button>
  <button class="li hit" onclick={() => void flip('system')}>
    <span class="g"><span class="zh s12">{SOURCE_LABEL.system}</span>
      <small class="zh">这台手机自带的朗读。没有词典音时用它</small></span>
    <span class="zh s12">{sw.system ? '开' : '关'}</span>
    <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
  </button>
  <button class="li hit" onclick={() => void put('tts.accent', p!.accent === 'en-GB' ? 'en-US' : 'en-GB')}>
    <span class="g"><span class="zh s12">口音</span>
      <small class="zh">点一下在 英 / 美 之间切</small></span>
    <span class="m">{p.accent}</span>
    <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
  </button>
  <button class="li hit" onclick={() => (rateDlg = true)}>
    <span class="g"><span class="zh s12">语速</span>
      <small class="zh">0.7 – 1.3</small></span>
    <span class="m">{p.rate}×</span>
    <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
  </button>
  <button class="li hit" onclick={() => void hear()}>
    <span class="g"><span class="zh s12">试听</span></span>
    <svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--violet)"><use href="#nyx-speak" /></svg>
  </button>
  {#if note}<div class="li sunkli p1"><span class="g"><small class="zh">{note}</small></span></div>{/if}
{/if}

{#if rateDlg && p}
  <Dialog
    title="语速（0.7 – 1.3）"
    input={String(p.rate)}
    confirm="存"
    onclose={() => (rateDlg = false)}
    onconfirm={(v) => {
      rateDlg = false
      const n = Number(v)
      if (!Number.isFinite(n)) { note = '要一个数，比如 1 或 1.2。'; return }
      void put('tts.rate', String(Math.max(0.7, Math.min(1.3, n))))
    }}
  />
{/if}
