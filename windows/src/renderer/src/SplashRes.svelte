<script lang="ts">
  /**
   * ══ Settings → 资源 → 启动页（使用者 2026-09-09）════════════════════
   *
   * 他的原话拆成六条，逐条落在下面：
   *   ① 默认 = Nyx 图标 —— 第一张卡永远是它，**不依赖任何文件**
   *   ② 可以传多张候选
   *   ③ 预览不是缩略图，是「**Nyx 真正启动时看到的那一页**」
   *   ④ 左右切换
   *   ⑤ 每张卡下面一颗「启用」—— 把正在看的这一张设成**唯一**在用的那张
   *   ⑥ 候选可以多个，**实际启用只能一个**
   *
   * ★★ **「有多个资源」和「同时启用多个」是两件事** —— 他专门强调过。
   *   所以界面上这两件事用**两种记号**，不共用一个：
   *     候选  = 轮播里的一张卡（有几张就有几张）
   *     在用  = 卡上那枚「使用中」徽章 ＋ 底下那行「当前：×××」
   *   任何时候屏上**只有一枚**「使用中」，它就是答案。
   *
   * ══ 两端的分工（使用者 2026-09-09 第二次改的需求）═══════════════════
   *   「win 和 android 可以有不同的启动页，**共享的是图片资源**」
   *     图片本体 → \`data/resources/splash/\`，跟着同步走（两端看得见同一批候选）
   *     选了哪张 → \`settings\` 表，**不进 \`SYNC_TABLES\`**，各端自己的事
   *   这一页顶上那句话就是在说这件事 —— 别让他以为「在这儿选了手机也会变」。
   *
   * ★ 预览要**忠实**：真启动页是素色底 + 中间一块画面（高 ≤62% · 宽 ≤70%）·
   *   **没有字**（U-007 定稿 · DS §12.0b）。所以预览卡里也不放字标、不放标语 ——
   *   预览如果比真页面好看，那它就是在骗人。
   * ★ 样式全在 enhancements.css 的 \`.spl*\`（D-227）。
   */
  import type { SplashChoice, SplashRes } from '@shared/api.ts'
  import { MAX_LABEL, defaultLabel } from '@core/splash-names.ts'
  import { sameChoice as same, shownChoice } from '@core/splash-name.ts'
  import { cleanMessage } from '@shared/api.ts'
  import Ic from './Ic.svelte'
  import Skel from './Skel.svelte'
  import Dialog from './Dialog.svelte'
  import { say, sayBad } from './toast.svelte.ts'
  import brandMark from '../../../assets/brand/android/ic_launcher_foreground-xxxhdpi.png'

  /** 一张候选：内置两张（图标 · 出厂插画）＋ 他传的每一张 */
  type Card = {
    choice: SplashChoice
    /** 卡片标题 —— 他要一眼看出这是哪一张 */
    title: string
    /** 副标题：内置说来历，他传的说大小与日期 */
    note: string
    /** 画面字节；图标那张是 null（画兔子） */
    art: string | null
    /** 内置的两张删不得 */
    builtin: boolean
    name?: string
  }

  type View = { k: 'loading' } | { k: 'error'; message: string } | { k: 'ok'; cards: Card[] }

  let view = $state<View>({ k: 'loading' })
  let active = $state<SplashChoice>({ kind: 'shipped' })
  /** 每张图叫什么。名字是**资源的属性**，两端一致（和「选了哪张」相反）*/
  let names = $state<Record<string, { label: string; at: number }>>({})
  /** 正在改名的那一张（图片名 → 输入框里的字） */
  let renaming = $state<{ name: string; value: string } | null>(null)

  /**
   * 起 / 改名字。**空串 = 去掉名字**，回到「我传的图片」那句默认。
   *
   * ★ 时刻由主进程取（同步靠它定「最后一次为准」）—— 界面不掺和那个数，
   *   否则界面的钟和库的钟就是两份。
   */
  /**
   * 卡上显示的名字。**渲染时才算**，不在造卡那一步烘进去 ——
   * 烘进去的话改完名要重造一遍卡，而重造会把轮播**弹回第一张**：
   * 他刚给第五张起完名，屏幕跳到「默认图标」。
   * （上传那条路 2026-09-09 踩过同一个坑，修法也是「别重来一遍」。）
   */
  function titleOf(c: Card | undefined): string {
    if (!c) return ''
    if (c.builtin || !c.name) return c.title
    /**
     * ★ 没起过名时显示的那个默认名**是算出来的，不存**（`defaultLabel` 在 core）。
     *   存下来的话两端各写一次、各带一个时间，他一个字没改名字却会来回翻。
     */
    return names[c.name]?.label || defaultLabel(c.name)
  }

  async function doRename(): Promise<void> {
    const r = renaming
    renaming = null
    if (!r) return
    try {
      /** ★ 只更新名字表，**不重新 load()** —— 见 `titleOf` 那段 */
      names = await window.nyx.res.renameSplash(r.name, r.value)
    } catch (e) {
      sayBad('改名没成：' + cleanMessage(e))
    }
  }
  let at = $state(0)
  let busy = $state(false)
  /** 要删的那一张 —— 彻底删除，先问一句（Dialog） */
  let toDelete = $state<Card | null>(null)


  const fmtSize = (n: number): string =>
    n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`

  async function load(keepAt = false): Promise<void> {
    try {
      const [list, cur, shipped, labelMap] = await Promise.all([
        window.nyx.res.listSplash(),
        window.nyx.res.activeSplash(),
        /* ★ 专读出厂那张（不是 app.splashArt()）—— 它和「当前用哪张」无关。
           第一版借了 app.splashArt()，于是当前是自传图时这张卡会**整个消失**：
           一张会时有时无的卡，比少一张更让人糊涂。 */
        window.nyx.res.shippedSplash(),
        window.nyx.res.splashLabels()
      ])
      names = labelMap
      active = cur
      const cards: Card[] = [
        {
          choice: { kind: 'icon' },
          title: '默认图标',
          note: '内置 · 不需要任何文件，永远可用',
          art: null,
          builtin: true
        }
      ]
      /* 出厂插画：**读得出来就摆**（和当前用哪张无关）。
         读不出来才不摆 —— 摆一张画不出来的卡等于给他一个坏按钮。 */
      if (shipped) {
        cards.push({
          choice: { kind: 'shipped' },
          title: 'Nyx 插画',
          note: '出厂自带 · 跟着软件走，不占你的资源库',
          art: shipped,
          builtin: true
        })
      }
      for (const r of list) {
        cards.push({
          choice: { kind: 'user', name: r.name },
          /**
           * ★ 2026-09-13 使用者：图片可以起名字，而且**两端同一个名字**。
           *   没起过名的仍旧叫「我传的图片」—— 那是默认值，不是一个名字，
           *   所以库里存的是**空**，不是这四个字（存了的话同步过去就成了
           *   「他起过一个叫『我传的图片』的名字」，那是假的）。
           */
          title: '我传的图片',
          note: `${fmtSize(r.bytes)} · ${new Date(r.addedAt).toLocaleDateString('zh-CN')}`,
          art: await window.nyx.res.readSplash(r.name),
          builtin: false,
          name: r.name
        })
      }
      /**
       * ★ 2026-09-09 使用者裁：**「第一页永远固定为 Nyx 图标」**（重命名为「默认图标」），
       *   「添加的自定义图片不要挤到第一页」。
       *
       * 所以进页面**停在第 1 张**（默认图标），不再停在「当前在用的那一张」——
       * 第一版是后者，于是他选过一张自传图之后，一进来看到的就是那张图。
       * ★ 「当前在用的是哪一张」没有因此变模糊：卡上那枚「使用中」徽章还在，
       *   底下还有单独一行「当前这台电脑用的」，两处都说着。
       */
      if (!keepAt) at = 0
      else at = Math.min(at, cards.length - 1)
      view = { k: 'ok', cards }
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  load()

  async function upload(): Promise<void> {
    busy = true
    try {
      const r: SplashRes | null = await window.nyx.res.pickSplash()
      if (r) {
        await load()
        /* ★ 传完**不跳**到新图（第一版是跳的）—— 使用者 2026-09-09：
           「添加的自定义图片不要挤到第一页」。新图排在默认图标之后，位置不抢；
           所以回执里要说清它去哪儿了，否则他会以为没传上。 */
        say('收进资源库了 —— 排在最后，用右边的箭头翻过去，再按「启用」')
      }
    } catch (err) {
      sayBad(cleanMessage(err))
    } finally {
      busy = false
    }
  }

  async function apply(c: Card): Promise<void> {
    busy = true
    try {
      /**
       * ★★ 这里必须是 $state.snapshot —— 不是演习。
       *
       * 直接传 c.choice 会当场报「An object could not be cloned.」：
       * cards 住在 $state 里，里面每一层都是 Svelte 5 的**代理对象**，
       * 而 IPC 要的是结构化克隆得了的普通值。
       * ★ 十六道闸全绿、svelte-check 也绿 —— 这一条只有**真点一下**才看得见。
       *   下次又碰上那句报错，搜这段注释。
       */
      active = await window.nyx.res.setActiveSplash($state.snapshot(c.choice))
      say('下次打开 Nyx 就是这一张了')
    } catch (err) {
      sayBad(cleanMessage(err))
    } finally {
      busy = false
    }
  }

  async function reallyDelete(): Promise<void> {
    const c = toDelete
    toDelete = null
    if (!c?.name) return
    busy = true
    try {
      await window.nyx.res.removeSplash(c.name)
      await load()
      say('从资源库里删掉了')
    } catch (err) {
      sayBad(cleanMessage(err))
    } finally {
      busy = false
    }
  }

  const step = (d: number): void => {
    if (view.k !== 'ok') return
    const n = view.cards.length
    at = (at + d + n) % n
  }

  /**
   * ══ 他选的那张可能已经不在了 ★★（2026-09-14）═════════════
   *
   * 他在这台机器上删了，或者在手机上删了而碑同步过来了。
   * 库里那一条**故意还记着** `user:<不在了的名字>` —— 图加回来时
   * 他的选择要跟着回来（见 `main/splash.ts::deleteUserSplash`）。
   *
   * 于是屏上会出现一个没人想过的态：哪张卡都对不上，
   * 「使用中」**一枚都不亮** —— 而这一页头上写着「任何时候屏上只有一枚」。
   * 那句话当场就是假的。
   *
   * ★ 退法交给 core（`shownChoice`，有用例），而且和**真正画出来的那一帧**
   *   同一条退法链（`main/splash.ts::splashArt`）。两边各写一份的话，
   *   徽章会指一张开机时根本不会出现的图—— 那比一枚都不亮更坏。
   * ★ 它**不写库**：只回答「现在该亮哪一枚」。
   */
  const shown = $derived(
    view.k === 'ok' ? shownChoice(active, view.cards.map((c) => c.choice)) : active
  )
  /** 他选的那张真的不在了吗 —— 底下那行要把这件事说出来 */
  const missing = $derived(active.kind === 'user' && !same(shown, active))

  const activeCard = $derived(
    view.k === 'ok' ? (view.cards.find((c) => same(c.choice, shown)) ?? null) : null
  )
</script>

<div class="sec"><span class="en">启动页</span></div>
<p class="spl-lead">
  打开 Nyx 的那一瞬间看到的那张画面。<b>候选可以有很多张，正在用的只有一张。</b>
</p>
<!--
  ★ 两端的分工要当面说清楚 —— 不说的话他会以为「在这儿选了手机也跟着变」。
    这不是免责声明，是**他 2026-09-09 亲口定的规则**，界面有义务复述。
-->
<p class="spl-lead dim">
  图片资源两端<b>共用</b>（同步之后手机上也看得见这几张）；<b>用哪一张各端自己定</b>——
  在这里选的只管这台电脑。
</p>

{#if view.k === 'error'}
  <div class="errbox" data-testid="splash-error">
    <div class="h">启动页资源读不出来</div>
    <div style="white-space:pre-wrap">{view.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={() => load()}>重试</button></div>
  </div>
{:else if view.k === 'loading'}
  <div class="card blk"><Skel rows={3} widths={['w45', 'w100', 'w70']} testid="splash-skel" /></div>
{:else}
  {@const cards = view.cards}
  {@const cur = cards[at]}

  <!-- ══ 预览 · 模拟真启动页（他的第 3 条）══ -->
  <div class="splwrap" data-testid="splash-preview">
    <button
      class="splnav back"
      data-testid="splash-prev"
      aria-label="上一张"
      disabled={cards.length < 2}
      onclick={() => step(-1)}><Ic n="caret" s={16} /></button
    >

    <div class="splcard">
      <!--
        ★ 这一块就是启动页本身的排法：素色底、中间一块画面（高 ≤62% · 宽 ≤70%）、
          **没有字**。真页面什么样这里就什么样 —— 预览比真页面好看就是在骗人。
      -->
      <div class="splstage">
        {#if cur?.art}
          <img class="art" src={cur.art} alt="" />
        {:else}
          <img class="brandmark" src={brandMark} alt="" />
        {/if}
      </div>
      <div class="splmeta">
        <div class="t">
          {#if renaming && cur?.name === renaming.name}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="splname"
              autofocus
              maxlength={MAX_LABEL}
              placeholder="给这张图起个名字"
              data-testid="splash-rename-input"
              bind:value={renaming.value}
              onblur={doRename}
              onkeydown={(e) => {
                if (e.key === 'Enter') doRename()
                if (e.key === 'Escape') renaming = null
              }}
            />
          {:else}
            {titleOf(cur)}
          {/if}
          {#if cur && same(cur.choice, shown)}
            <span class="splnow" data-testid="splash-inuse">使用中</span>
          {/if}
          <!--
            ★ 只有他自己传的图能起名 —— 「默认图标」和「Nyx 插画」是出厂的两档，
              改了名字之后两端对不上（对面的出厂档不跟着他的库走）。
          -->
          {#if cur && !cur.builtin && cur.name && !renaming}
            <button
              class="lnk"
              data-testid="splash-rename"
              onclick={() => (renaming = { name: cur.name!, value: names[cur.name!]?.label ?? '' })}
              >改名</button
            >
          {/if}
        </div>
        <div class="n">{cur?.note}</div>
      </div>
      <div class="splact">
        <button
          class="btn pri"
          data-testid="splash-apply"
          disabled={busy || (cur ? same(cur.choice, shown) : true)}
          onclick={() => cur && apply(cur)}
          >{cur && same(cur.choice, shown) ? '正在用这一张' : '启用这一张'}</button
        >
        {#if cur && !cur.builtin}
          <button class="btn sm dgr" data-testid="splash-del" onclick={() => (toDelete = cur)}
            >从资源库删除</button
          >
        {/if}
      </div>
    </div>

    <button
      class="splnav"
      data-testid="splash-next"
      aria-label="下一张"
      disabled={cards.length < 2}
      onclick={() => step(1)}><Ic n="caret" s={16} /></button
    >
  </div>

  <!-- 第几张 / 共几张 —— 轮播不说这个，他不知道还有没有下一张 -->
  <div class="spldots" data-testid="splash-dots">
    {#each cards as c, i (i)}
      <span class="d" class:on={i === at} class:use={same(c.choice, shown)}></span>
    {/each}
    <span class="c">{at + 1} / {cards.length}</span>
  </div>

  <!-- ★ 他反复强调的那一条：候选多个 ≠ 同时启用多个。所以单独一行说「当前是哪一张」 -->
  <div class="row-read splcur" data-testid="splash-current">
    <span class="k">当前这台电脑用的</span>
    <span class="v" data-testid="splash-current-v">{activeCard?.title ?? '出厂插画'}</span>
  </div>
  <!--
    ══ 他选的那张已经不在了 ★★（2026-09-14）══════════════════════
    ★ **两句，缺一不可**（这半句是 Android 那边提醒的，它比我先想到）：
      ① 发生了什么 —— 不说的话他只会觉得启动页莫名其妙换了
      ② **他不用重新挑** —— 库里那条选择是故意留着的（见 `deleteUserSplash`）。
         不说出来的话他以为得重挑一次，那正好把「留着它」的全部价值抵消掉。
    ★ 单独一行、不塞进上面那句：上面那句回答「现在是哪一张」，
      这句回答「为什么不是你选的那张」—— 两个问题，挤在一行里两个都答不清。
  -->
  {#if missing}
    <div class="row-read splgone" data-testid="splash-gone">
      <span class="k"></span>
      <span class="v"
        >你之前选的那张<b>已经不在了</b>（在这台电脑或另一端删掉了）。
        它要是<b>被加回来</b>，这台电脑会自动用回它 —— 不用重新挑。</span>
    </div>
  {/if}

  <div class="splbar">
    <button class="btn" data-testid="splash-upload" disabled={busy} onclick={upload}>
      <Ic n="plus" s={16} /> 添加图片
    </button>
    <!-- ★ 失败要看得见：打不开文件夹这件事它自己不会报，屏上沉默 = 他以为自己没点中 -->
    <button
      class="btn"
      data-testid="splash-folder"
      onclick={() =>
        void window.nyx.res
          .openSplashFolder()
          .catch((err) => sayBad('打不开资源文件夹：' + cleanMessage(err)))}>打开资源文件夹</button
    >
    <span class="sp"></span>
    <span class="dim">webp / png / jpg · 单张 ≤2MB</span>
  </div>
{/if}

{#if toDelete}
  <Dialog
    title="从资源库删掉这张图？"
    body="这是彻底删除，回收站里也找不回来。（如果它正在用，会自动退回出厂插画。）"
    confirmLabel="删掉"
    danger
    testid="splash-del-dlg"
    onconfirm={reallyDelete}
    oncancel={() => (toDelete = null)}
  />
{/if}
