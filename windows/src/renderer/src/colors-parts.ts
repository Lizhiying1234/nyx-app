/**
 * 「哪个 token 属于哪个 UI 部件」· Windows 这一端的分组表
 *
 * ══ 为什么这张表在 renderer，不在 core ════════════════════════
 * 使用者 2026-09-13 定的是「两端的配色**不需要完全一样**」，而两端的 token
 * 名单本来就不是同一份（Windows 是 `--color-*` / `--btn-*` 那 137 个；
 * Android 是它自己那 26 个，它的 `tokens.css` 文件头写着「Android 自己的一套，
 * 不是 Windows 的副本」，引 D-316）。
 * **共用的是机制（`core/design/colors.ts`），不是名单。** 名单是各端自己的界面文案，
 * 所以它跟着界面走。
 *
 * ══ 这张表只有「前缀 → 分区」════════════════════════════════
 * **不是一份 137 行的 token 清单** —— 那样就成了第二份真相，
 * 加一个 token 忘了同步，它会安静地从设置页上消失。
 * 这里只写分区，token 名单**从 `color-tokens.css` 现读**（那是唯一真相），
 * 再按前缀落进下面某一区。`check:tokens` 的 TOK-3 守着
 * 「每个 token 的前缀都在这张表里」—— 加了新前缀忘了归类，当场红。
 */

export interface ColorSection {
  readonly id: string
  /** 屏上那个分区标题（TM-05 双语头的英文位）*/
  readonly en: string
  /** 中文副题 */
  readonly zh: string
  /** 一句话说清这一区管的是什么，让他知道改了会动到哪 */
  readonly note: string
  /** 归到这一区的 token 前缀（`--color-<前缀>-…` 或原始层的 `--<前缀>-…`）*/
  readonly prefixes: readonly string[]
}

/**
 * ★ 顺序有意义：**从改了最显眼的排到最细的**。
 *   他打开这一页多半是想「整体换个色」，那件事在第一屏就该够得着；
 *   逐个部件微调是后面的事。
 */
export const COLOR_SECTIONS: readonly ColorSection[] = [
  {
    id: 'palette',
    en: 'Palette',
    zh: '调色板',
    note: '最底下那一层原始色。改这里会顺着往上影响所有用到它的地方 —— 想整体换个调子就从这儿开始。',
    prefixes: ['aqua', 'neutral', 'pink', 'teal', 'warm', 'navy', 'chart', 'progress']
  },
  {
    id: 'page',
    en: 'Surfaces',
    zh: '页面与面',
    note: '页面底色、卡片和面板的面、浮层后面那层灰、阴影。',
    prefixes: ['bg', 'surface', 'scrim', 'shadow']
  },
  {
    id: 'text',
    en: 'Text',
    zh: '文字',
    note: '正文、次级文字、最淡的那一档，以及压在深色上的字。',
    prefixes: ['text', 'on']
  },
  {
    id: 'border',
    en: 'Borders',
    zh: '边界',
    note: '描边、发丝线、焦点圈。',
    prefixes: ['border']
  },
  {
    id: 'primary',
    en: 'Primary',
    zh: '主色',
    note: '主按钮、选中态、强调文字用的那一支。',
    prefixes: ['primary', 'accent']
  },
  {
    id: 'state',
    en: 'States',
    zh: '状态',
    note: '到期 / 出错 / 做成了 / 要留意 / 待审阅 —— 这几档各自的色。',
    prefixes: ['attention', 'danger', 'success', 'warning', 'review']
  },
  {
    id: 'icon',
    en: 'Icons',
    zh: '图标',
    note: '图标本身的色，和它按下 / 变淡时的那几档。',
    prefixes: ['icon']
  },
  {
    id: 'button',
    en: 'Buttons',
    zh: '按钮',
    note: '按钮那一套自己的组件色（面 · 边 · 字 · hover · 按下）。',
    prefixes: ['btn']
  },
  {
    id: 'space',
    en: 'Spaces',
    zh: '空间',
    note: 'Vault · Lecture · Practice · Assist 这些空间各自的识别色。',
    prefixes: ['assist', 'atlas', 'knowledge', 'lecture', 'practice', 'vault', 'deep']
  }
]

/**
 * 一个 token 名 → 它归哪一区。归不到就返回 `null`。
 *
 * ★ 判据只有两条，和 `color-tokens.css` 里的写法一一对应：
 *   `--btn-*`          → 组件层，看第二段
 *   `--color-<x>-…`    → 语义层，看 `<x>`
 *   其余 `--<x>-…`     → 原始层，看 `<x>`
 */
export function sectionOf(token: string): ColorSection | null {
  let key: string
  if (token.startsWith('--btn-')) key = 'btn'
  else if (token.startsWith('--color-')) key = token.slice('--color-'.length).split('-')[0] ?? ''
  else if (token.startsWith('--')) key = token.slice(2).split('-')[0] ?? ''
  else return null
  if (!key) return null
  return COLOR_SECTIONS.find((s) => s.prefixes.includes(key)) ?? null
}
