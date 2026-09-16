/**
 * `check:guide-ids` —— 页面引导的 id 与「触发 / 目标成对」（ZA-5 · 2026-09-15）。
 *
 * ══ 它拦什么 ═══════════════════════════════════════════════
 * 引导不出来的时候**没有任何东西会报错** —— 屏上就是少了一个气泡。
 * 这一轮 A 差点出的那件事正是这个形状：core 那份名单用确认单编号（`B-5`），
 * 而屏上写的是语义名（`practice-settle`），两端各叫各的 → `shouldShowGuide`
 * 直接返回 false，**那一端的引导永远不出，四门全绿**。
 *
 * ══ 四条判据 ═══════════════════════════════════════════════
 *   ① 屏上每个 `data-guide` 的 id 都在 core 的 `PAGE_GUIDES` 里（拼错当场红）
 *   ② 名单里每条都有人引用 —— 除非在 `PENDING` 里明写「这一端不做」
 *   ③ **触发与目标成对**：有目标（`data-guide`）还不够，
 *      还得真有人去扫它（`guide.scan(...)` 至少一处调用）。
 *      ★ Android 的触发面是**一次扫全屏**（`guide.svelte.ts::scan` 走
 *        `querySelectorAll('[data-guide]')`），不是每个 id 各写一句 `askGuide(id)`；
 *        所以「成对」在这一端 = 目标在 + 扫描器被调起。**两者缺一红。**
 *      ☞ 这一条与 C 的 U-3 是同一条判据的两半：**闸在这儿，触发面归 C**
 *        （主控 2026-09-15 已跟 C 说定）。
 *        ★ 更正：第一版这里写着「交付时 C 不在会话列表里」—— 那是**我查错了**，
 *          C 当时在线，只是会话重开之后名字变了（`voice-provider-android-741d63-*`）。
 *          闸仍然是我做的、触发面一个字没动，但那句理由不成立，不留在源码里。
 *   ④ **不扫注释** —— 注释里提一句 id 不算「有人引用」（正向断言，不剥就假绿）
 *
 * ★ `PENDING` 只许缩短：某个 id 这一端**暂时**没有目标，写在这儿并说明理由与**寿命**；
 *   条件一消失就该删掉（下面那两条自检会逼你删）。
 *   **不许往里加** —— 加一条等于给自己开一张免检。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripSource } from './lib/strip-comments.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * 这一端**暂时没有目标**的引导，连同理由。**只许变短。**
 *
 * ★ **现在是空的。** 2026-09-15 指针跟到 `6851ee0` 的那一刻，上一条
 *   （`project-progress` / 表 B 的 B-8）**自己到期了**：core 里已经没有它，
 *   下面那条自检当场红「PENDING 里的 id core 已经没有了，一并删掉」，
 *   逼着在同一笔里删掉这一行。
 *   ☞ 这正是写它那天标的那句「**这一行是有寿命的，不是长住的**」。
 *     免检条目就该这样收场：**由闸逼人删，不靠谁记得回来删。**
 *
 * ★★ 往里加一条 = 给自己开一张免检。加之前先答两个问题：
 *   **它什么时候失效？到那天谁会被逼着来删？**
 *   答不上来的，那就不是「暂时没目标」，是「不打算做」——
 *   后者要走产品裁决，不走这里。
 */
const PENDING = []

/**
 * 这一端**永久没有目标**的引导，连同理由。**和 `PENDING` 是两张表，别混。**
 *
 * ══ 两张表的差别 ═══════════════════════════════════════════
 *   `PENDING`          —— **暂时的**。有寿命，条件一消失闸就逼人删。
 *   `NOT_ON_THIS_END`  —— **永久的**。两端本来就不一样，这一端没有那块屏。
 *
 * ☞ 混成一张表的代价：**永久的那种会被人当成待办反复来查**，
 *   暂时的那种会被人当成产品决定长住下来 —— 我在 `PENDING` 上已经栽过一次
 *   （把「指针落后」写成了产品决定，主控 2026-09-15 更正）。分开就不会再错。
 *
 * ★ `today-paste`（表 B 的 B-1）：core 那句说的是「贴一段英文进来」，
 *   而 **Android 没有任何贴材料的入口** —— C 量到的，我复核过：
 *   `Atlas.svelte` 那个 today 块里只有两颗开练习的按钮，全屏没有 textarea / 粘贴口。
 *   引导指着一个块说另一件事，比不出还糟：他会照着那句话去找一个不存在的入口。
 *   使用者裁「**只做自己有的屏**」（D-311 文件学习线不进手机 / D-299 能力不必复制）。
 *
 * ★★ 加一条的门槛：**理由必填**（下面第 ④ 条拦空的）。
 *   而且这张表**不是免检**：名单里的 id 一旦在屏上出现了目标，第 ⑤ 条当场红 ——
 *   「永久不做」和「做了」同时成立是不可能的，那说明该把它从名单里拿出来。
 */
const NOT_ON_THIS_END = {
  'today-paste': '无贴材料入口（Atlas 那块只开练习，全端没有粘贴口）—— D-311 / D-299',
  'filestudy-modes': '本端没有文件学习那条线（D-311 不做长材料）—— 没有那一屏，不是没挂',
  'report-layers': '本端不做报告（D-247）—— 没有那一屏',
  'assist-star':
    '桌面那颗星是原生 StarView，跑在 TYPE_ACCESSIBILITY_OVERLAY 的独立窗口里' +
    '（NyxAssistService.java），不在 App 的 WebView 里 —— 第二层扫的是 document，' +
    '够不着它。**做不了，不是没做**；要讲这件事得由原生那层自己讲。' +
    'A 在 Windows 独立得出同一结论（悬浮球同样是置顶独立窗口）'
}

/** 走 src/ 下每个 .svelte / .ts，剥注释之后再扫 */
function sources() {
  const out = []
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (f.endsWith('.svelte') || f.endsWith('.ts')) out.push(p)
    }
  }
  walk(join(ROOT, 'src'))
  return out
}

const { PAGE_GUIDES } = await import('../nyx-core/src/core/onboarding.ts')
const known = PAGE_GUIDES.map((g) => g.id)

let onScreen = []
let scanCalls = 0
for (const p of sources()) {
  const s = stripSource(readFileSync(p, 'utf8'), p)
  for (const m of s.matchAll(/data-guide="([^"]*)"/g)) onScreen.push({ id: m[1], p })
  scanCalls += (s.match(/guide\.scan\s*\(/g) ?? []).length
}

const problems = []

// ① 屏上的 id 都认得
for (const { id, p } of onScreen) {
  if (!known.includes(id)) {
    problems.push(
      `★★★ 屏上的 data-guide="${id}"（${p.replace(ROOT, '')}）不在 core 的 PAGE_GUIDES 里 —— ` +
        '两端各叫各的时候引导永远不出，而且不报错。\n' +
        '  ☞ **先核指针，再核靶子**：`git rev-parse HEAD:nyx-core` 和 ' +
        '`git -C nyx-core rev-parse HEAD` 对不上的话，是这一端没跟上 core，' +
        '不是谁把 id 写错了 —— 两种情形在这条报文里长得一模一样。\n' +
        '  ★ 2026-09-15 真撞过：并完 master 之后这里一口气报了 5 个 id「不在名单里」，' +
        '照字面去「修」就会把同侪刚做对的 5 个靶子删掉。'
    )
  }
}

// ② 名单里每条都有人引用（PENDING 除外）
const used = new Set(onScreen.map((x) => x.id))
for (const id of known) {
  if (used.has(id) || PENDING.includes(id) || id in NOT_ON_THIS_END) continue
  problems.push(`★★ PAGE_GUIDES 里的「${id}」屏上没有人引用 —— 要么补上目标，要么写进 PENDING 并说明理由`)
}

// ★ PENDING 只许缩短：里面的 id 如果其实已经有人引用了，就该从名单里删掉
for (const id of PENDING) {
  if (used.has(id)) problems.push(`★ 「${id}」已经有目标了，把它从 PENDING 里删掉`)
  if (!known.includes(id)) problems.push(`★ PENDING 里的「${id}」core 已经没有了，一并删掉`)
}

// ④ 永久名单：理由必填（空理由 = 一张没写原因的免检）
for (const [id, why] of Object.entries(NOT_ON_THIS_END)) {
  if (!String(why ?? '').trim()) {
    problems.push(`★★ NOT_ON_THIS_END 里的「${id}」没写理由 —— 不写理由的免检，下一个人无从判断它还成不成立`)
  }
  if (!known.includes(id)) {
    problems.push(`★ NOT_ON_THIS_END 里的「${id}」core 已经没有了，一并删掉`)
  }
}

// ⑤ 永久名单不是免检：说了不做，屏上却有靶子 —— 两个都不能是真的
for (const id of Object.keys(NOT_ON_THIS_END)) {
  if (used.has(id)) {
    problems.push(
      `★★★ 「${id}」写着这一端永久不做，屏上却有 data-guide 靶子 —— ` +
        '要么这一端其实做了（把它从 NOT_ON_THIS_END 拿出来），要么这个靶子是指空的'
    )
  }
}

// ③ 触发与目标成对
if (onScreen.length > 0 && scanCalls === 0) {
  problems.push(
    '★★★ 屏上有目标（data-guide）却没有任何一处调 `guide.scan(...)` —— ' +
      '靶子都在，没人扣扳机：引导一条都不会出，而四门全绿'
  )
}
if (scanCalls > 0 && onScreen.length === 0) {
  problems.push('★★ 有人在扫，但屏上一个目标都没有 —— 扫了个空')
}

if (problems.length) {
  for (const p of problems) console.error(p)
  process.exit(1)
}
console.log(
  `✓ 引导 id ${known.length} 条 · 屏上目标 ${onScreen.length} 处 · ` +
    `扫描器调用 ${scanCalls} 处 · 这一端不做 ${Object.keys(NOT_ON_THIS_END).length} 条` +
    `（${Object.keys(NOT_ON_THIS_END).join('、')}）· 暂时没目标 ${PENDING.length} 条` +
    // ★ 名单空的时候不要留一对空括号 —— 空成「（）」会让人以为是它没读出来
    (PENDING.length ? `（${PENDING.join('、')}）` : '')
)
