<script lang="ts">
  import { AUTO_SYNC_ON_BOOT } from '@core/sync/copy.ts'
  import { SILENCE_FILTER_NAME } from '@core/silence.ts'
  /**
   * 样式一览（开发期实物页）· 2026-09-07 · Nyx-DS「总标准」会话
   *
   * 它不是产品页面，是**判据的实物**：使用者要逐条确认
   * docs/ui/DESIGN_SYSTEM.md · BUTTON_SYSTEM.md · UI_STATE_MATRIX.md · NOTIFICATION_RULES.md
   * 末尾那几张「等你确认」清单，光看文字定不了视觉，得看见东西。
   *
   * ★ 三条约束（与 kit.css 头上那三条同一套）：
   *   ① 一行内联样式都没有，全部 class 在 src/renderer/styles/kit.css（D-227）
   *   ② 不碰任何业务逻辑与既有组件；删掉这两个文件，软件其余部分不变
   *   ③ 颜色全部走令牌，一行 HEX 都没有
   *
   * 入口：设置 › 数据 › 「样式一览」。不进主导航。
   */
  import Ic from './Ic.svelte'
  import { TRASH_KEEP_TEXT } from '@core/sql/trash.ts'

  /**
   * 字体：**已定案，这里只剩两档实物**（2026-09-08 UI-Win 第一轮）
   *
   * 使用者 2026-09-07 选了 D，并且裁「桌面一套、手机一套，不为了统一牺牲任何一端」（U-017）。
   * 于是 A / B / C 三个候选连同它们打包的五族字（Instrument Serif · Literata ·
   * Schibsted Grotesk · Martian Mono · 思源宋体）一起退役 —— **作废的形留在这一页，
   * 下一个人会以为它还是个选项**（这一页删标志候选时用的就是这条理由）。
   *
   * 留下的两档：
   *   D  = Windows 现役（全是系统自带，零打包）
   *   D′ = Android 那一套的预览（DS §2.4 明说要留作参考）
   *        ★ 这台机器上没装 Source Serif 4 / Inter，那两行现在看到的是**兜底字**
   *          （Georgia / Segoe UI）；换字体包那一轮换成真货再复看一次。
   */
  const FONTS = [
    {
      k: 'f-sys', n: 'D · Windows 现役（系统自带，零打包）',
      d: '展示 Sitka Display · 语言 Sitka Text · 界面 Segoe UI Variable · 机器 Cascadia Mono · 中文 微软雅黑',
      ship: '✅ 这一页现在看到的就是它'
    },
    {
      k: 'f-dp', n: 'D′ · Android 那一套（能打包的等价字）',
      d: '展示 / 语言 Source Serif 4 · 界面 Inter · 机器 Cascadia Mono · 中文 思源黑体',
      ship: '◐ 本机没装前两族，现在看到的是兜底字；换包那轮复看'
    }
  ]

  // 按钮五档：class 后缀 + 中文名 + 一句「什么时候用」
  const TIERS = [
    { k: 'k-pri', name: 'Primary', use: '一屏唯一的主动作' },
    { k: 'k-sec', name: 'Secondary', use: '并列的第二选择' },
    { k: 'k-out', name: 'Outline', use: '工具条 · 行内动作' },
    { k: 'k-acc', name: 'Accent', use: '只给特殊 / 重要（全应用 ≤3 处）' },
    { k: 'k-gho', name: 'Ghost', use: '取消 · 关闭' }
  ]
</script>

<div class="kit" data-testid="kit-panel">
  <h2>样式一览</h2>
  <p class="kit-lead">
    这一页把总标准里的按钮 · 反馈 · 状态 · 进度 · 标签 · 输入画成实物，用的全是新的颜色令牌。
    <b>颜色是你定的</b>；尺寸（控件高 36 · 小号 28 · 圆角 10 · 面板圆角 14）与形态已随 2026-09-07 那 53 条一起定案。
    这页不进主导航，只在设置 › 数据 里。
  </p>

  <!-- ═══ 按钮五档 × 状态 ═══ -->
  <div class="kit-sec">按钮 · 五档 × 状态</div>
  <div class="kit-grid" data-testid="kit-buttons">
    <div class="kit-hd"></div>
    <div class="kit-hd">default</div>
    <div class="kit-hd">hover</div>
    <div class="kit-hd">focus</div>
    <div class="kit-hd">pressed</div>
    <div class="kit-hd">disabled</div>
    <div class="kit-hd">loading</div>
    {#each TIERS as t (t.k)}
      <div class="kit-rowname">{t.name}</div>
      <div><button class="kit-btn {t.k}">开始学</button></div>
      <div><button class="kit-btn {t.k} is-hover">开始学</button></div>
      <div><button class="kit-btn {t.k} is-focus">开始学</button></div>
      <div><button class="kit-btn {t.k} is-pressed">开始学</button></div>
      <div><button class="kit-btn {t.k}" disabled>开始学</button></div>
      <div><button class="kit-btn {t.k}" disabled>正在连…</button></div>
    {/each}
  </div>
  <p class="kit-note">
    每一档右边那句话：{TIERS.map((t) => t.name + ' = ' + t.use).join(' · ')}。
    <b>loading</b> 只换文案并钉宽，不转圈；<b>success / error 不落在按钮上</b> —— 结果由下面那几种回执给（BTN-Q2）。
  </p>

  <div class="kit-sec">按钮 · 其余形态</div>
  <div class="kit-row">
    <button class="kit-btn k-pri k-sm">小号 Primary</button>
    <button class="kit-btn k-out k-sm">小号 Outline</button>
    <button class="kit-btn k-out is-active">active（模式开着）</button>
    <button class="kit-btn k-dgr">删除</button>
    <button class="kit-iconbtn" aria-label="更多">⋯</button>
    <button class="kit-iconbtn" aria-label="朗读">◁</button>
    <div class="kit-seg">
      <button class="k-on">近 7 天</button>
      <button>近 30 天</button>
      <button>全部</button>
    </div>
    <button class="kit-sw k-on" aria-label="自动同步" aria-pressed="true"></button>
    <button class="kit-sw" aria-label="系统语音" aria-pressed="false"></button>
  </div>
  <p class="kit-note">
    危险动作 = 粉字不填色（BTN-Q3）· 图标钮 28×28 且必须有名字 · 分段选择用下划线不做胶囊堆 · 开关轨 ON 用主色。
  </p>

  <!-- ═══ 五种反馈载体 ═══ -->
  <div class="kit-sec">反馈 · 五种载体各管什么</div>
  <div class="kit-three" data-testid="kit-feedback">
    <div class="kit-panel">
      <div class="kit-inline">Inline · 就地一行：这把 key 用不了（服务商说没通过验证）</div>
      <p class="kit-note">与某个控件绑着的话，不自动消失，改对了自己走。</p>
      <div class="kit-tip">Tooltip · 只解释一个词</div>
    </div>
    <div class="kit-panel">
      <div class="kit-toast">
        <span>存到 计划 › Unit 3 › Lecture 04</span>
        <span class="kit-undo">撤销</span>
      </div>
      <p class="kit-note">Toast · 回执条：4 秒（带撤销 6 秒）。说真实结果，不说「成功」。</p>
      <div class="kit-row">
        <span>同步</span><span class="kit-badge">12</span>
        <span>到期</span><span class="kit-badge k-warn">3</span>
      </div>
      <p class="kit-note">Badge · 数出来的事实，数是 0 时不显示。</p>
    </div>
    <div class="kit-panel">
      <div class="kit-banner">
        <span>同步已经连续失败 3 次</span>
        <span class="kit-sp"></span>
        <button class="kit-btn k-out k-sm">去看看</button>
      </div>
      <p class="kit-note">Banner · 有事挡着他往下走时才出现，条件消失才走，不给手动关。</p>
    </div>
  </div>

  <div class="kit-sec">反馈 · 打断层（只给破坏性动作与必须他填的东西）</div>
  <div class="kit-dialog" data-testid="kit-dialog">
    <h4>删除「proofrock」？</h4>
    <p>移到回收站，{TRASH_KEEP_TEXT}。</p>
    <div class="kit-row">
      <button class="kit-btn k-gho">取消</button>
      <button class="kit-btn k-dgr">删除</button>
    </div>
  </div>
  <p class="kit-note">
    确认框说真正会发生什么，<b>不写「不可撤销」「永久删除」</b> —— 那是假的，而且在吓唬人。默认焦点在「取消」。
  </p>

  <!-- ═══ 空 / 加载 / 错误 ═══ -->
  <div class="kit-sec">状态 · 空 / 加载 / 错误</div>
  <div class="kit-three" data-testid="kit-states">
    <div class="kit-panel">
      <div class="kit-empty">
        <div class="kit-mark"></div>
        <h5>这个 Lecture 还没有内容</h5>
        <p>贴一段原文进来，就能开始分析。</p>
        <button class="kit-btn k-pri k-sm">贴一段文字</button>
      </div>
    </div>
    <div class="kit-panel">
      <div class="kit-skel">
        <i class="k-w70"></i><i></i><i class="k-w45"></i><i></i><i class="k-w70"></i>
      </div>
      <p class="kit-note">加载 = 骨架呼吸，占的正是内容将要占的位置。<b>全应用不转圈</b>。</p>
    </div>
    <div class="kit-panel">
      <div class="kit-err">
        <div class="kit-h">这段没分析成</div>
        <p>模型那边超时了。已经分析完的 12 条都存下来了。</p>
        <div class="kit-row">
          <button class="kit-btn k-sec k-sm">重试</button>
          <button class="kit-btn k-out k-sm">去设置</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ 进度 · 标签 · 输入 ═══ -->
  <div class="kit-sec">进度 · 高 4px · 全圆角</div>
  <div class="kit-progs" data-testid="kit-progress">
    <span class="kit-plab">primary · 在做</span>
    <div class="kit-prog"><i class="k-p55"></i></div>
    <span class="kit-plab">secondary · 次要</span>
    <div class="kit-prog"><i class="k-sec k-p35"></i></div>
    <span class="kit-plab">complete · 做完</span>
    <div class="kit-prog"><i class="k-done k-p100"></i></div>
    <span class="kit-plab">attention · 欠账</span>
    <div class="kit-prog"><i class="k-att k-p80"></i></div>
    <span class="kit-plab">inactive · 停着</span>
    <div class="kit-prog"><i class="k-off k-p20"></i></div>
  </div>

  <div class="kit-sec">标签</div>
  <div class="kit-row" data-testid="kit-tags">
    <span class="kit-tag">中性</span>
    <span class="kit-tag k-a">主动 · 产出线</span>
    <span class="kit-tag k-b">被动 · 认读线</span>
    <span class="kit-tag k-know">知识点</span>
  </div>

  <div class="kit-sec">输入</div>
  <div class="kit-row" data-testid="kit-inputs">
    <input class="kit-inp" placeholder="默认" />
    <input class="kit-inp is-focus" placeholder="聚焦" />
    <input class="kit-inp k-bad" placeholder="填错了" />
    <input class="kit-inp" placeholder="不能填" disabled />
  </div>
  <p class="kit-note">校验错误今天两端都没有形态（ST-Q5）—— 这里画的是提案：框变色 + 下方一行人话。</p>

  <!-- ═══ 表面层级 ═══ -->
  <div class="kit-sec">表面 · 面最多两层，第二层必须更亮</div>
  <div class="kit-surf" data-testid="kit-surfaces">
    <div class="k-l0">页面底</div>
    <div class="k-l1">安静区 · 侧栏</div>
    <div class="k-l2">从属块</div>
    <div class="k-l3">面 · 卡 · 浮层</div>
    <div class="k-l4">暖底 · 语言材料</div>
    <div class="k-l5">深色窄带</div>
  </div>
  <p class="kit-note">
    深色只做窄带（专注态顶条 · 多选条），<b>不做容器</b>：单处面积上限一个行高，不许四边完整封闭（CL-Q6）。
  </p>


  <!-- ═══ 参考图落点（DS §九～§十二 · 全部我提的）═══ -->
  <div class="kit-sec">参考图落点 · 双语标签 · 状态胶囊 · 星粒子 · 图标选中态</div>
  <p class="kit-note">
    下面这一片来自你发的那张 Aqua / Teal / Pink 参考图 —— 我把它当<b>手感</b>提炼，不照图画页面（U-008）。
    每一样都对着确认单里的一条（DS-Q10～Q17）。
  </p>

  <div class="kit-two" data-testid="kit-bilingual">
    <div class="kit-pane">
      <div class="kit-bl">
        <span class="k-en">All Projects</span>
        <span class="k-zh">我的项目</span>
      </div>
      <div class="kit-plainrow">Reddit · r/writing<span class="kit-chip k-doing">学习中</span></div>
      <div class="kit-plainrow">2026 春季阅读<span class="kit-chip k-done2">已完成</span></div>
      <div class="kit-plainrow">Assist 收进来的<span class="kit-chip k-due">3 条到期</span></div>
      <div class="kit-plainrow k-quiet">旧材料<span class="kit-chip k-mute">{SILENCE_FILTER_NAME}</span></div>
      <p class="kit-note">双语标签（DS-Q11）+ 状态胶囊四档（不可点，无边框；终点那档才有发丝边）。分区靠标题与留白，<b>不画分隔线</b>。</p>
    </div>
    <div class="kit-pane">
      <div class="kit-bl">
        <span class="k-en">Recent Lectures<span class="kit-star k-s1"><Ic n="star-16" s={12} /></span><span class="kit-star k-s2"><Ic n="star-16" s={7} /></span></span>
        <span class="k-zh">最近学习</span>
      </div>
      <div class="kit-num"><b>36</b><span>个知识点</span></div>
      <div class="kit-pct">
        <div class="kit-prog"><i class="k-p55"></i></div><span>55%</span>
      </div>
      <div class="kit-num k-sm"><b>012</b><span>/ 039 今天</span></div>
      <p class="kit-note">数字是主角、标签是注脚；进度条右侧跟一个等宽百分比（DS §十一）。星粒子两级、透明度 30–45%、一屏 ≤3 粒（DS-Q12）。</p>
    </div>
  </div>

  <div class="kit-row" data-testid="kit-iconsel">
    <span class="kit-ib"><Ic n="study" s={16} /></span>
    <span class="kit-ib is-on"><Ic n="study" s={16} /></span>
    <span class="kit-ib"><Ic n="vault" s={16} /></span>
    <span class="kit-ib is-on"><Ic n="vault" s={16} /></span>
    <span class="kit-ib"><Ic n="search" s={16} /></span>
    <span class="kit-ib is-on"><Ic n="search" s={16} /></span>
    <input class="kit-inp k-round" placeholder="搜索框更圆一档（半径 18）" />
  </div>
  <p class="kit-note">
    图标选中态：<b>不换实心，放进一个淡水色圆角方块里</b>（DS-Q17）。图标现在 13px，这里画的是 16px（DS-Q22）。
    左右两枚一对，右边那枚是选中。
  </p>

  <div class="kit-sec">按钮高度 · 定案 36（32 留在这里做对照）</div>
  <div class="kit-row" data-testid="kit-heights">
    <button class="kit-btn k-pri">开始学 · 36</button>
    <button class="kit-btn k-pri k-h32">开始学 · 32</button>
    <button class="kit-btn k-out">认读 · 36</button>
    <button class="kit-btn k-out k-h32">认读 · 32</button>
  </div>
  <p class="kit-note"><b>定案：桌面 36 · 小号 28 · 手机 40</b>（BTN-Q1，2026-09-07，取你原话 36–40 的下限）。这一页所有按钮画的都是 36；后面那两颗 32 是我提过、未采纳的那一档，留着做对照。</p>

  <div class="kit-sec">知识点卡 · 从上往下读的顺序</div>
  <div class="kit-card" data-testid="kit-entry">
    <span class="kit-star k-corner"><Ic n="star-16" s={12} /></span>
    <div class="k-word">threshold</div>
    <div class="k-ipa">/ˈθreʃ.hoʊld/</div>
    <button class="kit-ib is-on k-round2" aria-label="朗读"><Ic n="speak" s={16} /></button>
    <div class="k-gloss">the level at which something starts to happen</div>
    <div class="k-eg">Her pain threshold is remarkably high.</div>
    <div class="k-src">Reddit · r/writing · 2026-09-05</div>
  </div>
  <p class="kit-note">词 → 音 → 听 → 义 → 例 → 出处，顺序不许调（DS §10.4）。例句坐在暖底上；右上角一颗粉星 = 这是知识点。喇叭独占一行，不跟在词后面。</p>

  <div class="kit-sec">启动页</div>
  <p class="kit-note">
    <b>定案（使用者 2026-09-07）：启动页上没有字</b> —— 不放字标 · 不放标语 · 不加水光，
    素色底，中间只有一块画面：<b>有图用插画 · 没图用图标（只要兔子）</b>。
    版式与回退规则写在 <code>docs/ui/DESIGN_SYSTEM.md §12</code>，实样 <code>shots/brand/splash-final.png</code>。
    早先那两个带字标的方案已作废，不再画在这一页。
  </p>

  <!-- ═══ 标志（已定案，候选不再画在这一页）═══ -->
  <div class="kit-sec">标志</div>
  <p class="kit-note">
    <b>定案：使用者给的水獭图标</b>（2026-09-07）。两轮共十二个候选（L1–L6 · M1–M6）与暂定过的 M3
    都已作废，记录留在 <code>docs/ui/DESIGN_SYSTEM.md §9.1b～§9.1d</code>，不再画在这一页 ——
    这一页只放<b>还在用的东西</b>，作废的形留在这里会让人以为它还是个选项。
    全套图标资源在 <code>assets/brand/</code>，实样 <code>shots/brand/icons.png</code>。
  </p>

  <!-- ═══ 字体候选 ═══ -->
  <div class="kit-sec">字体 · 已定案（D）· 两端各一档</div>
  <p class="kit-note">
    <b>定案（2026-09-07）：你选 D，而且两端不强行统一</b>（U-017）。Windows 原样用 D —— 四族全是这台机器上
    已经装好的字，<b>一个字体文件都不打包</b>；手机上没有这几族，Android 用气质对齐的开源集 D′。
    早先的 A / B / C 三个候选与它们打包的五族字（Instrument Serif · Literata · Schibsted Grotesk ·
    Martian Mono · 思源宋体）已经退役，不再画在这一页。
  </p>

  {#each FONTS as f (f.k)}
    <div class="kit-spec {f.k}" data-testid="kit-font-{f.k}">
      <div class="s-head"><b>{f.n}</b><span>{f.ship}</span></div>
      <div class="s-desc">{f.d}</div>
      <div class="s-word">threshold</div>
      <div class="s-ipa">/ˈθreʃ.hoʊld/</div>
      <div class="s-eg">Her pain threshold is remarkably high.</div>
      <div class="s-zh">这个词说的是「开始发生某件事的那个点」。它常和 pain、tolerance 一起出现，中文里没有完全对应的词。</div>
      <div class="s-row">
        <span class="s-nav">我的项目</span>
        <span class="s-btn">开始学</span>
        <span class="s-meta">LECTURE 04 · ACTIVE</span>
        <span class="s-num">012 / 039</span>
      </div>
    </div>
  {/each}

  <!-- ═══ 地基 · 三种行 + 键值行（B11 / LT-03）═══ -->
  <div class="kit-sec">三种行 · 一页里不许混</div>
  <div class="kit-panel" data-testid="kit-rows">
    <div class="row-read"><span class="k">上次同步</span><span class="v">今天 09:14</span></div>
    <div class="row-read"><span class="k">待上传</span><span class="v">0</span></div>
    <div class="row-act">
      <span class="k">默认保存位置</span><span class="v">计划 › Unit 3</span><span class="car">›</span>
    </div>
    <div class="row-sw">
      <span class="k">{AUTO_SYNC_ON_BOOT}</span><span class="kit-sw k-on" aria-hidden="true"></span>
    </div>
  </div>
  <p class="kit-note">
    <b>只读行</b>是机器的事实：没有 caret、没有开关、按下去没反应 —— <b>绝不做成 button</b>
    （验收那十条里第 9 条数的就是这个）。<b>动作行</b>点了会发生事，右侧有 <code>›</code>。
    <b>开关行</b>的 Toggle 就是那一行的脸，<b>行本身不可点</b>。
    高度：只读行 36（数据行）· 动作行与开关行 48（导航行）。
  </p>

  <div class="kit-sec">键值行 · 值长了换行，标签不许被挤没</div>
  <div class="kit-panel">
    <div class="row-kv" data-testid="kit-kv">
      <span class="k">数据库</span><span class="v">D:\Nyx\data\nyx.db</span>
      <span class="k">core / 手机跑的判据是哪一版（submodule 锁定）</span><span class="v"
        >core 7eeea47 · schema v38 · 指纹 cadb369e1f4a7b2c9d0e5f6a8b3c4d2e</span
      >
    </div>
  </div>
  <p class="kit-note">
    Android 的 Settings › About 出过一次（I-176）：等宽值串不换行，把标签列挤成<b>一字竖排</b>，
    右边还超出屏幕被切。三条硬规矩：<b>值长了换行</b>（不是把标签挤没）· 标签列有最小宽 ·
    等宽串<b>按字符可断</b>。上面第二行就是当时那一行，拿它当负向对照。
  </p>

  <!-- ═══ 判分 ═══ -->
  <div class="kit-sec">判分 · 关掉颜色仍然读得懂</div>
  <div class="kit-grade" data-testid="kit-grades">
    <button class="k-g1"><span class="kit-dot"></span>忘了</button>
    <button class="k-g2"><span class="kit-dot"></span>想了一下</button>
    <button class="k-g3"><span class="kit-dot"></span>会了</button>
    <button class="k-g4"><span class="kit-dot"></span>太简单</button>
  </div>
  <p class="kit-note">
    四条非颜色通道：形 · 文案 · 动效方向 · 点数（D-341）。「忘了」不用正红（D-322 不羞辱），结算不报 8/10（D-348）。
  </p>
</div>
