/**
 * 配色能调哪些「部件」—— Settings › Resources › Colors 的清单（2026-09-13）
 *
 * ══ 为什么是语义层，不是原语也不是组件层 ════════════════════
 * 颜色的真相在 `nyx-core/src/core/design/color-tokens.css`，三层：
 *   原语（aqua-500 这种）→ 语义（--color-*）→ 组件（--btn-* 这种）
 * 使用者要的是「拆分成具体的 UI 部件，之后可以逐项调」——
 *   · 原语是「aqua-500」，那不是部件，是色卡；
 *   · 组件层太细（一个按钮四个态），一屏摆不下也没人想逐个调；
 *   · **语义层正好是「部件」那一层**：页面底 · 正文 · 描边 · 主色 · 图标…
 * 所以这一页调的是 `--color-*`。改一个语义令牌，所有引用它的地方一起变。
 *
 * ══ 为什么不是 core 里的全部 ════════════════════════════════
 * 判据是 **「手机真的用得到吗」**，不是「core 里有吗」。两道筛：
 *
 * ① **拾色器给不出的值**：`--color-scrim*` 是带透明度的 rgba、`--color-shadow-*`
 *    是整条 box-shadow 串、`--color-on-deep-2/-3` 带透明度。
 * ② **手机的样式根本没引用到的**（2026-09-14 补的这一道，见下）。
 *
 * 两道都是同一条理路：**摆一个调不动 / 调了没反应的格子，比不摆更糟**（D-412 / D-431）。
 *
 * ══ ★★★ 2026-09-14：这份清单原来有 37 个格子调了没反应 ════════
 * 原来它是按「core 里所有的纯色语义令牌」建的（66 个）。但 core 的语义层是**两端共享**的，
 * 里面一多半是 **Windows 的词汇** —— 声部色（atlas / vault / lecture / practice / review）·
 * 图标色（icon*）· accent 那一族 · warning 那一族 · primary 的 hover / pressed / contrast / soft。
 * 手机按 DS v5 用的是另一套（图标一律 `--violet`，警示走 `attention` 不走 `warning`），
 * 这 37 个在手机的样式里**一次都没被引用过** —— 使用者调了它们，屏上什么都不会发生。
 *
 * ★ 为什么当时没看出来：这个文件的文件头里就写着「摆一个调不动的格子比不摆更糟」，
 *   但我只把那条道理用在了 8 个带透明度的令牌上（那是**值**给不出），
 *   没想到还有另一种「调不动」——**值给得出，但没人用**。
 * ★ 使用者 2026-09-14 裁：删掉，只留真管用的。
 *
 * ══ ★★★ 2026-09-14 第二刀：29 → 25（真机上量出来的）════════════
 * 第一刀按「手机的样式引用过没有」删到 29。**那把尺还是量浅了。**
 * 真机上把主色改成洋红，`--color-primary` 和别名 `--violet` 都跟着变了，
 * 可 Atlas 那一屏**一个像素都没动**。（虚惊：那是因为首页不用主色；
 * 去配色页量，`.cmode.on` / `.cdot` / `.csw` 三个元素真的变了 —— 主色是活的。）
 * 但顺着这条线量下去，抓到 4 个**真死的**，而且死因不一样：
 *
 * · `color-deep` / `color-on-deep` / `color-on-deep-accent`（原「深面」整组）——
 *   别名 `--deep` / `--on-deep` / `--violet-lift` 在 `mobile.css` 和所有 svelte 里
 *   **各被用了 0 次**。专注态那一屏还没用上这套令牌，调了当然没反应。
 * · `color-assist-glow` —— **只有原生层读它**（`R.color.nyx_assist_glow`，气泡的星光）。
 *   原生色是**编译进 APK 的**，运行期改 CSS 变量根本够不到。
 *   `tokens.css` 里那行 `--assist-glow:var(--color-assist-glow)` 是**给生成器读的**，
 *   App 自己一次都没用过。
 *
 * ★★ 闸当时为什么没拦住：我把 `src/ui/styles/tokens.css` 里的 `var(--color-*)`
 *   当成了「有人在用」。**那是定义，不是使用** —— 别名层就是干这个的。
 *   改成把它排除在根之外，只认真正的使用（`mobile.css` / svelte / `index.html`），
 *   再顺着定义往回推。
 * ══ 这份清单会不会和现实漂掉 ════════════════════════════════
 * 会 —— 所以 `tests/color-parts.test.ts` **现场算一遍可达性**：
 * 从手机自己的文件（`src/**` + `index.html`）里所有的 `var(--X)` 出发，
 * 顺着令牌定义（core 那份 + 本端别名层）求传递闭包 —— 手机用 `--btn-outline-bg`、
 * 而 core 定义它是 `var(--color-primary)`，那 `--color-primary` 也算可达。
 * 清单必须**正好等于**「可达 ∩ core 里的纯色语义令牌」：
 *   · 少一个 → 那个颜色他调不到，而屏上看不出少了什么；
 *   · 多一个 → 一个调了没反应的格子（就是这次修的这件事）。
 * ★ 中文名只能手写，不能生成 —— 那正是这份文件存在的理由。
 */

/** 一个可调的部件：`[令牌名（不带 --）, 屏上叫什么]` */
export type ColorPart = readonly [token: string, zh: string]

export interface ColorGroup {
  /** 组名（屏上） */
  zh: string
  /** 一句话说清这组管什么；空字符串 = 不需要解释 */
  hint: string
  parts: readonly ColorPart[]
}

export const COLOR_GROUPS: readonly ColorGroup[] = [
  {
    zh: '背景',
    hint: '页面的底',
    parts: [
      ['color-bg', '页面底'],
      ['color-bg-warm', '暖底'],
      // ★ 跟 --color-bg-warm 成对，所以搬到这一组（原来摆在「状态」里，那不合理）
      ['color-text-on-warm', '暖底上的字']
    ]
  },
  {
    zh: '面',
    hint: '卡 · 浮层 · 安静区块',
    parts: [
      ['color-surface', '卡面'],
      ['color-surface-subtle', '安静区块'],
      ['color-surface-selected', '选中 · 按下']
    ]
  },
  {
    zh: '文字',
    hint: '从正文到极淡',
    parts: [
      ['color-text', '正文'],
      ['color-text-2', '次要'],
      ['color-text-3', '淡'],
      ['color-text-faint', '极淡'],
      ['color-text-accent', '主色字']
    ]
  },
  {
    zh: '描边',
    hint: '发丝线 · 分组线 · 焦点环',
    parts: [
      ['color-border', '描边'],
      ['color-border-subtle', '淡描边'],
      ['color-border-strong', '控件描边'],
      ['color-border-focus', '焦点环']
    ]
  },
  {
    zh: '主色',
    hint: '线 · 图形 · 星 · 控件面',
    parts: [
      ['color-primary', '主色'],
      ['color-primary-subtle', '主色·面']
    ]
  },
  {
    zh: '标记',
    hint: '荧光笔 —— 只画在语言材料里的词上',
    parts: [['color-knowledge-subtle', '荧光笔']]
  },
  {
    zh: '状态',
    hint: '成功 · 提醒 · 危险',
    parts: [
      ['color-success', '成功'],
      ['color-success-subtle', '成功·面'],
      ['color-attention', '提醒'],
      ['color-attention-subtle', '提醒·面'],
      ['color-attention-border', '提醒·边'],
      ['color-danger', '危险'],
      ['color-danger-subtle', '危险·面']
    ]
  }
]

/** 所有可调的令牌名（去重、按上面的顺序）—— 应用与重置都照这张表走 */
export const COLOR_TOKENS: readonly string[] = COLOR_GROUPS.flatMap((g) =>
  g.parts.map(([t]) => t)
)
