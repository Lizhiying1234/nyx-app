<script lang="ts">
  /**
   * Lookup —— 「看外面的」（F2 · D-151 单本卡 · D-362 行为计数 · D-376 收下可翻）。
   *
   * 判据全在 db 层：单本与回退 = dict.ts::lookupCard/defaultBook（与 Windows
   * registry.defaultBook 同源：临时退第一本，绝不回写偏好）；收下 = capture.ts
   * ::assistCapture（与气泡同一条路）；计数 = ledger.ts::lookupWeek（数动作
   * 不评水平）。这里只是摆上屏。
   * ★ 词条按词典自己的结构渲染（D-404④）：原始 HTML + 词典自己的 CSS 进
   *   沙箱 iframe —— AI 才是我们排版，词典不重新包装。
   */
  import { store } from '../lib/store.svelte.ts'
  import {
    dictSoundBytes,
    lookupCard,
    parseEntryLink,
    problemLine,
    pronWhy,
    setDefaultBook,
    type DictRow,
    type LookupCard
  } from '../../db/dict.ts'
  import { dictMimeOf } from '../../core-link.ts'
  import { assistCapture, assistStatus, type AssistStatus, type CaptureResult } from '../../db/capture.ts'
  import { lookupDays, lookupWeek, noteLookup, recentLookups, type LookupDay, type LookupWeek, type RecentLookup } from '../../db/ledger.ts'
  import { playAudioB64, speak } from '../../db/tts.ts'
  import { decodeSpxToWav, b64ToBytes } from '../../db/spx.ts'
  import { assistLookup, type LookupResult } from '../../db/lookup.ts'
  import { registerBack } from '../lib/backstack.svelte.ts'
  import SaveRow from '../lib/SaveRow.svelte'

  /**
   * ★★ ⑥ · 两种模式（2026-09-01）
   *   dict = 本地词典（原来的全部行为，一个字没动）
   *   ai   = AI 搜索，走 assistLookup 的 'search' 那一档
   *
   * ★ 复用 `assistLookup` 而不是另开一条 AI 路：气泡那边早就有
   *   quick / full / dict 三档，判据、展示层整理（parseAiSections）、
   *   如实标注都在那里。再写一份就是第二套判据。
   * ★ 模式记在本机（`lookup.mode`）—— 他上次用哪种，下次进来还是哪种。
   *   不进 user_preferences：这是**这台设备上的习惯**，不是他的偏好
   *   （手机爱用 AI、电脑爱查词典，完全正常）。
   */
  let mode = $state<'dict' | 'ai'>('dict')
  let ai = $state<LookupResult | null>(null)

  let q = $state('')
  let term = $state<string | null>(null)
  let card = $state<LookupCard | null>(null)
  let status = $state<AssistStatus | null>(null)
  let saved = $state<CaptureResult | null>(null)
  let layer = $state<'A' | 'B'>('A')
  let week = $state<LookupWeek | null>(null)
  /** 周序号（ISO 周）—— 右上坐标用，与 Atlas 的 `ATL · 09.01` 同一档 */
  const WEEKNO = ((): string => {
    const d = new Date()
    const t = new Date(d.getFullYear(), 0, 1)
    const w = Math.ceil(((d.getTime() - t.getTime()) / 86400000 + t.getDay() + 1) / 7)
    return `W${String(w).padStart(2, '0')}`
  })()

  const fmtAgo = (at: number): string => {
    const m = Math.max(0, Math.floor((Date.now() - at) / 60000))
    if (m < 60) return m < 1 ? '刚刚' : `${m} 分钟前`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h} 小时前`
    const dd = Math.floor(h / 24)
    return dd === 1 ? '昨天' : `${dd} 天前`
  }

  let days = $state<LookupDay[]>([])
  /** 搜索与统计之间那一层内容 —— 「我刚才在查什么」 */
  let recents = $state<RecentLookup[]>([])
  let busy = $state(false)
  let picking = $state(false)
  let note = $state<string | null>(null)
  /** 跨词条跳转要滚到的锚点（entry://词#锚 的后半）—— 只活到下一次装载 */
  let jumpAnchor = $state<string | null>(null)

  let booted = false
  $effect(() => {
    if (store.db.k !== 'ok' || booted) return
    booted = true
    const db = store.db.db
    void (async () => {
      week = await lookupWeek(db)
      days = await lookupDays(db)
      recents = await recentLookups(db)
      // ★ ⑥：上次用的是哪种模式（本机习惯，见 setMode）
      const m = await db.get(`select value from settings where key = 'lookup.mode'`)
      if (m?.['value'] === 'ai') mode = 'ai'
      // ★★ ⑩（2026-09-01）：新收下的一律默认认读 A —— 不再读 lastLayer 当默认档
      //   （同 Assist.svelte 那处；D-376「翻过就记住」半条被 ⑩ 修订）
    })()
  })

  /**
   * ★★ D-440 · 返回只退一层（2026-09-02）
   *
   * 查词结果**不是路由节点** —— `route.stacks.lookup` 那条栈从头到尾没人
   * push 过（`Node` 联合里压根没有 LookupNode）。于是查完一个词按系统返回，
   * backstack 一路落到 App 的兜底，判「不在 Atlas → 回 Atlas」：
   * **他报的「点返回直接回主界面」就是这一下。**
   *
   * 现在结果自己接住这一次返回，退回 Lookup 首页（最近查过 + 轨迹）。
   * ★ `q` 不清 —— 他要的是「回到刚才那次搜索」，搜索词留在框里才叫保留状态。
   * ★ 页面上那颗返回箭头走的是**同一个函数**（D-440 的原话：页面返回与系统返回
   *   必须是同一套逻辑），不许两处各写各的。
   */
  function backToHome(): boolean {
    // ★ 只退一层：换本的那个展开条自己算一层，先收它
    if (picking) {
      picking = false
      return true
    }
    if (term === null) return false
    term = null
    card = null
    ai = null
    saved = null
    status = null
    picking = false
    note = null
    return true
  }
  $effect(() => registerBack(backToHome))

  /**
   * 换模式。★ 已经有词在框里就**当场重查**（不用他再按一次 Search）——
   *   他切模式的意思就是「这个词换另一种方式看看」。
   * ★ 模式记在本机 settings（不是 user_preferences）：
   *   这是「这台设备上的习惯」，不是他的偏好 —— 手机爱用 AI、电脑爱查词典，
   *   完全正常，不该互相覆盖。
   */
  async function setMode(m: 'dict' | 'ai'): Promise<void> {
    if (mode === m) return
    mode = m
    note = null
    if (store.db.k === 'ok') {
      await store.db.db.run(
        `insert into settings (key, value, updated_at) values ('lookup.mode', ?, ?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [m, Date.now()]
      )
    }
    if (term) await search()
  }

  async function search(bookId?: number, anchor: string | null = null): Promise<void> {
    const w = q.trim()
    if (!w || store.db.k !== 'ok' || busy) return
    const db = store.db.db
    busy = true
    note = null
    saved = null
    // ★ 状态也一起清（T-5.9①）：操作行现在摆在结果**上方**、查询期间就看得见，
    //   不清的话换词那一瞬它挂的是**上一个词**的「在 Atlas · …」—— 说的是假话。
    status = null
    picking = false
    jumpAnchor = anchor
    try {
      term = w
      entryH = null
      if (mode === 'ai') {
        // ★ 先把上一条清掉 —— 否则等待期间屏幕上还挂着上一个词的答案
        ai = null
        card = null
        ai = await assistLookup(db, 'search', w, null)
      } else {
        ai = null
        card = await lookupCard(db, w, bookId)
      }
      status = await assistStatus(db, w)
      // D-362 · 只在新一次查询记一笔（换本重看同一个词不重复计数）
      if (bookId === undefined) {
        // T-4.14 · 记的形状只有 ledger.ts::noteLookup 一份；这一侧只说清「是哪一面」
        await noteLookup(db, w, { source: 'app', face: mode === 'ai' ? 'ai' : 'dict' })
        week = await lookupWeek(db)
        days = await lookupDays(db)
        recents = await recentLookups(db)
      }
    } catch (e) {
      note = `没查成：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }

  /**
   * 词条里点了链接（iframe 里的小脚本只送**原始 href** 回来 —— 解析判据
   * 一份在 dict.ts::parseEntryLink，不在脚本里抄第二份）。
   * 跨词条跳 = 查那个词（同一本书；D-362 不再记一笔 —— 跟换本一样，
   * 是同一次查询的延伸，不是新动作）。
   */
  function onFrameMsg(e: MessageEvent): void {
    const d = e.data as { nyx?: string; href?: string; px?: number } | null
    if (!d || typeof d !== 'object') return
    // ★ ⑫ · 高度回报（iframe 内的 ResizeObserver 送上来的）
    if (d.nyx === 'h' && typeof d.px === 'number' && d.px > 0) {
      // 夹住：太矮读不了一屏，太高就成了页中页。上限跟着视口走。
      const cap = Math.round(window.innerHeight * 0.62)
      entryH = Math.max(180, Math.min(cap, Math.ceil(d.px)))
      return
    }
    if (typeof d.href !== 'string') return
    if (d.nyx === 'link') {
      const link = parseEntryLink(d.href)
      if (link) {
        if (link.word) {
          q = link.word
          void search(card?.book?.id, link.anchor)
        } else {
          // 同页锚点 iframe 里就地滚过了；还送上来说明锚点不在（被裁掉）
          note = '这个跳转点不在这条词典条目里（条目可能被裁短了）'
        }
        return
      }
      if (d.href.startsWith('sound://')) {
        void playDictSound(d.href)
      }
    }
  }

  /**
   * ★★ T-5.10 · 词条里的 `sound://` 直接播（词头 hwd/… 与例句 exa/… 同一条路）。
   *
   * 在这之前这一侧**根本播不了**：App 没有随机读通道，1 GB 级的音频卷不可能
   * 整本进内存，于是词头音只能退去读合成音、例句音只能说一句「只有气泡里能播」。
   * 现在 `nyxDictHost` 把引擎那条真随机读也给了 App，`dictSoundBytes` 两侧同一份。
   *
   * ★ 判据全在 db / core：键怎么算（`normalizeResourceKey`）、找哪几卷
   *   （`soundVolumesOf`）、能不能放（mime）—— 这里只负责发起与说话。
   * ★ 放不了要说清是哪一种放不了（D-412 文案说真话）：
   *   Speex 是**格式**放不了（core 的话术），没找到是**这本卷里没有**。
   */
  /**
   * 正在取/解的是哪一声 —— **后来的顶掉先来的**（2026-09-13）。
   * 第一次点词典发音要先加载 Speex 的 WASM，那个窗口足够长，
   * 手快点第二下就会两条路并发：谁先解完谁先响，而且互相掐。
   * 用一个令牌：解完之后发现自己已经不是最新那一声了，就安静退出。
   */
  let soundSeq = 0

  async function playDictSound(href: string): Promise<void> {
    if (store.db.k !== 'ok') return
    const mine = ++soundSeq
    const path = href.slice('sound://'.length)
    const ext = (path.split('.').pop() ?? '').toLowerCase()
    const mime = dictMimeOf(path)
    /**
     * ★★ 2026-09-13 · `.spx` 不再被这道闸挡掉 —— 我们**自带解码器**了。
     *
     * 使用者：「这个词典应该是有语音资源的，用其他软件能听出来，用 Nyx 听不出来」。
     * 属实：LDOCE5 的发音全是 Speex，Chromium 删了解码、Android 的 MediaCodec
     * 也从来没有，别的词典软件放得响是因为自带解码器。现在这一端也自带了
     * （`db/spx.ts`：Ogg 拆包 + libspeex WASM，解完拼成 WAV 走同一条播放路）。
     * ★ 这道闸仍然拦别的放不了的格式（wma / amr 这些），只是不再拦 spx。
     */
    if (ext !== 'spx' && mime && !/^audio\/(mpeg|wav|ogg)$/.test(mime.split(';')[0]!.trim())) {
      note = `这段发音是 ${ext} 格式，浏览器放不了。`
      return
    }
    try {
      const b64 = await dictSoundBytes(store.db.db, path)
      if (!b64) {
        note = `这条发音在词典的音频卷里没找到（${pronWhy || path}）`
        return
      }
      if (mine !== soundSeq) return
      if (ext === 'spx') {
        const r = await decodeSpxToWav(b64ToBytes(b64))
        // 解完发现已经不是最新那一声了 —— 安静退出，别去抢喇叭
        if (mine !== soundSeq) return
        // 解不了要**说出来**：点了没反应是这条路上最坏的结果
        if ('why' in r) {
          note = r.why
          return
        }
        const w = await playAudioB64(r.b64, 'audio/wav')
        if (w) note = w
        return
      }
      const why = await playAudioB64(b64, mime ?? 'audio/mpeg')
      if (why) note = why
    } catch (e) {
      note = `发音取不出来：${(e as Error)?.message ?? e}`
    }
  }

  /** 换本 = 设默认（F2）。设不上（老行没 uid）如实说，卡片仍按所选书显示 */
  async function pickBook(d: DictRow): Promise<void> {
    if (store.db.k !== 'ok') return
    try {
      await setDefaultBook(store.db.db, d)
    } catch (e) {
      note = (e as Error)?.message ?? String(e)
    }
    await search(d.id)
  }

  async function save(): Promise<void> {
    if (!term || store.db.k !== 'ok' || busy) return
    busy = true
    try {
      // ★ T-5.9② · `'lookup'` = 这一条是在 Lookup 里收的 —— 落点走 Lookup 自己的
      //   两模式（自定 / 跟随 Assist），不再无条件借用 Assist 的默认位置。
      saved = await assistCapture(store.db.db, term, layer, null, 'lookup', null, null)
      week = await lookupWeek(store.db.db)
    } catch (e) {
      note = `没收成：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }

  /** D-376 · 确认条上翻层 = 当场改刚收下那条（自己刚建的，不是 D-302 管的既有内容） */
  async function pickLayer(l: 'A' | 'B'): Promise<void> {
    if (store.db.k !== 'ok') return
    layer = l
    const db = store.db.db
    await db.run(
      `insert into settings (key, value, updated_at) values ('assist.lastLayer', ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [l, Date.now()]
    )
    if (saved) {
      await db.run(`update items set layer = ?, updated_at = ? where id = ?`, [l, Date.now(), saved.id])
      saved = { ...saved, layer: l }
    }
  }

  /** 操作行上那颗喇叭（组件只回调，读什么、失败说什么仍归这里） */
  function speakTerm(): void {
    if (store.db.k !== 'ok' || !term) return
    void speak(store.db.db, term).then((n) => {
      if (n) note = n
    })
  }

  /**
   * iframe 里跑的**唯一**脚本（词典自带脚本已在判据层剥掉）：
   * 同页锚点就地滚；其余词典协议链接把**原始 href** 送回父层。
   * sandbox 只开 allow-scripts —— origin 仍是 opaque，脚本够不着父层 DOM，
   * 只有 postMessage 这一条缝，父层收到还要过 parseEntryLink 这一关。
   */
  const FRAME_JS =
    '(function(){' +
    'function go(x){var el=document.getElementById(x)||document.getElementsByName(x)[0];' +
    'if(el){el.scrollIntoView();return true}return false}' +
    'if(NYX_A){if(!go(NYX_A))addEventListener("load",function(){go(NYX_A)})}' +
    // ★ ⑫：把内容真实高度报回来 —— 框原来写死 62vh，短词条下面留一大块空。
    //   ResizeObserver 盯 body：词典里的图片加载完、折叠块展开都会变高。
    'function h(){parent.postMessage({nyx:"h",px:document.documentElement.scrollHeight},"*")}' +
    'addEventListener("load",h);new ResizeObserver(h).observe(document.body);' +
    'document.addEventListener("click",function(e){' +
    'var n=e.target;while(n&&n.nodeType===1&&n.tagName!=="A")n=n.parentNode;' +
    'if(!n||n.nodeType!==1)return;' +
    'var h=n.getAttribute("href")||"";if(!h)return;' +
    'if(h.charAt(0)==="#")return;' +
    'e.preventDefault();' +
    'if(h.indexOf("entry://#")===0&&go(h.slice(9)))return;' +
    'parent.postMessage({nyx:"link",href:h},"*");' +
    '},true)' +
    '})()'

  /**
   * ★ ⑫ · 词条框的实际高度（由 iframe 内部报上来）。
   *   夹在 180 和 62vh 之间：太矮读不了一屏，太高就成了页中页。
   *   量不到就退回原来的 62vh —— 退化成「和以前一样」，不是退化成 0。
   */
  let entryH = $state<number | null>(null)

  /** 词条 iframe：词典自己的 CSS 先行，我们只给底色/内边距兜底 + 链接拦截脚本 */
  function entryDoc(html: string, css?: string, anchor?: string | null): string {
    // 锚点是 32 位 hex + 词名的形状 —— 收紧成 \w- 再进脚本，别的都不配当锚点
    const a = anchor ? anchor.replace(/[^\w-]/g, '') : ''
    return (
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<style>body{margin:0;padding:10px 12px;background:#fff;font:14px/1.6 serif;word-break:break-word}img{max-width:100%}</style>` +
      (css ? `<style>${css}</style>` : '') +
      html +
      `<script>var NYX_A=${JSON.stringify(a || null)};${FRAME_JS}<\/script>`
    )
  }
</script>

<svelte:window onmessage={onFrameMsg} />

<div class="view">
  <!-- ★ 屏顶标题已删（第十九则指令 §六/§七）：底部 Tab 亮着紫色 · 图标实心 ·
       名字写在下面 —— 已经三重标识，屏顶那行是第四遍。 -->

  <!-- ══ ⑥ · 模式开关（顶部，明显）══════════════════════════
       用已有的 .seg（Segmented，DS §16.3）—— 不为这一处新造控件。
       ★ 两种模式的**界面区别**不靠这个开关本身，靠下面：
         词典 = 词典自己的 HTML 进 iframe（它的排版归它）
         AI   = 我们的分节排版 + 一条如实的「可能有误」
       这正是 D-401 定的那条：模型管内容，UI 管呈现。 -->
  <!-- ★ D-440 · 查了词之后这一屏就是二级页，屏顶给一颗返回箭头（D-418/D-419 的形态）。
       在这之前**根本没有回去的路** —— 查完只能换 Tab（而换 Tab 会清栈）。
       它调的就是系统返回那个函数，不另写一份。 -->
  {#if term !== null}
    <div class="top" style="gap:8px">
      <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={() => backToHome()}>
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
      </button>
    </div>
  {/if}

  <div class="lk-mode">
    <span class="seg">
      <button class:sel={mode === 'dict'} onclick={() => void setMode('dict')}>词典</button>
      <button class:sel={mode === 'ai'} onclick={() => void setMode('ai')}>AI 搜索</button>
    </span>
  </div>

  <form
    onsubmit={(e) => {
      e.preventDefault()
      void search()
    }}
  >
    <!-- ══ T-5.8 · 搜索框随内容长高 ═══════════════════════════
         原来是单行 `<input>`：长句一超宽就**横向滚**，看得见的永远只有一小段，
         而查的东西越长越需要看清自己输了什么。改成多行输入 + 内容驱动高度。
         ★ 高度不靠 JS 量：外面这层 `.lk-q` 是 grid，`::after` 拿 `data-v` 把
           同一段文字用同样的字体/宽度画一遍（隐形），行高由它撑 —— 于是
           「长高」是**布局算出来的**，没有测量、没有内联 style、没有一帧跳动。
           规则全在 mobile.css（D-227）。超过四行封顶，里面自己滚。
         ★ Enter 仍然是搜索（`enterkeyhint="search"`，手机上就是那颗搜索键）：
           多行是为了**看得见**，不是为了让他敲回车换行。 -->
    <div class="lk-q" data-v={q}>
      <textarea
        class="dlg-in"
        placeholder="查一个词或短语…"
        bind:value={q}
        rows="1"
        autocapitalize="none"
        autocomplete="off"
        enterkeyhint="search"
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void search()
          }
        }}
      ></textarea>
    </div>
  </form>

  {#if note}<div class="note" role="status">{note}</div>{/if}

  <!-- ══ T-5.9① ·「收进 Atlas」操作行 —— 两种模式**同一条** ══════
       在这之前它只长在词典模式的分支里：切到 AI 搜索，状态行、收进按钮、
       确认条整条消失 —— **AI 搜索根本收不了词**。而「收进 Atlas」是 Lookup
       的核心共同能力，不是词典模式的附属。
       ★ 现在它渲染**一次**，在模式分叉之外、结果之上：
         「两种模式看到的是同一条行」于是成了结构事实，不靠两处写得一样来维持。
       ★ 位置在结果上方（模式开关与搜索框之下）：状态（不在 Atlas / 在 Atlas ·
         哪一讲 / INTO 路径）一眼可见，不用滚到词条尽头去找。 -->
  {#if term !== null}
    <SaveRow
      {status}
      {saved}
      {layer}
      {busy}
      onsave={() => void save()}
      onlayer={(l) => void pickLayer(l)}
      onspeak={speakTerm}
    />
  {/if}

  {#if term === null}
    <!-- ══ 数据区（第十一则指令 §3）：全部真数据（ops_log · D-362 数动作不评水平）══ -->
    {#if recents.length > 0}
      <div class="sec"><span class="zh">最近查过</span></div>
      {#each recents as r (r.word)}
        <button class="lk-row" onclick={() => ((q = r.word), void search())}>
          <span class="w">{r.word}</span>
          <span class="n">{r.n > 1 ? `×${r.n} · ` : ''}{fmtAgo(r.at)}</span>
          <span class="ic"><svg width="12" height="12" viewBox="0 0 24 24"><use href="#nyx-caret" /></svg></span>
        </button>
      {/each}
    {/if}

    {#if week && (week.looked > 0 || week.saved > 0)}
      {@const mx = Math.max(1, ...days.map((d) => d.looked))}
      {@const WD = ['日', '一', '二', '三', '四', '五', '六']}
      {@const today = days.length - 1}
      {@const p3 = String(week.looked).padStart(3, '0')}
      {@const zn = p3.length - String(week.looked).length}
      <!-- ★ 统计退到内容之后（使用者第二轮 §七）。它的岗位是「填补空白、为了美观」——
           那就按这个标准做：横线格在 Atlas 是纯氛围，**在这里当刻度用**，
           每条线一个单位，柱子压在线上，一眼数得出差几格。
           但它仍然只数动作不评水平（D-362）：查了几次 · 收进几个 · 最常查哪个。 -->
      <div class="spacer"></div>
      <div class="sec"><span class="zh">近七天</span></div>
      <div class="panel">
        <span class="cn a"></span><span class="cn d"></span>
        <span class="coord">LKP · {WEEKNO}</span>
        <div class="chart" style:--rows={mx}>
          <span class="grid"></span><span class="base"></span>
          {#each days as d, i (d.day)}
            {@const bh = d.looked > 0 ? Math.round((d.looked / mx) * 52) : 0}
            <span class="col" class:cur={i === today} style:--h="{bh}px">
              {#if i === today}
                <!-- ★ 星停在**柱顶**，不是列顶 —— 它是「你在这儿」的标记，
                     飘在半空就成了一粒无处安放的尘 -->
                <svg class="star" viewBox="0 0 24 24"><use href="#nyx-star-16" /></svg>
              {/if}
              {#if d.looked > 0}
                <span class="bar" style:height="{bh}px"></span>
              {:else}
                <span class="zero"></span>
              {/if}
              <span class="wd">{WD[new Date(d.day).getDay()]}</span>
            </span>
          {/each}
        </div>
        <div class="sum">
          <span class="v"><span class="z">{p3.slice(0, zn)}</span>{p3.slice(zn)}</span>
          <span class="u">次查询 · 收进 {String(week.saved).padStart(2, '0')}</span>
          {#if week.top && week.top.n > 1}
            <span class="r">最常查 <b>{week.top.word}</b></span>
          {/if}
        </div>
      </div>
    {:else}
      <div class="empty tight">
        <div class="t zh2">查什么都从这里开始</div>
        <div class="s">输入 → Search → 直接看词典 · 用起来之后这里会有你的查询轨迹</div>
      </div>
    {/if}
  {:else if mode === 'ai'}
    <!-- ══ AI 搜索结果 —— 我们自己的排版（D-401：模型管内容、UI 管呈现）══ -->
    {#if busy}
      <!-- ★ 等待要有形，而且不跳版（DS Loading 统一形态）：骨架 + 呼吸 -->
      <div class="lk-ai">
        <div class="lk-skel t"></div>
        <div class="lk-skel"></div>
        <div class="lk-skel s"></div>
      </div>
    {:else if ai}
      <div class="lk-ai">
        {#each ai.sections as s, i (i)}
          {#if s.label}<div class="sec"><span class="zh">{s.label}</span></div>{/if}
          <p class="lk-p">{s.text}</p>
        {/each}
        <!-- ★ 如实标注（D-395 / D-328 诚实原则）：这是 AI 生成的，不是词典 -->
        {#if ai.note}<div class="m blk">{ai.note}</div>{/if}
      </div>
    {/if}

  {:else if card}
    <!-- 书行（降级成一条 meta 小行 —— 词典内容才是主角，指令 §4）-->
    <button class="li lk-book" onclick={() => (picking = !picking)}>
      <span class="g m">{card.book ? card.book.bookname : '没有可用的词典'}{#if card.fellBackFrom}<span class="tag t-w gap">临时替默认</span>{/if}</span>
      <span class="arr" class:open={picking}><svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
    </button>
    {#if picking}
      {#each card.books as b (b.id)}
        <button class="li sunkli p2" onclick={() => void pickBook(b)}>
          <span class="g"><span class="zh s12" class:dim={b.id !== card.book?.id}>{b.bookname}</span>
            <small>{b.wordCount.toLocaleString()} 词</small></span>
          {#if b.id === card.book?.id}<span class="tag t-v">当前</span>{:else}<span class="m">用它</span>{/if}
        </button>
      {/each}
    {/if}

    {#if card.hit?.html}
      <!-- ★ ⑫：外框的样式收进 .lk-entry（原来是六个内联 style —— D-227 说零组件样式，
           内联比组件样式更糟：它连「在哪能改」都说不出来）。 -->
      <div class="lk-entry" style:--entry-h={entryH ? `${entryH}px` : null}>
        <iframe
          title="词典条目"
          sandbox="allow-scripts"
          srcdoc={entryDoc(card.hit.html, card.hit.css, jumpAnchor)}
        ></iframe>
      </div>
    {:else if card.book}
      <!-- ★★ T-5.10 · 「这本里没有」以前是**唯一**的出口：读不了（大书装不下 /
           权限丢了 / 索引解不开）也走这一句，坏书还被无声排除在查词之外。
           使用者报的「显示不出来又不说为什么」就是这里。现在三态分开：
             ① 读不了 → core 的话术（diagnostics.ts 是唯一出处）
             ② 有书被排除 → 逐本说是哪本、为什么
             ③ 都不是 → 才是真的「这本里没有」 -->
      <div class="empty tight">
        {#if card.problem}
          <div class="t zh2">「{card.book.bookname}」这本读不了</div>
          <div class="s">{problemLine(card.problem)}</div>
        {:else}
          <div class="t zh2">「{term}」这本里没有</div>
        {/if}
        <!-- ★ ⑫：这里原来写着「（如实说：不推销 AI）」—— 那是**写给我自己看的**
             理由，不该出现在他的屏幕上。现在这一句真的有用了：AI 搜索就在上面那个开关里。 -->
        <div class="s">换一本试试（上面那行点开），或者切到 AI 搜索</div>
        {#each card.skipped as sk (sk.book)}
          <div class="s">没参与这次查词 · {problemLine(sk)}</div>
        {/each}
      </div>
    {:else}
      <div class="empty tight"><div class="t zh2">词典还没装上</div>
        <div class="s">去 设置 → 词典 选文件夹、扫描一次（D-336）</div></div>
    {/if}

    <!-- ★ 原来那条操作行搬到了结果上方、模式分叉之外（T-5.9① · 见上面 SaveRow）——
         词典内容仍然直接给，Nyx 的操作仍然是一条 meta 行，只是不再藏在词条尽头。 -->

  {/if}
</div>
