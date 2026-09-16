<script lang="ts">
  /**
   * 样式一览 —— **DS v5 现在长什么样，一页看完。**
   *
   * ★ 它不是产品功能，是给人看的对照表：改了 `tokens.css` / `mobile.css` 之后
   *   打开这一页，能一眼看出有没有把别处弄坏。入口 = Settings › ABOUT 连点五下构建指纹。
   *
   * ★★ 2026-09-01 整页重写（F-005）。**旧版是 v3 时代的**（`--accent` / `--text` /
   *   `--fs-1..8` / `.card` / `.row` / `.pdot`），那些令牌与类在 v5 里一个都不存在 ——
   *   直接给它一个入口只会做出一页**误导人的空白**，所以入口和内容必须一起来。
   *
   * ★★★ **值不写死，全部现场从 CSS 读**（`getComputedStyle`）。
   *   写死就是第二份判据：改了 `tokens.css` 而忘了改这里，这一页就会
   *   **理直气壮地展示错的颜色** —— 而它存在的唯一理由就是「让人相信眼前这份是真的」。
   *
   * ★ 旧版那两个「播一份开发数据 / 清掉」按钮**删掉了**：使用者手机上现在装着
   *   真实数据，一个往库里写假数据的按钮离 Settings 只有两下（D-249 / D-346）。
   *   要造数据就用 `tools/device/eval.mjs`，那条路是有意难走的。
   *
   * ★ D-227：这一页一行样式都不写；要新样式就加进 `mobile.css`。
   */
  import Toggle from '../lib/Toggle.svelte'

  /** 面 · 墨 · 强调 —— 名字与用途来自 DS §1.2/§1.3/§1.4，值现场读 */
  const SURFACES: [string, string][] = [
    ['--bg', '页面底'],
    ['--paper', '浮层面 · 卡'],
    ['--surface', '安静区块 · 组沉底'],
    ['--chip', '按下 · 选中'],
    ['--soft', '控件面 · 主按钮 · Toggle ON'],
    ['--soft-bd', '控件描边（与 --soft 成对）']
  ]
  const INKS: [string, string][] = [
    ['--ink', '正文'],
    ['--ink-2', '次级'],
    ['--mute', '说明 · ★ U-015：只许坐在白 / bg / aqua-50 上'],
    ['--faint', '★ U-015 补：只给不用读的（刻度 · 占位 · 禁用）'],
    ['--line', '发丝线（行间）'],
    ['--line-2', '结构线 · 组顶线']
  ]
  const ACCENTS: [string, string][] = [
    ['--violet', '线与图形'],
    ['--violet-2', '压在 --soft 上的字'],
    ['--corp', '真实语料徽章'],
    ['--warn', '警示 · 破坏性'],
    ['--mark', '荧光笔 · 只画在语言材料里的词上（U-014：粉底只给行内小件）'],
    ['--color-text-on-warm', '暖底（引文块）上要读的字'],
    ['--color-deep', '★ 只做标识 / 轨 / 记号，不做容器（DS-Q20）']
  ]

  /**
   * 五声部 · DS §2 —— `[字号令牌, 字族令牌, 样例]`。
   * ★ 贯到底的那条规则：**屏上凡是「机器知道的事」都是等宽的，
   *   凡是「语言本身」都是衬线的** —— 这一段就是拿来看它有没有守住。
   */
  const VOICES: [string, string, string][] = [
    ['--fs-display', '--display', 'Nyx'],
    ['--fs-word', '--display', 'stairwell'],
    ['--fs-body-lang', '--serif', 'She kept it to herself.'],
    ['--fs-body-ui', '--ui', 'Interface text'],
    // ★ 中文没有自己的字族令牌：思源黑体 Noto Sans SC 是四族**共同的兜底**，
    //   而且必须排在纯拉丁兜底之后（D-342④ —— 排前面会让拉丁标点按全角渲染，
    //   页面上看不出来，只能靠量）。所以这一行走 --serif。
    ['--fs-body-zh', '--serif', '语言本身用衬线，机器知道的事用等宽'],
    ['--fs-meta', '--mono', 'META · 09.01 · 0042'],
    ['--fs-micro', '--mono', 'SECTION'],
    ['--fs-micro-zh', '--ui', '微标签中文 · 字距 .05em']
  ]

  /** 圆角阶梯 · DS-Q4 / DS-Q10 定案 —— 一眼看出「哪一档给谁」 */
  const RADII: [string, string][] = [
    ['--r-ctl', '控件：按钮 · 图标钮'],
    ['--r-ctl-sm', '控件 · 小号（高 34 那一档）'],
    ['--r-card', '卡 · 面板 · 浮层'],
    ['--r-sheet', 'Sheet —— 只上两角'],
    ['--r-search', '搜索框（本端查词框是底线式，暂无落点）'],
    ['--r-paper', '纸面印刷件：判分表格 · 稿纸'],
    ['--r-pill', '真胶囊：Toggle 轨 · 圆点 · 进度']
  ]

  /** 进度五档 · U-013 —— 4px · 全圆角，两端同一份配方 */
  const PROGRESS: [string, string][] = [
    ['--progress-primary', '在做'],
    ['--progress-secondary', '次一条线'],
    ['--progress-complete', '做完了'],
    ['--progress-attention', '该看一眼'],
    ['--progress-inactive', '停着']
  ]

  /**
   * sprite 里的**全部** 32 枚 —— 清单要跟 `Sprite.svelte` 对得上（下面有闸）。
   * ★ 四档实尺一起看才发现得了糊：§4.4b 的三条修法全是这么找出来的
   *   （settings 读不出滑轨 · production 的线像画错 · star 16px 不掉芒）。
   */
  const ICONS = [
    'nyx-core', 'nyx-core-o', 'nyx-star', 'nyx-star-o', 'nyx-star-16',
    'nyx-study', 'nyx-study-o', 'nyx-lookup', 'nyx-lookup-o',
    'nyx-vault', 'nyx-vault-o', 'nyx-settings', 'nyx-settings-o',
    'nyx-grade-ok', 'nyx-grade-near', 'nyx-grade-again', 'nyx-grade-again-s',
    'nyx-caret', 'nyx-back', 'nyx-close', 'nyx-plus', 'nyx-more', 'nyx-grip',
    'nyx-search', 'nyx-fix', 'nyx-speak', 'nyx-sync',
    'nyx-recollect', 'nyx-both', 'nyx-project', 'nyx-unit', 'nyx-lecture',
    // ★ 第 33、34 枚，2026-09-01 新画，**都还没上过真机** —— 就是要在这一页上看。
    //   check  = DS §16.3 明写「Chip 选中要长一个」，从来没画过（两端在用字符）
    //   delete = Windows 侧栏的 🗑 是 emoji，D-327 禁令
    'nyx-check',
    'nyx-delete'
  ]
  const SIZES = [32, 24, 18, 16]

  let demoOn = $state(true)

  /** 现场读一个 CSS 变量的计算值 —— 这一页的立身之本，见文件头 */
  function live(name: string): string {
    if (typeof document === 'undefined') return ''
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }
</script>

<!-- ★ 这一页**不画自己的返回箭头**（IX-03：每个面至多一个出口）。
     它是 Settings 的一个二级页，外壳那个箭头已经在了 ——
     此前两个箭头上下叠着，做的还是同一件事（都是 route.pop()）。
     真机截图上一眼看得见，PC 上看不出来。 -->
<div class="view">
  <div class="sec">Surfaces</div>
  <div class="set">
    {#each SURFACES as [t, use] (t)}
      <div class="li ro">
        <span class="pdot" style="background:var({t}); border:1px solid var(--line-2)"></span>
        <span class="g"><span class="zh s12">{t}</span><small class="zh">{use}</small></span>
        <span class="m">{live(t)}</span>
      </div>
    {/each}
  </div>

  <div class="sec">Ink</div>
  <div class="set">
    {#each INKS as [t, use] (t)}
      <div class="li ro">
        <span class="pdot" style="background:var({t}); border:1px solid var(--line-2)"></span>
        <span class="g"><span class="zh s12" style="color:var({t})">{t}</span><small class="zh">{use}</small></span>
        <span class="m">{live(t)}</span>
      </div>
    {/each}
  </div>

  <div class="sec">Accent</div>
  <div class="set">
    {#each ACCENTS as [t, use] (t)}
      <div class="li ro">
        <span class="pdot" style="background:var({t}); border:1px solid var(--line-2)"></span>
        <span class="g"><span class="zh s12">{t}</span><small class="zh">{use}</small></span>
        <span class="m">{live(t)}</span>
      </div>
    {/each}
  </div>

  <!-- ★ 五声部：屏幕上凡是「机器知道的事」都是等宽的，凡是「语言本身」都是衬线的 -->
  <div class="sec">Voices</div>
  <div class="set">
    {#each VOICES as [t, fam, sample] (t)}
      <div class="li ro" style="align-items:baseline">
        <span class="g">
          <span style="font-family:var({fam}); font-size:var({t}); color:var(--ink); line-height:1.5">{sample}</span>
        </span>
        <span class="m">{t.replace('--fs-', '')} {live(t)}</span>
      </div>
    {/each}
  </div>

  <!-- ★ §10.2c 的三种行：这一段就是判据本身，长得不一样才算过 -->
  <div class="sec">Rows · §10.2c</div>
  <div class="set">
    <div class="li ro">
      <span class="g"><span class="zh s12">只读行</span><small class="zh">机器的事实 · 没有 caret，按下去没反应</small></span>
      <span class="m">42</span>
    </div>
    <button class="li hit">
      <span class="g"><span class="zh s12">动作行</span><small class="zh">点了会发生事 · --ink 标签 + caret</small></span>
      <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
    </button>
    <div class="li">
      <span class="g"><span class="zh s12">开关行</span><small class="zh">Toggle 就是它的脸 · 行本身不可点</small></span>
      <Toggle on={demoOn} label="示例开关" onchange={() => (demoOn = !demoOn)} />
    </div>
    <!-- ★ 第三态「正在生效」（ST-Q6 · B3）：旋钮停在半路 + 呼吸，期间点不动。
         不转圈 —— 全应用不用 spinner。 -->
    <div class="li ro">
      <span class="g"><span class="zh s12">开关 · 正在生效</span><small class="zh">写设置 / 问系统授权要等的那一段（第三态）</small></span>
      <Toggle on={demoOn} busy label="示例开关正在生效" onchange={() => {}} />
    </div>
    <div class="li sunkli p1">
      <span class="g"><small class="zh">二级从属行（.sunkli p1）—— 灰 = 从属于上面那一行（§10.2d）</small></span>
    </div>
    <!-- ★ 第四种：键值行（B7 · I-176）。样例特意用一串**没有空格可断**的长等宽 ——
         那正是它坏掉的条件；这一行在这里就是拿来看它不坏的。 -->
    <div class="li ro kv">
      <span class="g"><span class="zh s12">键值行 .kv</span>
        <small class="zh">值长时值换行 · 按字符可断 · 标签列有最小宽（负向对照 I-176）</small></span>
      <span class="m">core 1104bb5 · schema v36 · 指纹 cadb369e52c0e</span>
    </div>
  </div>

  <!-- ★ 五档（U-012 / BUTTON_SYSTEM §一）。Accent（粉实心）**本端一个调用点都没有** ——
       全应用配额 ≤3 处，今天是 0，所以不给它一个没人用的类名（§六⑤：不许两个名字一套样式）。 -->
  <div class="sec">Buttons · 五档<span class="zh">高 40 · 圆角 10</span></div>
  <div class="btnrow">
    <button class="btn pri">Primary</button>
    <button class="btn">Secondary</button>
    <button class="btn sec2">Outline</button>
    <button class="btn dg">Destructive</button>
    <button class="btn gh">Ghost</button>
  </div>
  <div class="sec">Buttons · 小号<span class="zh">高 34 · 圆角 8</span></div>
  <div class="btnrow">
    <button class="btn sm pri">Primary</button>
    <button class="btn sm">Secondary</button>
    <button class="btn sm sec2">Outline</button>
    <button class="pill">细 pill</button>
    <button class="act">工具条</button>
  </div>
  <!-- ★ 十一态里能用 CSS 表达的：default（上面）· pressed（按住看）· active · disabled。
       hover 触摸端不存在；focus 只在键盘走到时出现；selected 属 Segmented；
       **success / error 一律不落在按钮上**（BTN-Q2）—— 所以这里没有绿的也没有打勾的。 -->
  <div class="sec">Buttons · 态</div>
  <div class="btnrow">
    <button class="btn on">active（模式开着）</button>
    <button class="btn" disabled>disabled</button>
    <button class="txt">Navigation ›</button>
  </div>

  <div class="sec">Radius<span class="zh">DS-Q4 定案</span></div>
  <div class="set">
    {#each RADII as [t, use] (t)}
      <div class="li ro">
        <span class="kswatch" style="border-radius:var({t})"></span>
        <span class="g"><span class="zh s12">{t}</span><small class="zh">{use}</small></span>
        <span class="m">{live(t)}</span>
      </div>
    {/each}
  </div>

  <div class="sec">Progress · 五档<span class="zh">4px · 全圆角</span></div>
  <div class="set">
    {#each PROGRESS as [t, use] (t)}
      <div class="li ro">
        <span class="prog kprog"><i style="width:62%; background:var({t})"></i></span>
        <span class="g"><span class="zh s12">{t.replace('--progress-', '')}</span><small class="zh">{use}</small></span>
        <span class="m">{live(t)}</span>
      </div>
    {/each}
  </div>

  <div class="sec">Tags</div>
  <div class="btnrow">
    <span class="tag t-v">B</span>
    <span class="tag t-m">SILENT</span>
    <span class="tag t-w zh">攻坚</span>
  </div>

  <!-- ★ §4.4b：小尺寸是另一张图 —— 四档一起看才发现得了糊 -->
  <div class="sec">Icons · 四档实尺</div>
  <div class="set">
    {#each ICONS as name (name)}
      <div class="li ro">
        <span class="g" style="display:flex; align-items:center; gap:14px; color:var(--ink)">
          {#each SIZES as s (s)}
            <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true"><use href="#{name}" /></svg>
          {/each}
        </span>
        <span class="m">{name.replace('nyx-', '')}</span>
      </div>
    {/each}
  </div>

  <!-- ★ Banner（B4）：全应用唯一「不能手动关」的那一型。这里是长相，不是真状态。 -->
  <div class="sec">Banner<span class="zh">常驻条 · 一句话 + 一颗按钮去修</span></div>
  <div class="banner" role="presentation">
    <span class="bn-t zh">已经连续 3 次没同步成功 —— 这段时间的学习记录只在这台手机上。</span>
    <button class="btn sm"><span class="zh">去看看</span></button>
  </div>

  <!-- ★ 骨架（B2）：200ms 之内不显示 —— 这一页上它已经过了那 200ms，所以看得见。 -->
  <div class="sec">Loading<span class="zh">骨架 · 不转圈</span></div>
  <div class="pcard breathe">
    <div class="sk w90"></div><div class="sk w70"></div><div class="sk w45"></div>
  </div>

  <div class="sec">Empty</div>
  <div class="empty tight">
    <div class="t zh2">这里还没有东西</div>
    <div class="s">空态是常态，不是边角料 —— 新装的机器在第一次同步之前什么都没有。</div>
  </div>
</div>
