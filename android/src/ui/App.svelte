<script lang="ts">
  /**
   * Nyx Android 外壳 —— 底部**四** Tab（D-372 定名 · D-388 增 Vault · D-391 定序）：
   *
   *   **Atlas → Lookup → Vault → Settings**
   *
   * ══ 谁干什么 ═══════════════════════════════════════════════
   *   Atlas    工作台：今日 · 最近保存 · 项目树（练习从对象进，D-360 结构不变）
   *   Lookup   向外看：查词 · 收进 Atlas · 行为计数（D-360/D-362）
   *   Vault    知识点库域：全部 / 攻坚 / 静默 / 重复收集 / 回收站（D-388/D-391）
   *   Settings 六区（USER / DEVICE 界面可辨）
   *
   * ★ Nyx Assist 不在这张表里 —— 跨 App 的系统级能力（D-303）。
   * ★ 屏顶不重复 Tab 名（D-360）。
   * ★ D-227：一行样式都没有，全在 styles/mobile.css。
   */
  import { untrack } from 'svelte'
  import { App as CapApp } from '@capacitor/app'
  import { handleBack, setBackFallback } from './lib/backstack.svelte.ts'
  import { route, TABS as TAB_KEYS, type Tab } from './lib/route.svelte.ts'
  import Atlas from './views/Atlas.svelte'
  import Lookup from './views/Lookup.svelte'
  import Vault from './views/Vault.svelte'
  import Settings from './views/Settings.svelte'
  import Reading from './views/Reading.svelte'
  import Practice from './views/Practice.svelte'
  import Assist from './views/Assist.svelte'
  import { assist, looksLookupable, startAssistChannel } from './lib/assist.svelte.ts'
  import { refreshDictFiles, setDictBytesProvider, setDictIoProvider } from '../db/dict.ts'
  import { activeOverrides, writeMirror } from '../db/colors.ts'
  import { applyColors } from './lib/theme.ts'
  import { resumeBatch } from '../db/analysis-runner.ts'
  import { syncBackgroundAnalysis } from './lib/analysis-bg.ts'
  import { listDictFolder, uiDictBytes, uiDictIo } from './lib/dictfs.ts'
  import { practice } from './lib/practice.svelte.ts'
  import Sprite from './lib/Sprite.svelte'
  import Snack from './lib/Snack.svelte'
  import Icon from './lib/Icon.svelte'
  import Banner from './lib/Banner.svelte'
  import Splash from './lib/Splash.svelte'
  import Onboarding from './lib/Onboarding.svelte'
  import { onboard } from './lib/onboarding.svelte.ts'
  import Guide from './lib/Guide.svelte'
  import { guide } from './lib/guide.svelte.ts'
  import { store } from './lib/store.svelte.ts'

  /**
   * 开库 —— 启动第一件事（upgrade 全程不碰网络）。
   * ★★★ 必须 `untrack`（2026-08-29 真机 P0）：不裹的话 db 状态一变
   *   effect 就重跑，失败时变成 createConnection 毫秒级风暴。
   */
  $effect(() => {
    untrack(() => void store.start())
  })

  /**
   * 首次引导（SC-25 · D-483）—— 库开好之后问一次「这台设备看过没有」。
   *
   * ★ 挂在库状态上而不是挂在启动那一下：记号在 `settings` 里，库没开就读不着。
   *   判据（要不要出）在 core 一份；`decide` 自己只问一次，所以这里跟着 db 变也不会重弹。
   * ★ 库开不出来时不出引导：那时该看见的是开库失败那一屏，不是新手引导。
   */
  $effect(() => {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    untrack(() => void onboard.decide(db))
  })

  /**
   * 第二层（页面内功能引导）的触发（使用者 2026-09-15 第二～六条）。
   *
   * ★★ **两层互斥**：第一层没看完，一条第二层都不出（派单边界）。
   *   这里只把「第一层还开着吗」告诉它 —— 判据不在 guide 那一侧重读一遍，
   *   读两处就会有两个答案。
   * ★★★ 按**元素挂载**扫，不按「进页面」扫：目标里有一个（结算块）是
   *   `{#if}` 里的，答完一题才挂上、每出一道新题还会卸掉重挂。
   *   按路由扫根本抓不到它。重挂会把这里打很多次 —— 全靠「看过」那一笔挡住，
   *   而那一笔是在**摆上去的同一拍**写的（`guide.svelte.ts`），中间没有异步窗口。
   * ★ `MutationObserver` 只看子树增减，不看属性：属性变动（class 切换之类）
   *   每秒能来几十次，而我们要的只是「有新东西挂上来了」。
   */
  $effect(() => {
    guide.blocked = onboard.open || store.db.k !== 'ok'
  })

  /**
   * ★★ 他走到别处去了 → 下一条可以出了（**一次页面停留只出一条**）。
   *
   * 2026-09-15 真机上抓到的：收掉一条之后，遮罩那层从 DOM 摘掉本身就是一次
   * childList 变动，于是第二条立刻弹上来 —— 屏上是「点掉一句又冒一句」，
   * 而我那一下点 Tab 其实点在了第二条的遮罩上，**它被顺手点没了，他一眼没看见**。
   * 使用者第四条明写「不能变成长篇教程」。
   *
   * 这里盯的三样就是「走到别处」：换 Tab · 进/出练习全屏 · 页面栈深浅变了。
   */
  $effect(() => {
    void route.tab
    void route.depth
    void practice.open
    guide.resume()
  })

  $effect(() => {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    let t: ReturnType<typeof setTimeout> | null = null
    const kick = (): void => {
      if (t !== null) clearTimeout(t)
      // ★ 等一帧再量：刚挂上来的那一下 rect 还可能是 0（量到 0 就跳过，见 scan）
      t = setTimeout(() => void guide.scan(db), 120)
    }
    const mo = new MutationObserver(kick)
    mo.observe(document.body, { childList: true, subtree: true })
    kick()
    return () => {
      if (t !== null) clearTimeout(t)
      mo.disconnect()
    }
  })

  // Assist 接词口（D-304 I-1/I-2）：冷启动 consume + 热启动事件，取到即开浮层
  $effect(() => {
    untrack(() => void startAssistChannel())
  })

  /**
   * 词典的字节通道 —— 注入一次（D-401 词典批 / ★ T-5.10）。
   *
   * ① 优先**真随机读**（`nyxDictHost` → `DictFiles.java`，与 Assist 引擎同一份）：
   *    只读索引与命中的块，内存不随书大小长，1 GB 级音频卷也读得到 ——
   *    Lookup 里的 `sound://` 能播就是靠它。
   * ② 拿不到就退回整本进内存（`convertFileSrc + fetch`）。
   *    **不静默**：`globalThis.nyxDb.dictIo` 会报 `memory`，③ 档一眼看得出来。
   */
  $effect(() => {
    untrack(() => {
      setDictBytesProvider(uiDictBytes)
      const io = uiDictIo()
      if (io) setDictIoProvider(io)
    })
  })

  /**
   * 词典文件夹清单刷新（D-404 资源批）。只列目录、不解析任何一本书。
   * 为什么在这儿：Assist 引擎跑在无障碍服务里，掏不了 SAF 插件 ——
   * 它要靠这份清单才找得到词典自带的 .css / .mdd。开库时顺手刷一次，
   * 使用者就不必为了「词典有样式了」专门去点一次重新扫描。
   */
  /**
   * ★★ 配色：开库之后照库里那一份校一次（2026-09-13）
   *
   * 启动时上色走的是 localStorage 那份镜像（`index.html`，比 JS 包还早）——
   * 快，但**镜像可能不在**：清过应用数据的「存储」那一半、换了 WebView 的
   * 存储目录、隐私模式…… 那时库里明明记着一套配色，屏上却是出厂色，
   * 而他什么都没改过。所以开库之后照库再打一次，顺手把镜像补回去。
   * ★ 幂等：值一样的话 `applyColors` 写的是同样的行内属性，屏上不动。
   */
  $effect(() => {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    untrack(() => {
      void (async () => {
        try {
          const o = await activeOverrides(db)
          applyColors(o)
          writeMirror(o)
        } catch {
          /* 读不出来就走出厂色 —— 配色不该挡住任何东西 */
        }
      })()
    })
  })

  $effect(() => {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    untrack(() => {
      void (async () => {
        try {
          const r = await db.get(`select value from settings where key = 'dict.folderUri'`)
          const uri = r?.['value']
          if (!uri) return
          const listing = await listDictFolder(String(uri))
          await refreshDictFiles(db, listing.files, listing.skipped)
        } catch {
          /* 权限没了/夹子挪了 —— 设置页重扫时会如实报，这里不打扰 */
        }
      })()
    })
  })

  /**
   * ★ D-404① · 气泡的保存与查词**不在这里**了。
   *   它们跑在无障碍服务自己的引擎里（同一份 assistCapture / assistLookup，
   *   端口换成原生 —— src/engine/main.ts），因此全程不需要唤醒这个 WebView，
   *   也就不再有「查个词被拽回 Nyx」。这里只剩明确的进门动作。
   */

  /**
   * 剪贴板去重记号：长度 + 一个 32 位滚动散列。够分辨「还是上一条吗」，
   * 又不把剪贴板原文（可能是密码、可能是 API key）留在库里。
   */
  function clipMark(s: string): string {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return `${s.length}:${(h >>> 0).toString(36)}`
  }

  /** 通道③ · 打开时接剪贴板（I-1.5）：开关 + 去重 + 英文判定，库开了才判 */
  $effect(() => {
    const raw = assist.chipRaw
    if (raw === null || store.db.k !== 'ok') return
    const db = store.db.db
    assist.chipRaw = null
    untrack(() => {
      void (async () => {
        if (!looksLookupable(raw)) return
        // D-400⑨ · 总开关管住常驻面（星 + 剪贴条）；明确的分享/选中动作不拦
        const en = await db.get(`select value from settings where key = 'assist.enabled'`)
        if (en?.['value'] === '0') return
        const on = await db.get(`select value from settings where key = 'assist.clipOnOpen'`)
        if (on?.['value'] === '0') return
        // ★ 去重记号存**指纹**不存原文（2026-08-30 审计）：使用者复制 API key
        //   到剪贴板那一次，原文就这样落进了 settings。去重只需要「和上次一样吗」。
        const mark = clipMark(raw)
        const seen = await db.get(`select value from settings where key = 'assist.lastClipSeen'`)
        if (seen?.['value'] === mark) return
        await db.run(
          `insert into settings (key, value, updated_at) values ('assist.lastClipSeen', ?, ?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
          [mark, Date.now()]
        )
        assist.chip = raw
      })()
    })
  })

  /**
   * ★★ 切回前台就同步一次（2026-09-01 · X-Ray 审计 F-003 · 第一步）。
   *
   * 在这之前**只有冷启动**会同步。而现代 Android 上 App 常年活在后台，
   * 点图标回来走的是 `resume`，压根不重跑 `store.start()` ——
   * 于是「电脑上删了，手机上什么时候消失」实际上**没有上界**。
   *
   * ★ 带节流（5 分钟）：来回切 App 会把同步打成风暴（每次都要 list 整个 chunks 目录）。
   * ★ 判据与冷启动那一条**同一个函数**（`store.autoSync`）—— 不写第二份。
   * ★ 失败静默（引擎留痕，设置页看得见）；绝不弹窗打断他。
   */
  $effect(() => {
    const sub = CapApp.addListener('resume', () => {
      void store.autoSync('切回前台自动同步', { throttle: true })
      /**
       * ★ T-5.13 · 回到前台时把没做完的那一批接着跑（前台跑得快，也看得见）。
       *   后台任务这时候可以收掉 —— `syncBackgroundAnalysis` 会照状态决定排还是收。
       */
      if (store.db.k === 'ok') {
        const db = store.db.db
        void resumeBatch(db).then(() => syncBackgroundAnalysis(db))
      }
    })
    return () => void sub.then((h) => h.remove())
  })

  /**
   * ★ T-5.13 · 要进后台了：手上还有没做完的批次就排一次 `AnalysisWorker`。
   *   判断在 JS（状态在 settings 里，Java 不许查库 —— `check:java-sql`）。
   *   **尽力，不承诺更多**：Force Stop 之后系统也会停掉它，
   *   下次他打开 App 时上面那条 `resume` 会接着跑。
   */
  $effect(() => {
    const sub = CapApp.addListener('pause', () => {
      if (store.db.k === 'ok') void syncBackgroundAnalysis(store.db.db)
    })
    return () => void sub.then((h) => h.remove())
  })

  /**
   * ★ Android 系统返回（侧滑/返回键）—— 全应用唯一消费点（D-393）。
   * 顺序：浮层 → 页面栈 → 非 Atlas 的 Tab 回 Atlas → Atlas 根才退出。
   */
  $effect(() => {
    setBackFallback(() => {
      // ★ 纵轴（使用者第二轮需求 §六）：返回永远只退一层。
      //   ② 当前 Tab 的页面栈 → ③ 非 Atlas 回 Atlas → ④ Atlas Root 才退出。
      //   ①（浮层）由 Dialog/Menu 自己 registerBack，在 backstack 里排在更前面。
      if (route.pop()) return
      if (route.tab !== 'atlas') route.goTab('atlas')
      else void CapApp.exitApp()
    })
    const sub = CapApp.addListener('backButton', () => handleBack())
    return () => void sub.then((h) => h.remove())
  })


  /**
   * Tab 图标：Atlas = Home 两颗星（DS §4.4b「你落地的地方」）；
   * Vault 专属符号在 G8 补画清单上（DS §十一）——成品前先用单颗 star 占位，
   * 轮廓语言同族，**不混 Material**（D-330）。
   */
  const TAB_META: Record<Tab, { nm: string; ic: string }> = {
    atlas: { nm: 'Atlas', ic: 'study' },
    lookup: { nm: 'Lookup', ic: 'lookup' },
    vault: { nm: 'Vault', ic: 'vault' },
    settings: { nm: 'Settings', ic: 'settings' }
  }
</script>

<Sprite />
<!-- ★ 启动页第二帧（B1）：只在有插画且库还没开好时出现，库开好就走。
     它盖在最上面，所以放在 .app 之前 —— 样式在 mobile.css（D-227）。 -->
<Splash />
<!-- ★ 首次引导（SC-25）：z-index 70，压在启动页（90）下面 ——
     启动页收掉那一刻它正好露出来，收掉之前它在底下等着（U-007 不动启动页）。 -->
<Onboarding />
<!-- ★ 第二层：页面内功能引导（z-index 75，压在首次引导 70 之上、启动页 90 之下） -->
<Guide />

<div class="app">
  <div class="app-body">
    <!-- ★ Banner（B4 · NT-Q2）：内容区顶部、在流里所以**不盖内容**。
         只在同步连败 ≥3 次时出现，同步成功了它自己就没了。
         练习全屏时不出现 —— 那一屏是「一件事」，不许被别的事插话。 -->
    {#if !practice.open}<Banner />{/if}
    {#if practice.open?.kind === 'reading'}
      <!-- 屏 7 · 练习全屏，压过 Tab（练习永远是练某个东西 —— 入口在对象上，D-360） -->
      <Reading lectureId={practice.open.lectureId ?? null} ids={practice.open.ids ?? null} />
    {:else if practice.open?.kind === 'production'}
      <Practice lectureIds={practice.open.lectureIds ?? null} ids={practice.open.ids ?? null} />
    {:else if route.tab === 'atlas'}
      <Atlas />
    {:else if route.tab === 'lookup'}
      <Lookup />
    {:else if route.tab === 'vault'}
      <Vault />
    {:else}
      <Settings />
    {/if}
  </div>

  {#if assist.chip && !assist.open}
    <!-- 通道③ 小条：不抢屏，点了才开浮层 -->
    <button
      class="clipchip"
      onclick={() => {
        const t = assist.chip
        assist.chip = null
        if (t) assist.open = { text: t, pkg: null }
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--violet)"><use href="#nyx-star" /></svg>
      <span class="zh">剪贴板 · </span><span class="ct">{assist.chip.length > 26 ? assist.chip.slice(0, 26) + '…' : assist.chip}</span>
      <span class="m">查它 ›</span>
      <span
        class="x"
        role="button"
        tabindex="-1"
        onkeydown={(e) => e.key === 'Enter' && (assist.chip = null)}
        onclick={(e) => {
          e.stopPropagation()
          assist.chip = null
        }}><svg class="ic" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-close" /></svg></span>
    </button>
  {/if}

  {#if assist.open}
    <Assist text={assist.open.text} pkg={assist.open.pkg} quote={assist.open.quote ?? null} />
  {/if}

  <!-- ★ 全应用唯一的 Snackbar（第十九则指令）：此前七个页面各挂各的，
       详情页删完一退回，「撤销」就跟着页面一起没了。挂在这里就不会。 -->
  <Snack />

  {#if !practice.open}
  <nav class="tabs">
    {#each TAB_KEYS as k (k)}
      {@const t = TAB_META[k]}
      <button
        class="tab"
        class:on={route.tab === k}
        onclick={() => route.goTab(k)}
        aria-current={route.tab === k ? 'page' : undefined}
      >
        <!-- ★ 横轴：点任何 Tab（**含当前这个**）都把它的栈清到 Root。
             底部导航是一级入口，不是返回按钮。 -->
        <!-- ★ DS-Q17 定案（2026-09-07）：选中态**不换实心** —— 细线图标放进
             一个淡水色圆角方块里。那个方块同时解决了「选中」和「命中区」两件事。
             （此前是 DS §4.5 的实心 / 空心；换掉的只是选中态的表达，
               图标几何一条路径都没动。）
             方块画在 .tabic 上，样式在 mobile.css（D-227）。 -->
        <span class="tabic"><Icon name={t.ic} on={false} size={18} /></span>
        <span>{t.nm}</span>
      </button>
    {/each}
  </nav>
  {/if}
</div>
