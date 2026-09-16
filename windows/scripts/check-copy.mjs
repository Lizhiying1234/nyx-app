/**
 * 文案闸 —— **废弃词出现在人读得到的地方就是错**（D-476 · `docs/ui/CROSS_PLATFORM_RULES.md` §四）
 *
 * ══ 为什么要有它 ═══════════════════════════════════════════
 * 术语表自己提的那条纪律（§四 末）：
 * 「`check:dead` 之类的闸抓不到**文案漂回去**，而这张表最容易在半年后
 *   被下一个会话默默还原（D-457 的教训）。」
 * 名字是两端**必须一致**的第一项（CP-01）—— 同物两名会让跨端查东西变成猜谜。
 * 而文案没有类型、不报错、不变红：**它只会慢慢漂回去**。
 *
 * ══ 只扫「人会读到的」════════════════════════════════════
 * 三类，别的一概不看：
 *   ① 模板里的**文本节点**（标签之间那些字）
 *   ② 属性里给人看的那几个：`title` / `aria-label` / `placeholder` / `alt`
 *   ③ 含中文的**字符串字面量**（'…' / "…" / `…`）—— 回执句 · 错误句 · 名字表
 *
 * **不看**：注释（它记的是当初为什么这么定，改了就是伪造记录）· `data-testid` ·
 * 路由 key · 列名 · 变量名 · import 路径。术语落地的规矩就是
 * 「**只改人读到的字面**」（UX-Q1），闸也照这条走。
 *
 * ★ 模板字符串里的 `${…}` 先剥掉：`${x ? '写作层' : '理解层'}` 里那两个词
 *   已经在字面量那一类里数过了，不剥会数两遍、还会把表达式里的标识符当文案。
 *
 * ══ 一条自我约束 ═══════════════════════════════════════════
 * 名单里每一条都要能说出**换成什么**。说不出替代词的不是废弃词，是抱怨。
 *
 * 用法：node scripts/check-copy.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const NL = String.fromCharCode(10)
const DIR = 'src/renderer/src'

/**
 * 废弃词 → 换成什么。判据是 `docs/ui/CROSS_PLATFORM_RULES.md` §四 那张表。
 * ★ 改这张表之前先改那份判据（D-326 的精神：改值先改 DS）。
 */
const BANNED = [
  /**
   * ★★ D-485（2026-09-15 · 使用者裁）· **「静默」整族退役**。
   *
   * 查出来的根不是「词不好听」，是**一个词底下两件相反的事**：
   * 自动那一半是「练成了」（这套机制唯一的终点），手动那一半是「先不练了」，
   * 而它们落在同一个状态、屏上同一个词。使用者原话：
   * 「不要强行保留一个用户看不懂的词。」
   *
   * ★ **不算**：库值 `'silent'` · `silence.ts` 文件名 · 注释
   *   （注释已被 `blankComments` 挖空，本来就扫不到）。
   * ★ 这一族一进来，下面几条旧映射的「换成什么」也跟着过期了 ——
   *   一张闸自己指向一个废弃词，是最难发现的那种漂。一并改。
   */
  /**
   * ★★ D-485 补裁（2026-09-15 · 主控 §〇①⑥）· 另外两个词也退役
   *
   * · **归档** —— 容器层（项目 / 单元 / Lecture 的 ⋮）写的**也是同一个 `silent`**、
   *   也是他手动做的那一路。条目层已经叫「收起来」，容器层还叫「归档」，
   *   于是同一件事在屏上有两个词（`start-learning.ts:164-165` 那句同一屏两词就是证据）。
   * · **轮转** —— 内部机制词。他看到的应该是「在练」（状态）与「排进练习」（动作）。
   * ★ 代码与注释照旧（D-471 ③）：退的是**屏上那个词**，不是这个概念。
   */
  ['取消归档', '放回去'],
  ['已归档', '收起来了'],
  ['归档', '收起来'],
  ['轮转', '在练 ／ 排进练习'],
  ['静默了', '收起来了 ／ 已练成'],
  ['已静默', '已练成（练成的）／ 收起来了（他自己收的）'],
  /**
   * ★★ 裸「静默」**留在这张表里**（2026-09-15 改裁，D 提、主控定）。
   *
   * 使用者把 Vault 那一档的名字裁回了「静默」，我第一版的做法是**把这条禁令删掉** ——
   * 那是错的：**拆了禁令，这个词从此没人盯**，而「屏上冒出一个没人盯的词」
   * 正是这一轮八次事故的同一个形状。
   *
   * ★ 现在的规矩：**屏上出现的「静默」一律来自 `SILENCE_FILTER_NAME`**，
   *   界面源码里不许写字面 —— 想在屏上说这两个字，就得引那个常量。
   *   于是「这个词长什么样」永远只有一处说了算（CR-7 两端一个说法的同一条理由）。
   * ★ 唯一的口子是**术语定义那一行自己**（见下面 `TERM_MARK`）：定义处必须写得出字面，
   *   否则常量无从定义。那一行**逐行签字**，不是整份豁免。
   */
  ['静默', '屏上要说这两个字，从 SILENCE_FILTER_NAME 来；定义那一行签 copy:term-def'],
  /**
   * ★★★ 上一个档名「不再出题的」也退役（2026-09-15 晚 · 这一条是我提的）
   *
   * ══ 为什么补这一条 ════════════════════════════════════════
   * S-3 把档名从「不再出题的」改回「静默」，**全套闸绿着漏了一处**：
   * `Library.svelte` 那块游戏框的大字是另抄的一份字面（`<h2>不再出题</h2>`），
   * 而屏上正中央那行字和左边侧栏说的**不是同一个名字**。
   * 三样东西同时没拦住它：
   *   · 我 grep 的是「不再出题**的**」（带「的」），大字那处不带 —— 搜一种拼法就当没有；
   *   · 这张表里**没有**旧档名，`check:copy` 无从报；
   *   · `smoke:study` 那条用例**正钉着旧名字**（`assert.match(t, /不再出题/)`）——
   *     它不但没拦，反而是「改对了才会红」。已一并改成钉常量。
   *
   * ══ 判据 ═════════════════════════════════════════════════
   * 与上面那条「静默」是一对：**新名字只许从常量来，旧名字一个字都不许再上屏**。
   * 退役词表的作用从来不是「这几个字不好看」，是**让一个被换掉的词从此有人盯着**
   * （S-2 那次主控的原话：拆了禁令，这个词从此没人盯）。
   * ★ 2026-09-15 晚**收窄回「不再出题的」**（带「的」，即那个旧档名本身）：
   *   我原来图省事拦短的「不再出题」，想着「短的连带把长的也盖住」。
   *   可 D-489 那句新的引导文案正是「静默的知识点**不再出题**；想再练，随时恢复。」——
   *   **退役的是那个名字，不是这四个字的意思**，拦短的等于把一句正常的话也判红。
   * ☆ 那个 `<h2>` 写字面的老毛病并没有因此松开：`smoke:study` 现在逐字比
   *   「框上那行大字 === `SILENCE_FILTER_NAME`」，那条钉得比词表更准。
   * ★ 真要在屏上写这四个字（当句子，不当名字），签 `copy:term-def` —— 逐行签字。
   *   但先想想：解释这个档的话已经有一句了（`vault-learned`），再写一句多半是在重复。
   * ★ `docs/ui/CROSS_PLATFORM_RULES.md` §四 那张判据表要补同一行 —— 文档归主控改，已报。
   */
  ['不再出题的', '静默（屏上只许从 SILENCE_FILTER_NAME 来）'],
  /**
   * ★★★ D-489（2026-09-15 · 使用者裁）· 「已练成 / 收起来 / 放回去」整族退役
   *
   * 使用者原话：「已练成」这个说法「比较口语化，也显得有些生硬、俗套」，
   * 并裁 **项目 · 单元 · Lecture · 知识点全部层都用「静默 / 恢复」**。
   *
   * ★ 于是屏上这三件事只剩一个名字，且只有一个出处：
   *   档名 / 终点那一档 = `SILENCE_FILTER_NAME`；动作 = `SILENCE_ACTIONS`；
   *   容器层那一句 = `silenceScopeAction()`。**界面里一律不写字面。**
   * ★ 「收起这个」单列一条：`Workbench.svelte` 那句「收起这个 Lecture」是
   *   **手写的字面**，从来没走过常量 —— 正是它让这一层的词和别层分了叉。
   * ★ 「已静默 / 静默了 / 静默库 / 静默知识库」仍然退役（上面那几条）：
   *   退的是「这条被静默了」那种状态说法，他第一次嫌看不懂的就是那个；
   *   而「静默」作为**名字与动作**是他这次裁回来的，两回事。
   */
  ['已练成', `静默（从 SILENCE_FILTER_NAME 来）`],
  ['收起这个', '静默这个…（走 silenceScopeAction()）'],
  ['收起来', '静默（从 SILENCE_ACTIONS.shelve 来）'],
  /**
   * ★★★ **词根要取最短的那一个**（2026-09-15 晚 · D 在 Android 栽了同一跤，主控转来核）
   *
   * V-5 那一轮我拦的是「放回去」，于是屏上五句「『X』**放回来**了」一个没拦住 ——
   * 同一个退役词换一个「来 / 去」就从闸底下走过去了。Android 那边是
   * 「收起来」拦不住「已收起 N 条」，**一模一样的形状**。
   * ☞ 「放回」六处实测全是静默那一路（另有几处在注释里，本来就不扫），收短安全。
   *
   * ★ 但**「收起」不能收到这么短**：屏上大量「收起侧栏 / 收起中文 / 收起」是
   *   **折叠**那个意思，和静默无关（实测 16 处里绝大多数是它）。
   *   裸扫「收起」会把它们全判红 —— 而**一个会误报的闸，第一次误报之后
   *   就会被下一个人加进白名单，然后失效**（本文件头注记着这条）。
   *   所以那一支只收到「收起这」：`收起这一条` / `收起这个 Lecture` 那种
   *   **动作在一个具体对象上**的说法，正是退役的那个用法。
   */
  ['放回', '恢复（从 SILENCE_ACTIONS.restore 来）'],
  ['收起这', '静默这…（走 silenceScopeAction()）'],
  ['打回轮转', '放回去'],
  ['分诊台', '那个东西已经没有了 —— 按语境说具体的事'],
  ['已沉淀', '已练成'],
  ['书房', 'Projects'],
  ['垃圾箱', '回收站'],
  ['综合知识库', '全部（Vault 的预设名）'],
  ['静默知识库', '已练成（Vault 的预设名）'],
  ['知识点库', '全部（Vault 的预设名）'],
  ['静默库', '已练成'],
  ['我的上传库', '我的收集'],
  ['手机收进的', '我的收集'],
  ['主动词汇', '写作层'],
  ['被动词汇', '理解层'],
  ['词条', '知识点'],
  ['首页', 'Today'],
  /**
   * ★★ B-10（主控 2026-09-14 裁）· **这张表原来比它自己写的判据窄**。
   *
   * 头上写着「判据是 `CROSS_PLATFORM_RULES.md` §四 那张表」，而那张表第 11 行是
   * 「**词条 · 条 · 表达 · EXPRESSIONS** → 知识点」—— 这里却只有「词条」。
   * 后果是实打实的：B-7 改掉 core 里十句退役词，**闸只盖得住其中五句**，
   * 「表达」那几句漂回去不会红。**一条闸比它声称的判据窄，和哑闸是同一种病。**
   *
   * ★ 「条」没进来是**有意的**（§四 那张表的开场白自己写着）：废的是
   *   「一条 = 一个知识点」那个名词用法，而「共 12 条」这种量词满屏都是且都对。
   *   裸扫「条」会把量词全判红，而**一个会误报的闸，第一次误报之后就会被下一个人
   *   加进白名单，然后失效**。同理 `EXPRESSIONS` 是英文变量名，不是屏上的字。
   */
  ['表达', '知识点'],
  /**
   * ★★ Lecture 改名的四个变体（UX-Q3 / TM）—— 名单直接抄 `tests/study.test.ts`
   * 那条用例里的 `OLD`，它本来就是这四个。
   * ★ 为什么值得进这张表：那条用例只在**五屏**上查这四个词（H-3 乙记过它
   *   「闸的名字比断言大」），而退役词可以长在任何一屏、任何一句主进程文案、
   *   以及 core 里两端共用的那些句子上。
   */
  ['讲次', 'Lecture'],
  ['这一讲', '这个 Lecture'],
  ['本讲', '这个 Lecture'],
  ['哪一讲', '哪个 Lecture']
]

/** 注释挖成同长度的空格 —— 行号不变，注释里的历史说法不算数 */
function blankComments(src) {
  const out = src.split('')
  const kinds = [
    ['/' + '*', '*' + '/'],
    ['//', NL],
    ['<!--', '-->']
  ]
  for (const [open, close] of kinds) {
    let i = 0
    while (i < out.length) {
      const at = src.indexOf(open, i)
      if (at < 0) break
      const end = src.indexOf(close, at + open.length)
      const stop = end < 0 ? src.length : end + close.length
      for (let k = at; k < stop; k++) if (out[k] !== NL) out[k] = ' '
      i = stop
    }
  }
  return out.join('')
}

/**
 * 把「人读得到的那些片段」挑出来，其余位置换成空格（行号不变）。
 * ★ 不用正则做嵌套匹配 —— 反斜杠一律绕开写（D-460），这里逐字符走。
 */
function visibleOnly(src) {
  const n = src.length
  const keep = new Array(n).fill(false)

  // ① 模板文本节点：`>` 之后到下一个 `<` 之前
  //    只在 `</script>` 之后那一段做 —— 脚本里的 `>` 不是标签
  const bodyAt = src.indexOf('</' + 'script>')
  const from = bodyAt < 0 ? 0 : bodyAt
  for (let i = from; i < n; i++) {
    if (src[i] !== '>') continue
    let j = i + 1
    while (j < n && src[j] !== '<') {
      keep[j] = true
      j++
    }
    i = j - 1
  }

  // ② 给人看的属性
  for (const attr of ['title=', 'aria-label=', 'placeholder=', 'alt=']) {
    let i = 0
    while (true) {
      const at = src.indexOf(attr, i)
      if (at < 0) break
      let j = at + attr.length
      const q = src[j]
      if (q === '"' || q === "'") {
        j++
        while (j < n && src[j] !== q) {
          keep[j] = true
          j++
        }
      }
      i = j + 1
    }
  }

  // ③ 含中文的字符串字面量
  const quotes = ["'", '"', '`']
  for (let i = 0; i < n; i++) {
    const q = src[i]
    if (!quotes.includes(q)) continue
    let j = i + 1
    while (j < n && src[j] !== q && src[j] !== NL) j++
    if (j >= n || src[j] !== q) continue
    const body = src.slice(i + 1, j)
    if (/[一-鿿]/.test(body)) for (let k = i + 1; k < j; k++) keep[k] = true
    i = j
  }

  const out = src.split('')
  for (let i = 0; i < n; i++) if (!keep[i] && out[i] !== NL) out[i] = ' '
  return out.join('')
}

/** 剥掉模板字符串里的 `${…}`：里面是表达式，不是文案 */
function stripInterp(src) {
  const out = src.split('')
  let i = 0
  while (i < out.length - 1) {
    if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 0
      let j = i + 1
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      for (let k = i; k <= Math.min(j, out.length - 1); k++) if (out[k] !== NL) out[k] = ' '
      i = j + 1
    } else i++
  }
  return out.join('')
}

/**
 * ★ 除了组件，还扫几个**主进程里的文案文件**。
 *
 *   `src/main/export.ts`—— 它生成的**可读笔记**是使用者会打开来读的 Markdown，
 *   那也是「人读到的字面」，CP-01「名字两端一致」管得着它。
 *   2026-09-08 就是它漏在外面：界面全改完了，导出的笔记里还写着
 *   「主动词汇」，`smoke:study` 才抓到。
 *
 *   ★★ `src/main/params.ts`—— **2026-09-14 双端对账扫出来的，同一个坑第二次**。
 *   那个文件里的 `label` / `note` 就是**设置页上逐字显示的句子**（不是列名，
 *   不是标识）。它漏在外面的后果：设置 › 练习 里一直写着「**首页**也能直接改」，
 *   而「首页」就在下面那张名单里、侧栏那一项早就叫 `Today` 了 ——
 *   **闸认得这个词，只是从来没往那个文件看。**
 *
 * ★★ **主进程那一半从「白名单」改成了「黑名单」**（2026-09-14）。
 *
 *   原来是一张 `EXTRA` 白名单（只扫列出来的那几个）。那种形状的毛病是：
 *   **新长出来的文案文件默认在闸外面，而且不会有任何东西提醒你**。
 *   `params.ts` 就是这么漏的，漏了不知多久。
 *
 *   现在反过来：**`src/main/**` 全扫，不想扫的逐个写进下面那张表并说出理由**。
 *   两种名单都会漂，但**漂的方向不一样**：
 *     白名单漂 → 新文件安静地没人看（错过，不报）
 *     黑名单漂 → 新文件被扫，最多多一条假红（误报，当场可见）
 *   宁要后者。
 *
 *   ★ 实测改完的代价：全扫 `src/main` 只多出 **4 处**，其中 **3 处是真的**
 *     （audit.ts 的「静默库」· lecture.ts 的「垃圾箱」与「静默知识库」）。
 *     那三句都是**屏上真会出现的错误提示与体检结论** —— 漏了好几个月。
 */
const MAIN_DIR = 'src/main'

/**
 * 不扫的，逐个说理由。**加一行就要写一行理由** ——
 * 这张表存在的意义就是让「不扫」这件事得有人签字。
 */
const MAIN_SKIP = [
  // 迁移里的中文是**迁移日志的标题**（写进 `migrations` 表），不上屏；
  // 而且历史迁移**按定义不得改**（D-216）—— 报了也不能改。
  'src/main/db/migrations/',
  // 导出的 .sql 文件头，给看库结构的人读，不是界面文案
  'src/main/db/schema-dump.ts'
]

function walkTs(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name).split('\\').join('/')
    if (e.isDirectory()) out.push(...walkTs(full))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const EXTRA = walkTs(MAIN_DIR).filter((f) => !MAIN_SKIP.some((s) => f.startsWith(s)))

/**
 * ★★★ **`src/core` 也要扫**（B-7，主控 2026-09-14 追加）· **同一个坑第三次**
 *
 * 前两次是「文案住在没人扫的地方」：09-08 `export.ts` 的「主动词汇」（`smoke:study` 才抓到）、
 * 09-14 `params.ts` 的「首页」（双端对账才扫出来）。这一次更远一层 ——
 * **文案住在 core**：`start-learning.ts::scheduleOnStart` 那五句 `reason` 是
 * 排期留痕与界面上那句话的**原文**（`Lecture.svelte::doStart` 按 D-356 原样透出），
 * 里面写着「这一讲」「表达」；`dict/diagnostics.ts` 与 `voice/resolve.ts` 里
 * 「词典里只有词条音」那类句子同理。
 *
 * ★★ 而这一层的代价和前两次**不是一个量级**：core 是两端共用的（D-238），
 *   **手机屏上那句话和电脑屏上那句话是同一个字符串**。
 *   两端的文案闸原来都不扫 core（Android 那端 A-6 已核实）——
 *   于是那几句退役词在**两块屏上**躺着，而两端各自的闸都是绿的。
 *
 * ── 为什么不是「core 不该有文案」──────────────────────────────
 * 判据在 core 是对的（D-238 / D-365：同一件事两端不许各写一份）。
 * 错的是**闸没跟着判据搬**（和 `TRASH_KEEP_TEXT` 那条完全同形：
 * 判据搬进了 core，守它的闸留在原地，于是漂了也不会红）。
 */
const CORE_DIR = 'src/core'

/**
 * core 里**不扫**的，逐个说理由。**加一行就要写一行理由**（同 `MAIN_SKIP`）。
 *
 * ★★ 这张表只放一种东西：**提示词正文 —— 发给模型的话，不是给他看的话**（主控 2026-09-14 定）。
 *   理由不是「懒得改」，是**改了会改模型行为**：那几段是喂给 AI 的指令，
 *   逐字沿用手机上跑过的那一份（见 `lookup-prompt.ts` 头注「不趁搬家顺手改文案」），
 *   把里面的词换掉 = 两端回答方式变了，而那不是一条文案闸该做的决定。
 *
 * ★ **这是一个有意留下的洞，代价说清楚**：这两个文件里**将来**长出来的
 *   用户可见文案也会一起被放过。所以只放**整份都是提示词**的文件，
 *   `reading-face.ts` / `qtypes.ts` **故意不在这张表里** ——
 *   它们虽然也装着提示词正文，但同时装着屏上真会出现的字
 *   （牌面的 `name` / `says`、题型的 `name`），整份豁免等于把那些字也放走。
 */
/**
 * ★★★ **提示词正文按行豁免，不按整份**（B-10，主控 2026-09-14 裁）
 *
 * 上一版这里是一张 `CORE_SKIP` 文件名单（`lookup-prompt.ts` / `request.ts` 整份跳过）。
 * 那张表**自己带着一个洞**，而且我当时就把洞写在注释里了：
 * 「这两个文件里**将来**长出来的用户可见文案也会一起被放过」。
 * 洞的形状和 `EXTRA` 白名单那次一模一样 —— **默认在闸外面，而且不会有任何东西提醒你**。
 *
 * 换成逐行：**发给模型的那一行，行尾写一个记号**，闸认这个记号：
 *
 *     '……按词条讲；' +                                    // copy:prompt
 *
 * 于是同一个文件里，**提示词那几行豁免、屏上那几行照扫**。
 * `reading-face.ts`（牌面的 `says` 上屏、`guide` 发给模型）和 `qtypes.ts`
 * （题型 `name` 上屏、出题指令发给模型）本来就是混着的，整份豁免等于把上屏那半也放走。
 *
 * ★ 为什么是「行尾记号」而不是「块标记」：一行一个决定，看得见、grep 得到、
 *   diff 上一眼认得出；块标记（`/* copy:prompt-start *​/`）漏写结束符就会静静放行一大片。
 * ★ 记号**只对那一行生效**，跨行的模板串要逐行标 —— 麻烦是故意的：
 *   每一行豁免都得有人亲手签一次字。
 */
const PROMPT_MARK = '// copy:prompt'

/**
 * ★★ 术语**定义**那一行的具名豁免（2026-09-15，S-2 改裁）。
 *
 * 有一类词是「屏上不许随手写，但必须有一处定义它」—— 比如 Vault 那一档的名字
 * 「静默」：屏上要说它，但**只许从 `SILENCE_FILTER_NAME` 来**。
 * 定义那一行本身写的就是字面，闸会拦；所以给它一个行尾记号。
 *
 * ★ **按行，不按整份**（同 `PROMPT_MARK` 的理由）：整份豁免 `silence.ts` 的话，
 *   将来谁在同一份文件里写一句带退役词的屏上文案，也一起被放走了。
 * ★ **每一行都要在行尾写清它是哪个词的定义**，让 diff 上一眼看得出谁签的字。
 * ★ 这个记号应该**非常少**。多起来就说明有人拿它当万能通行证 ——
 *   那时候该问的是「为什么这么多词需要在屏上写字面」，不是再加一行记号。
 */
const TERM_MARK = '// copy:term-def'

/**
 * ★★★ `src/shared` 也要扫（2026-09-15 · D-485 那一轮撞出来的）
 *
 * `MATRIX_ROWS` / `MATRIX_COLS` —— 4×4 矩阵两条轴上的档名 —— 住在
 * `src/shared/api.ts`，**是实打实的屏上字**，而这道闸从来没扫过 `src/shared`。
 * 结果：D-485 把「静默」整族退役时，闸报了 51 处、全改完显示绿灯，
 * **而矩阵那两条轴上的「静默」原样留着** —— 是 `smoke:study` 一条断言把它顶出来的。
 *
 * ☞ 这和这个文件头上记的 `src/main` 那次是**同一个形状**：
 *   闸的覆盖面比它声称的判据窄，而窄掉的那一块不会有任何东西提醒你。
 *   那次的结论是「反过来：全扫，不想扫的逐个写进表里并说出理由」，这次照办。
 */
const SHARED_DIR = 'src/shared'

const CORE = [...walkTs(CORE_DIR), ...walkTs(SHARED_DIR)]

/**
 * ★★★ **每一处豁免记号都必须真的在挡什么**（2026-09-15 晚 · 主控转 D 的 N-5）
 *
 * 一个记号写上去之后就没人再看它。等到那一行的退役词早已改掉，记号还留着 ——
 * 它此刻什么都没挡，但**下一个人会以为这一行是被签过字的**，
 * 于是在同一行里写新文案时不会想到闸根本没在看。
 * ☞ 所以：记下每个**真的挡住了一次**的记号；跑完拿它和「全仓有记号的行」对一遍，
 *   挡不住任何东西的记号当场报出来，只许删不许留。
 *
 * ★ Windows 这一侧**没有 D 说的那种「整句 includes 豁免」** —— 两个口子都是
 *   **行尾签字**（`copy:prompt` / `copy:term-def`）。D 在 Android 栽的那条
 *   （合法用法的屏上字**等于**被禁词本身时，`includes` 子串豁免退化成全局豁免）
 *   在这儿不成立：按行签字不看内容，也就不存在「长句短句」这个前提。
 *   这条写在这里，是免得将来有人往这个文件里加一张 `XXX_OK` 表时以为没先例。
 */
const usedMarks = new Set()

const hits = []
const files = [
  /**
   * ★★★ **渲染层的 `.ts` 也要扫**（2026-09-15 晚 · 同上那一轮撞出来的）
   *
   * 这一行原来是 `.filter((x) => x.endsWith('.svelte'))` —— 于是
   * `src/renderer/src/*.ts` **一份都没扫过**，而屏上的字真住在里面：
   * `toast.svelte.ts` 那句撤销回执写着退役词「放回去了」，
   * V-5 报 0 命中、我还跑了负向对照，它就那么留着。
   *
   * ☞ 和这个文件头上记的 `src/main` / `src/core` / `src/shared` 三次**同一个形状**：
   *   **闸的覆盖面比它声称的判据窄，而窄掉的那一块不会有任何东西提醒你。**
   *   那三次的结论都是「反过来：全扫，不想扫的逐个写进表里并说出理由」，这次照办。
   */
  ...readdirSync(DIR)
    .filter((x) => x.endsWith('.svelte') || x.endsWith('.ts'))
    .map((x) => ({ label: x, path: join(DIR, x) })),
  ...EXTRA.map((x) => ({ label: x, path: x })),
  ...CORE.map((x) => ({ label: x, path: x }))
]
for (const { label: f, path: fp } of files) {
  const raw = readFileSync(fp, 'utf8')
  const rawLines = raw.split(NL)
  const text = stripInterp(visibleOnly(blankComments(raw)))
  for (const [word, instead] of BANNED) {
    let i = 0
    while (true) {
      const at = text.indexOf(word, i)
      if (at < 0) break
      const line = text.slice(0, at).split(NL).length
      /**
       * ★ 这一行是「发给模型的话」吗 —— 认行尾那个记号（见 `PROMPT_MARK` 头注）。
       *   ★★ 记号从 `raw` 里读，不是从 `text`：`blankComments` 已经把注释挖成空格了，
       *      在 `text` 里永远找不到它。第一版就是这么写的，结果记号完全不起作用，
       *      而表现是「加了记号照样红」—— 看着像记号写错了，其实是查错了地方。
       */
      const rawLine = rawLines[line - 1] ?? ''
      /** ★ 术语定义那一行同理 —— 逐行签字，见 `TERM_MARK` 头注 */
      if (rawLine.includes(PROMPT_MARK) || rawLine.includes(TERM_MARK)) {
        usedMarks.add(f + ':' + line)
        i = at + word.length
        continue
      }
      hits.push({
        file: f,
        line,
        word,
        instead,
        near: raw.slice(Math.max(0, at - 30), at + 30).split(NL).join(' ')
      })
      i = at + word.length
    }
  }

  /**
   * ★★★ **字中间夹空格也算**（2026-09-15 · 是截图抓到的，不是这道闸）
   *
   * Vault 那块游戏框上写的是 `<h2>静 默</h2>` —— 两个字中间一个空格拉字距。
   * 于是上面那一轮找 `静默` 一无所获，**闸显示绿灯，而屏幕正中央那两个大字原样留着**。
   * D-485 那一轮我把 51 处全改完、闸全绿，还是漏了它。
   *
   * ☞ 所以再走一遍：**把每一行里中文字之间的空白挤掉**再找。
   * ★ 逐行挤，不是整篇挤 —— 整篇挤会把换行也吃掉，行号跟着歪，
   *   报出来的位置就指不准了（而指不准的报错比不报还费时间）。
   * ★ 已知的口子：跨行断开的（`静` 在行尾、`默` 在下一行行首）这一遍也抓不到。
   *   没做是因为那种写法在这个仓里一次都没出现过，而为它付的复杂度是实打实的。
   */
  for (const [word, instead] of BANNED) {
    const lines = text.split(NL)
    for (let k = 0; k < lines.length; k++) {
      const plain = lines[k] ?? ''
      if (plain.includes(word)) continue // 上面那一轮已经报过
      const squeezed = plain.replace(/(?<=[一-龥])\s+(?=[一-龥])/g, '')
      if (!squeezed.includes(word)) continue
      if ((rawLines[k] ?? '').includes(PROMPT_MARK)) continue
      hits.push({
        file: f,
        line: k + 1,
        word: word + '（字中间夹了空白）',
        instead,
        near: (rawLines[k] ?? '').trim().slice(0, 60)
      })
    }
  }
}

/**
 * ★★ 第二条 · **屏上不许写死回收站的保留天数**（2026-09-13）
 *
 * 2026-09-09 把保留期从 30 改成 10 的时候，全仓有 **20 处**界面文案把「30 天」
 * 写死在句子里。只改常量的话，常量说 10、屏上说 30 —— **同一件事两份判据，
 * 而且错的那一份正对着他的眼睛**（D-412）。当时把那句话收进了 core
 * （`TRASH_KEEP_TEXT` / `TRASH_PURGE_TEXT`），20 处全部改成从常量推导。
 *
 * ★ **但没有任何东西拦着下一个人再写一遍。** 判据搬进了 core，守它的闸没跟着搬
 *   —— 而这类漂移**不会红**：类型对、用例绿、界面照常显示，只是那句话是假的。
 *
 * ══ 判据：两个条件**同时**成立 ═══════════════════════════════
 *   ① 这一行里有「数字 + 天」
 *   ② **同一行还在谈这件事**（回收站 / 恢复 / 反悔 / 清除 / 彻底删除 / 契约 / 躺）
 *
 * ★ 为什么不枚举句式：我第一版枚举了「N 天内可以恢复」「N 天后彻底清除」
 *   这几种，Nyx-UI-Android 指出它那边还有「回收站放 N 天」「按 N 天契约清除了」
 *   「躺 N 天」—— **枚举式会漏掉后面这些**，而漏掉的那种恰恰是没人记得的那种。
 *   改成「同一行还在谈这件事」就不依赖说法。
 * ★ 为什么不裸扫「数字 + 天」：`Kit.svelte` 里有一颗 `<button>近 30 天</button>`，
 *   那是**日期范围**，和保留期毫无关系。裸扫会把它判红 ——
 *   而**一个会误报的闸，第一次误报之后就会被下一个人加进白名单，然后失效**
 *   （和 TOK-2 那笔账是同一条：放行项一旦过期就成了一个洞）。
 */
const DAYS_NUM = /[0-9]+\s*天/
const DAYS_CTX = /回收站|恢复|反悔|清除|删除|保留|契约|躺/

/** 一行文案：算不算「把保留天数写死了」 */
function saysDays(line) {
  return DAYS_NUM.test(line) && DAYS_CTX.test(line)
}

/**
 * ★★ **把闸自己的判据钉住。**
 *
 * 原来只有我手跑的一次负向对照 —— 跑完就没了，拦不住下一个人把正则改松。
 * 现在误报、漏报各一半写在同一张表里，每次跑闸先自检：
 * 谁要放宽它，**得先改这张表**，那时候他就会看见上面那两条理由。
 * （这一招是 Nyx-UI-Android 提的，它同日在 Android 侧写了同一张表。）
 */
const SELF = [
  // 必须绿 —— 这些不是保留期
  [false, '近 30 天'],
  [false, '最近 7 天查了 491 次'],
  [false, '最久的欠了 3 天'],
  [false, '移到回收站，它下面的 Lecture 与知识点跟着一起走。'],
  // 必须红 —— 这些就是把那个数写死在了屏上
  [true, '移到回收站，30 天内可以恢复。'],
  [true, '删掉了《X》，10 天内可以恢复'],
  [true, '30 天后彻底清除'],
  [true, '回收站放 30 天'],
  [true, '躺 10 天 —— 反悔来得及。'],
  [true, '按 30 天契约清除了 3 行'],
  [true, '删除的项目会在这里保留 30 天。']
]
for (const [want, line] of SELF) {
  if (saysDays(line) !== want) {
    console.error('✖ check:copy 第二条**自己的判据坏了** —— 这一句应该' + (want ? '红' : '绿') + '，实际相反：')
    console.error('    ' + line)
    console.error(NL + '★ 你多半刚改过 DAYS_NUM / DAYS_CTX。改之前先读那两条理由：')
    console.error('  · 枚举句式会漏掉没人记得的那几种说法')
    console.error('  · 会误报的闸，第一次误报之后就会被加进白名单，然后失效')
    process.exit(1)
  }
}

const dayHits = []
for (const { label: f, path: fp } of files) {
  const raw = readFileSync(fp, 'utf8')
  const text = stripInterp(visibleOnly(blankComments(raw)))
  const lines = text.split(NL)
  for (let i = 0; i < lines.length; i++) {
    if (saysDays(lines[i])) dayHits.push({ file: f, line: i + 1, what: lines[i].trim().slice(0, 80) })
  }
}
if (dayHits.length > 0) {
  console.error('✖ 屏上把回收站的保留天数写死了 —— ' + dayHits.length + ' 处')
  for (const h of dayHits) console.error('  ' + h.file + ':' + h.line + '  「' + h.what + '」')
  console.error(NL + '★ 改成从 core 的常量推导：')
  console.error('    import { TRASH_DAYS, TRASH_KEEP_TEXT, TRASH_PURGE_TEXT } from "@core/sql/trash.ts"')
  console.error('  写死的那个数不会报错、不会变红 —— 它只会在下次改保留期时开始说假话。')
  process.exit(1)
}

if (hits.length > 0) {
  console.error('✖ 界面上还有废弃词 —— ' + hits.length + ' 处')
  console.error('  判据：docs/ui/CROSS_PLATFORM_RULES.md §四（D-476 术语表）')
  for (const h of hits) {
    console.error('  ' + h.file + ':' + h.line + '  「' + h.word + '」→ ' + h.instead)
    console.error('     …' + h.near.trim() + '…')
  }
  console.error(NL + '★ 名字是两端必须一致的第一项（CP-01）。文案没有类型、不报错，')
  console.error('  它只会慢慢漂回去 —— 这条闸就是为了让「漂回去」当场变红。')
  process.exit(1)
}
/** ★ 跑完对一遍：哪些记号什么都没挡住 · 哪些跳过的路径已经不在了 */
const staleMarks = []
for (const { label: f, path: fp } of files) {
  const rawLines = readFileSync(fp, 'utf8').split(NL)
  rawLines.forEach((ln, k) => {
    if (!ln.includes(PROMPT_MARK) && !ln.includes(TERM_MARK)) return
    if (usedMarks.has(f + ':' + (k + 1))) return
    staleMarks.push(`${f}:${k + 1}  ${ln.trim().slice(0, 60)}`)
  })
}
const goneSkips = MAIN_SKIP.filter((x) => !existsSync(x))
if (staleMarks.length > 0 || goneSkips.length > 0) {
  console.error('✖ 豁免表有死条目')
  if (staleMarks.length > 0) {
    console.error(
      '  这几行的豁免记号**什么都没挡住**（行里已经没有退役词了），删掉它：'
    )
    console.error(staleMarks.map((x) => '    ' + x).join(NL))
    console.error(
      '  ★ 留着不拆的代价：下一个人会以为这一行是被签过字的，' +
        '于是在同一行里写新文案时不会想到闸根本没在看'
    )
  }
  if (goneSkips.length > 0) {
    console.error('  MAIN_SKIP 里这几条的路径已经不在了：' + goneSkips.join(' · '))
  }
  process.exit(1)
}

console.log(
  'check:copy　扫了 ' +
    files.length +
    ' 份可见文案（渲染层组件 + src/main 全扫 + src/core 全扫；主进程不扫的写在 MAIN_SKIP，' +
    '发给模型的那些行在行尾标 ' +
    PROMPT_MARK +
    '）· 废弃词 ' +
    BANNED.length +
    ' 个 · 命中 0 · 豁免记号 ' + usedMarks.size + ' 处（都真在挡东西） · 第二条：回收站天数没写死（自检 ' + SELF.length + ' 句）'
)
