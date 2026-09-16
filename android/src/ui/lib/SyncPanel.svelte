<script lang="ts">
  /**
   * 同步面板（Settings · 阶段 3 真接线）。
   *
   * ★ 引擎/判据 = core/sync/engine.ts（两端同一份）；这里只是把
   *   config/status/run 摆到屏幕上。零确认动作 + 结果如实回显（D-379/D-262）。
   * ★★ v35 话术（D-355 定死要出现在界面上）：结构指纹不合时**整包被拒但
   *   不丢数据** —— 没收的包不标 applied，两端版本一致后自动重来。
   * ★ 密码进 Android Keystore（D-220 · P1-1）—— settings 表里没有它。
   * ★ ~~冲突不静默覆盖（D-201）：报出来，给「用本地 / 用云端」两键。~~
   *   **D-438 之后走不到了** —— 两边都改过一律按时间新的那版定，不问他；
   *   被盖掉的那一版落进 `ops_log`（`sync-override`），同步结果那行会说一句。
   *   两键与 `conflictNote` **留着没删**：他要是改主意，改回 `decideRow` 就行。
   */
  import { untrack } from 'svelte'
  import Toggle from './Toggle.svelte'
  import { registerBack } from './backstack.svelte.ts'
  import Dialog from './Dialog.svelte'
  import { store } from './store.svelte.ts'
  import { syncEngine, runSyncNow, autoAfterPractice, setAutoAfterPractice } from '../../db/sync.ts'
  import type { EngineStatus, SyncConfig } from '../../core-link.ts'
  import Icon from './Icon.svelte'

  let st = $state<EngineStatus | null>(null)
  let busy = $state<string | null>(null) // 正在做的那件事的标签
  let note = $state<string | null>(null)
  let conflictNote = $state<string | null>(null)
  let autoPractice = $state(false)
  let menu = $state<'kind' | null>(null)
  let dlg = $state<{ field: 'url' | 'user' | 'secret'; title: string; value: string } | null>(null)
  let showProblems = $state(false)

  const engine = () => (store.db.k === 'ok' ? syncEngine(store.db.db) : null)

  async function refresh(): Promise<void> {
    const e = engine()
    if (!e) return
    try {
      st = await e.status()
      if (store.db.k === 'ok') {
        autoPractice = await autoAfterPractice(store.db.db)
        autoOpen = await syncEngine(store.db.db).auto()
      }
    } catch (err) {
      note = `读不出同步状态：${(err as Error)?.message ?? err}`
    }
  }
  $effect(() => {
    untrack(() => {
      void refresh()
    })
  })
  $effect(() => {
    if (menu === null) return
    return registerBack(() => ((menu = null), true))
  })

  async function saveField(field: 'kind' | 'url' | 'user' | 'secret', value: string): Promise<void> {
    const e = engine()
    /**
     * ★ 原来这里是一句光秃秃的 `return` —— 存不上时**屏幕上什么都不会发生**。
     *   ⑦① 那条 bug 之所以查了很久，一半原因就是它没留下任何痕迹。
     *   走不下去就说一句：不许有「点了没反应」。
     */
    if (!e || !st) {
      note = '库还没打开，先等一下再改。'
      return
    }
    const c: SyncConfig = {
      kind: st.kind,
      url: st.url,
      user: st.user,
      secret: '' // 空 = 不动 Keystore 里那份（engine.saveConfig 只在非空时写）
    }
    if (field === 'secret') c.secret = value
    else c[field] = value as never
    busy = '保存'
    try {
      await e.saveConfig(c)
      await refresh()
      note = field === 'secret' ? '密码已进 Keystore —— settings 表里没有它（D-220）。' : null
    } catch (err) {
      note = `没存上：${(err as Error)?.message ?? err}`
    } finally {
      busy = null
    }
  }

  /**
   * 离线态逐处说清（阶段 7 第四件）：连接类失败不许把英文原话甩上屏 ——
   * 说三件事：为什么要网络 · 现在连不上 · 数据安不安全。只包显示层，
   * 判据（core 的错误与留痕）一个字不动；非连接类错误原样给。
   */
  function humanSyncErr(err: unknown): string {
    const raw = (err as Error)?.message ?? String(err)
    if (/failed to connect|econnrefused|enetunreach|etimedout|timeout|unable to resolve|no address|network is unreachable|connection|socket/i.test(raw)) {
      return (
        '连不上云端 —— 同步要经网络到你的 WebDAV。请检查网络，或确认云端那台是否已开启。\n' +
        '你的记录都在本机：没送出去的包不会标成已处理，连上后自动补上。\n' +
        `（原话：${raw.slice(0, 120)}）`
      )
    }
    return raw
  }

  async function doTest(): Promise<void> {
    const e = engine()
    if (!e) return
    busy = '测试'
    note = null
    try {
      await e.test()
      note = '连上了 —— 云端目录可读可写。'
    } catch (err) {
      note = humanSyncErr(err)
    } finally {
      busy = null
    }
  }

  async function doRun(resolve?: 'local' | 'remote'): Promise<void> {
    if (store.db.k !== 'ok') return
    busy = '同步'
    note = null
    conflictNote = null
    try {
      const r = await runSyncNow(store.db.db, resolve ? '冲突裁决后的同步' : '手动同步', resolve)
      note = r.lastNote
      conflictNote = r.conflictNote ?? null
      if ((r.rejected ?? 0) > 0) {
        // ★★ v35 协调发布的那句话（D-355）—— 不说这句会以为「同步坏了」
        note += '\n被拒的包一条数据都没丢：同样不标已处理，两端版本一致后自动重来。'
      }
      await refresh()
      await store.reload()
    } catch (err) {
      note = `这一次没同步成：${humanSyncErr(err)}`
      await refresh()
    } finally {
      busy = null
    }
  }

  let autoOpen = $state<boolean | null>(null)
  /** 自动同步开关的第三态：正在写设置（ST-Q6） */
  let autoBusy = $state(false)

  /** 指令第十则 §一（合并）：「打开时同步」与「练完上传」是同一概念的两半 ——
   *  一个开关一起翻（底下仍是 D-347 与 D-249 各自的存储，判据不动）。 */
  /**
   * ★ 三态（ST-Q6 · B3）：这两个 await 之间开关上什么都不发生，
   *   而这正是使用者点第二下的那一秒。现在它停在「正在生效」，期间点不动。
   * ★ 脸在**写成之后**才改（本来就是这个顺序），失败就不改 —— 再补一句人话。
   */
  async function toggleAuto(): Promise<void> {
    if (store.db.k !== 'ok' || autoOpen === null || autoBusy) return
    const next = !autoOpen
    const e = syncEngine(store.db.db)
    autoBusy = true
    try {
      await e.setAuto(next)
      await setAutoAfterPractice(store.db.db, next)
      autoOpen = next
      autoPractice = next
      note = next
        ? '自动同步：开 —— 打开 App 顺手同一次，练完自动上传。'
        : '自动同步：关 —— 全手动。'
    } catch (err) {
      note = `没改成：${(err as Error)?.message ?? String(err)} —— 开关没动，再试一次。`
    } finally {
      autoBusy = false
    }
  }

  const KINDS: [SyncConfig['kind'], string][] = [
    ['off', '不同步'],
    ['webdav', 'WebDAV（坚果云 / Nextcloud / 群晖）'],
    ['supabase', 'Supabase 存储桶']
  ]
  const kindLabel = (k: string): string => KINDS.find(([v]) => v === k)?.[1] ?? k
  const short = (s: string, n = 22): string => (s.length > n ? s.slice(0, n) + '…' : s)
  const fmtAt = (at: number): string => {
    if (!at) return '还没同步过'
    const d = new Date(at)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
</script>

{#if note}<div class="note" role="status" style:white-space="pre-line">{note}</div>{/if}

{#if st === null}
  <div class="m blk zh">读同步状态…</div>
{:else}
  <!-- ══ 三个分区（DS §10.2c · 2026-09-01）══════════════════════
       此前七行一视同仁、六行满幅灰。分区把「连接配置 / 当前状况 / 偏好」
       三组分开；灰底收回二级从属行（§10.2d）。
       ★ 下面四行**是可点的**（点开弹窗改），所以必须长成动作行 ——
         此前它们穿着只读行的衣服（--mute 标签 + 无 caret），
         正好违反 §〇「能点的和不能点的必须一眼分得出」。 -->
  <div class="sec">Connection</div>
  <button class="li hit" onclick={() => (menu = 'kind')}>
    <span class="g"><span class="zh s12">方式</span></span>
    <span class="m">{kindLabel(st.kind)}</span>
    <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
  </button>
  <button
    class="li hit"
    onclick={() => (dlg = { field: 'url', title: st?.kind === 'supabase' ? '项目 URL' : 'WebDAV 目录地址', value: st?.url ?? '' })}
  >
    <span class="g"><span class="zh s12">地址</span></span>
    <span class="m">{st.url ? short(st.url, 18) : '—'}</span>
    <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
  </button>
  <button
    class="li hit"
    onclick={() => (dlg = { field: 'user', title: st?.kind === 'supabase' ? '桶名' : '账号', value: st?.user ?? '' })}
  >
    <span class="g"><span class="zh s12">{st.kind === 'supabase' ? '桶名' : '账号'}</span></span>
    <span class="m">{st.user || '—'}</span>
    <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
  </button>
  <button
    class="li hit"
    onclick={() => (dlg = { field: 'secret', title: st?.kind === 'supabase' ? 'anon key' : '应用密码', value: '' })}
  >
    <span class="g"><span class="zh s12">密码</span>
      <small class="zh">进 Keystore，永不回显（D-220）</small></span>
    <span class="m">{st.hasSecret ? '已存' : '—'}</span>
    <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
  </button>

  <!-- ★★ 只读行：云端布局（⑦② · 2026-09-01）。
       使用者问「Bucket 如何划分」这件事本身说明**界面没把它说清楚** ——
       一个只写「桶名」的输入框，看不出桶里到底有什么。
       结论是**不拆**（理由记在 sync/SYNC_OVERVIEW.md），所以这里如实写出
       一个桶里的三条前缀，让「不拆」这件事在屏幕上看得见。 -->
  <div class="li ro">
    <span class="g">
      <span class="zh s12">云端布局</span>
      <small class="mono">nyx/chunks · nyx/devices · nyx/audio · nyx/splash</small>
    </span>
  </div>
  <div class="m blk zh">一个桶，三条前缀 —— 变更包 · 各机水位 · 朗读缓存。桶名留空就是 <b>nyx</b>。</div>

  <!-- ★ 只读行：机器的事实。没有 caret、按下去没有反应（§10.2c） -->
  <div class="sec">Status</div>
  <div class="li ro">
    <span class="g"><span class="zh s12">上次同步</span></span>
    <span class="m">{fmtAt(st.lastAt)}</span>
  </div>
  <div class="li ro">
    <span class="g"><span class="zh s12">待上传</span></span>
    <span class="m">{st.pending} 行</span>
  </div>

  {#if st.problems.length > 0}
    <button class="li hit" onclick={() => (showProblems = !showProblems)}>
      <span class="g"><span class="zh s12" style:color="var(--warn)">上次没完全成功 · {st.problems.length} 条</span>
        <small class="zh">点开看是哪几行</small></span>
      <svg class="ic arr" class:open={showProblems} width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
    </button>
    {#if showProblems}
      <!-- ★ 二级从属行 —— 满幅灰底在这里才有意义（§10.2d） -->
      {#each st.problems.slice(0, 5) as p (p.what)}
        <div class="li sunkli p1"><span class="g"><small class="zh">{p.what} —— {p.message}</small></span></div>
      {/each}
    {/if}
  {/if}

  <div class="pillrow" style:padding="10px 0 4px">
    <button class="pill" disabled={busy !== null || st.kind === 'off'} onclick={() => void doTest()}>
      {busy === '测试' ? '测试中…' : '测试连接'}
    </button>
    <button class="pill v" disabled={busy !== null || st.kind === 'off'} onclick={() => void doRun()}>
      {busy === '同步' ? '同步中…' : '现在同步'}
    </button>
  </div>

  <!-- ★ 开关行：行本身不可点，Toggle 就是它的脸（§10.2c） -->
  <div class="sec">Preferences</div>
  <div class="li">
    <span class="g"><span class="zh s12">自动同步</span>
      <small class="zh">打开 App 时 + 练完后 —— 顺手同一次</small></span>
    {#if autoOpen === null}
      <span class="tag t-m">…</span>
    {:else}
      <Toggle on={autoOpen} busy={autoBusy} label="开机自动同步" onchange={() => void toggleAuto()} />
    {/if}
  </div>

  {#if conflictNote}
    <div class="note" role="alert">{conflictNote}</div>
    <div class="pillrow">
      <button class="pill" disabled={busy !== null} onclick={() => void doRun('local')}>用本地的</button>
      <button class="pill" disabled={busy !== null} onclick={() => void doRun('remote')}>用云端的</button>
    </div>
  {/if}

{/if}

{#if menu === 'kind'}
  <button class="scrim" aria-label="关闭" onclick={() => (menu = null)}></button>
  <div class="menu" role="menu">
    <div class="mhead">同步方式</div>
    {#each KINDS as [v, label] (v)}
      <button class="mi" onclick={() => ((menu = null), void saveField('kind', v))}>
        <span class="zh">{label}</span>
        {#if st?.kind === v}<span class="min"><Icon name="check" size={11} /></span>{/if}
      </button>
    {/each}
  </div>
{/if}

{#if dlg}
  {@const d = dlg}
  <Dialog
    title={d.title}
    input={d.value}
    placeholder={d.field === 'url' ? 'https://…' : ''}
    confirm="存"
    onclose={() => (dlg = null)}
    onconfirm={(v) => {
      /**
       * ★★★ 顺序不能反（⑦① 的根因，2026-09-01 真机抓到）
       *
       * 原来写的是 `((dlg = null), void saveField(d.field, v))`。
       * `{@const d = dlg}` 在 Svelte 5 里是**派生**的 —— 先把 `dlg` 置空，
       * `d` 当场变 null，接着读 `d.field` 就是
       * `Cannot read properties of null`，`saveField` **根本没被调用**。
       *
       * 表现：改桶名 / 地址 / 方式 / 密码 —— **点「存」什么都不会发生，
       * 而且不报错**（异常抛在事件处理器里，被 panel 的 try/catch 之外吞掉）。
       * 也就是说这个面板的四个可改项**全都是死的**，不只是桶名。
       *
       * 修法：先把要用的东西取出来，再置空。
       */
      const field = d.field
      dlg = null
      void saveField(field, v)
    }}
  />
{/if}
