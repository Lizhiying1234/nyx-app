/**
 * 界面用词闸（T-4.21 · D-471 · D-476 术语表）——「功能变了、名字还是旧的」只有闸挡得住
 *
 * ── 为什么是一道闸，而不是钉某一句话 ────────────────────────
 *
 * 命名重审的失败方式不是「某一句改错了」，是**改漏**：一屏改了、另一屏没改，
 * 于是同一个东西在手机上有两个名字。挨句钉断言只会钉住我这次记得的那几句；
 * 下一次谁再写一句旧名，没有任何东西会红。
 *
 * 判据是 Windows 仓 `docs/ui/CROSS_PLATFORM_RULES.md` §二（68 词术语表，使用者
 * 2026-09-08「全部按推荐」定案 · D-476）与 §四（废弃词清单，出现即错）。
 * 这里扫的是**源码里会上屏的字**。
 *
 * ★ 注释不算界面（D-471③：内部旧名不强求改，只是不许漏到屏幕上），
 *   所以扫之前先剥注释：`<!-- -->` · 块注释 · 整行 `//`。
 *   剥不干净的代价是误报，不是漏报 —— 这个方向的错我认。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripHtmlComments, stripSource } from '../tools/lib/strip-comments.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * ══ 扫哪些文件：**黑名单**，不是白名单 ★★（H-1-② · 2026-09-14）════════
 *
 * 上一版只扫 `src/ui` + `src/db` 两个目录。那是白名单，而白名单那种形状的毛病是：
 * **新长出来的文案默认在闸外面，而且不会有任何东西提醒你**。
 * Windows 那边同一天踩到同一件事（H-3 甲）：一句「首页也能直接改」住在主进程里，
 * 只扫渲染层的闸对它是瞎的；他们把范围从白名单改成黑名单，**多出来 4 处、其中 3 处是真的**，
 * 全是漏了好几个月的退役词。
 *
 * 本仓同一天实测（逐屏走查那一趟）：闸看不见的地方一共 **89 条**含中文的可见字串 ——
 *   `index.html` 那段内联脚本 0 条（它只挑图，屏上不说话）
 *   `src/engine/main.ts` 6 条 · 原生 Java **40 条** · 原生 `res/values` 1 条
 * 其中原生层那 40 条里**有真的**（`NyxAssistService` 的一句 toast 写着退役词）——
 * 也就是说这道闸此前对**第三方 App 里那一半界面**完全是瞎的，而那正是 Assist 的主场。
 *
 * ★ 两种名单都会漂，漂的方向不一样：
 *     白名单漂 → 新文件安静地没人看（**错过**，不报）
 *     黑名单漂 → 新文件被扫，最多多一条假红（**误报**，当场可见）
 * ★ 不扫的逐个写在 `SKIP` 里**并说出理由** —— 「不扫」是个决定，就得写下来。
 */
const SCAN_DIRS: [string, string[]][] = [
  ['src', ['.svelte', '.ts']],
  ['android/app/src/main/java', ['.java']],
  ['android/app/src/main/res', ['.xml']]
]
const SCAN_FILES = ['index.html']

/** 不扫的，每条都得说出理由（谁加一条，理由就留在这儿给下一个人看） */
const SKIP: [string, string][] = [
  ['src/db/lookup.ts', '提示词正文：发给**模型**的话，不是屏上的字（那里的「词条」是词典那一条）'],
  ['src/db/practice.ts', '同上：出题提示词'],
  ['src/db/analyse.ts', '同上：解析提示词'],
  ['android/app/src/main/res/values/nyx_tokens.xml', '生成物（tools/tokens-to-android.mjs），里面一个字都没有']
]

/** 标记类：`>文字<` 这种文字节点只有它们才有 */
const MARKUP = ['.svelte', '.html', '.xml']

/**
 * ★★ `src/db` 也会上屏 —— 2026-09-08 当场漏过一次：Atlas 首页那句
 *   「到期的 1 个 lecture 全部收下」不在 `src/ui` 里，闸只扫 UI 就看不见它。
 *   （那一句最后查出来在 core，见分表；但 `src/db` 里确实也有好几句给人看的话。）
 *
 * 只是 db / Java 里 `lecture` 到处都是标识符（`lecture_id` · `loadLecture` · SQL 文本），
 * 整文件扫会淹死在误报里。所以非标记类只扫**含中文的字符串字面量** ——
 * 一句话里有中文，它几乎一定是说给人听的。
 */

/**
 * ★★ 「屏上的字」和「代码里的名字」必须分开，否则这道闸没法用：
 *   `lecture` 在源码里同时是**旧名**（写在句子里）和**标识符**（`k: 'lecture'` ·
 *   `kind === 'lecture'` · SQL 里的 `lecture_id`）。D-471③ 明说内部标识不跟着改，
 *   所以整文件扫小写 `lecture` 会把路由键也判成旧名 —— 闸一旦开始误报，
 *   下一个人第一件事就是把它关掉。
 *
 * 于是只看两种东西，两种都是**人真的会读到的**：
 *   ① 标记里的文字节点（`>…<` 之间）—— 按定义就是屏上的字，英文也算（EXPRESSIONS）
 *   ② 含中文的字符串字面量 —— 一句话里有中文，它几乎一定是说给人听的
 *      （`'lecture'` 这种纯标识符字面量不含中文，不会被看）
 */
const TEXT_NODE = />([^<>]{1,300})</g
const CJK_LITERAL = /(['"`])([^'"`\n]*[一-龥][^'"`\n]*)\1/g

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => p.endsWith(e))) out.push(p)
  }
  return out
}

/** 这道闸这一趟真正读了哪些文件（N-3 会拿它核范围 —— 闸的名字不许比断言大） */
function scanned(): string[] {
  const skip = new Set(SKIP.map(([p]) => join(ROOT, p)))
  const all = [
    ...SCAN_DIRS.flatMap(([d, exts]) => walk(join(ROOT, d), exts)),
    ...SCAN_FILES.map((f) => join(ROOT, f))
  ]
  return all.filter((f) => !skip.has(f))
}

/**
 * 把注释剥掉 —— 剩下的才是会上屏的字。
 * ★ 换行必须留住：报出来的行号要能直接跳到源码那一行，
 *   否则闸红了、人却找不到那句话在哪（第一版就踩了这个）。
 */
function stripComments(src: string, file: string): string {
  /**
   * ★★★ 2026-09-15 · 这里原来是**本仓第七份**剥注释实现（本地正则三连）。
   *   当初不用共用那把尺子的理由只有一个：**它不保行号** ——
   *   而这道闸红了要说「文件 : 行」，行号歪了人就找不到那句话。
   *   `keepLines` 落地之后**这条理由没有了**，所以并回来。
   * ★ 并回来顺带吃到那把尺子的修复：本地这份**不认字符串、也不认正则字面量**，
   *   奇数个反引号的正则会让它从那儿一路吃到下一个反引号。
   *   共用那把有 15 句自检看着。
   * ★ `.xml` 走 `stripHtmlComments`：共用尺子按后缀分流，默认分支当 JS 剥，
   *   而 XML 只有 `<!-- -->`。**这不是第八份实现** —— 用的还是它导出的那两个函数。
   */
  if (file.endsWith('.xml')) return stripHtmlComments(src, true)
  return stripSource(src, file, true)
}

/**
 * 去掉字面量里的 `${…}` —— 那是**表达式**，不是屏上的字（`${lectureId}` 里的
 * lecture 是标识符）。模板会嵌套（`` `…${a ? `…${b}` : ''}` ``），所以由里往外
 * 反复剥到不再变化为止：只剥一遍会留下半截表达式，闸就会对着一句改好的话喊旧名。
 */
function dropExpr(text: string): string {
  let cur = text
  for (;;) {
    const next = cur.replace(/\$\{[^{}]*\}/g, ' ')
    // ★ 嵌套模板会被「到下一个引号为止」的取法切断，留下没有右括号的半截
    //   `${s.lectureName ?` —— 那半截照样是表达式，一起丢掉。
    if (next === cur) return cur.replace(/\$\{[\s\S]*$/, ' ')
    cur = next
  }
}

/** 屏上不许出现的说法 → 该说什么（每条都指得出术语表哪一行） */
const BANNED: [RegExp, string][] = [
  // ── TM-30 · Lecture（UX-Q3 定案：首字母大写）──
  [/讲次/g, 'TM-30：界面上这一层写 Lecture'],
  [/这一讲|那一讲|两讲|目标讲|整讲/g, 'TM-30 —— 中文里的「讲」也是旧名'],
  [/lecture/g, 'TM-30 定案是首字母大写的 Lecture'],
  // ── §四 废弃词清单（出现即错）──
  [/分诊台/g, '§四 废弃词'],
  [/已沉淀/g, '§四 废弃词 → 已静默'],
  [/书房/g, '§四 废弃词 → Projects（D-462 / TM-03）'],
  [/垃圾箱/g, '§四 废弃词 → 回收站（TM-11）'],
  [/词条/g, '§四 废弃词 → 知识点（TM-31）；说词典里的一条就写「词典条目」'],
  [/表达/g, '§四 废弃词 → 知识点（TM-31）'],
  [/EXPRESSIONS/g, '§四 废弃词 → 知识点（TM-31）'],
  [/静默库|静默知识库|综合知识库|知识点库/g, '§四 废弃词 → Vault 的预设名（TM-06 / TM-08）'],
  [/主动词汇|被动词汇/g, '§四 废弃词 → 写作层 / 理解层（TM-39 / TM-40）'],
  [/随便练一点/g, 'TM-43 → 随时练习'],
  [/恢复轮转/g, 'TM-56 → 打回轮转'],
  [/本机待上传/g, 'TM-53 → 待上传'],
  [/试听一句/g, 'TM-64 → 试听'],
  [/这批我看过了/g, 'TM-60 → 开始学（长句退役）'],
  [/HARD/g, 'TM-09：Android 的 HARD 微标签退役 → 攻坚'],
  // ★ 2026-09-08 · SC-00d 补齐 §四 废弃词清单里本仓还没进闸的那几个。
  //   T-4.21 已经把 40 余处改过了，这里是**补闸**，不是补改 —— 让它们不会漂回来。
  [/文件夹/g, '§四 废弃词 → Lecture（代码层叫 folder，界面上不出现）'],  // 见 FOLDER_OK
  [/首页/g, '§四 废弃词 → Today（D-456）'],
  [/进展/g, '§四 废弃词 —— U-002 之后没有这个空间了'],
  [/我的上传库|手机收进的/g, '§四 废弃词 → 我的收集（它筛的是 source=self，TM-07b）'],
  [/\bMode\b/g, '§四 废弃词 —— 按语境说具体的事'],
  // ── 使用者 2026-09-08：单条的那两个动作两端同名（TM-43 的「随时认读 / 随时练习」）──
  [/认读这条|产出这条/g, 'TM-43 → 随时认读这一条 / 随时练习这一条'],
  /**
   * ★★ D-485（2026-09-15）· 「静默」家族 + 「归档」 + 「轮转」退役。
   *
   * 使用者原话：「不要只是修改一个词，而是需要重新检查这个概念本身」。
   * 查出来一个词底下是**两件相反的事**：自动练成（这套机制的终点）与手动收起来（可逆）。
   * 现在：状态 **已练成** / **收起来了** · 动作 **收起来** / **放回去** ·
   * Vault 那一档当时起了个中性名 **不再出题的**（装两种东西的档不叫其中一种，D-412）。
   *
   * ★★★ **2026-09-15 晚使用者裁回了短的「静默」**（原话：「这个名字太差了」）。
   *   D-412 那个顾虑**没有被推翻，是被移交了** —— 改由引导句 `vault-learned` 扛
   *   （core `PAGE_GUIDES`，两端同一句：档名 + 两种来源的标签 + 「放回去」全从常量拼）。
   *   ☞ 写在这儿是因为**下一个人会照着这段注释做判断**：看到档名装着两件相反的事、
   *     又不知道有那句引导在解释，他会以为 D-412 被忘了，然后把名字「修」回中性名 ——
   *     而那是使用者已经否掉的。**谁在扛这件事，必须写出来。**
   *
   * ★ 「归档」是**容器层**那个动作的旧界面词（同一个 `silent` 列）——
   *   同一屏两个词，2026-09-15 一并收进这套。
   * ★ 「轮转」是排期那一轮的旧说法（TM-44 改）：状态「在练」· 动作「排进练习」。
   * ★ 库值 `'silent'`、`silence.ts` 文件名、**注释里的内部旧名一律不算**
   *   （D-471③；闸扫之前剥注释，所以「静默」当副词用的那 8 处不会误报）。
   */
  /**
   * ★★★ 2026-09-15 晚 · 使用者把档名裁回了「静默」，**这条禁令不拆**（主控定，我提的问）。
   *   我当时的问法是「拆完之后这个词是不是就完全自由了，要不要补一条正向的」。
   *   定下来的答案比我的问法好：**禁字面 + 只许常量渲染，本身就是那条正向闸** ——
   *   屏上的「静默」只能来自 `SILENCE_FILTER_NAME`，源码里写字面照红。
   *   ☞ 退役词表的作用从来不是「这几个字不好看」，是**让一个被换掉的词从此有人盯着**；
   *     拆了禁令，这个词就从此没人盯了 —— 那正是这一轮八次事故的形状。
   */
  [/静默/g, '屏上要说这两个字，从 SILENCE_FILTER_NAME 来（别在界面源码里写字面）'],
  /**
   * ★★★ 上一个档名「不再出题」也退役（2026-09-15 晚）。
   *
   * ★ 用**最短词根**「不再出题」，不是「不再出题的」—— 短的连带把长的盖住。
   *   这不是讲究，是 B 当天在 Windows 侧真栽的那一跤：他 grep 的是带「的」那个拼法，
   *   而屏幕正中央的大字是 `<h2>不再出题</h2>`（不带「的」），于是**全套闸绿着**
   *   让中间那行字和侧栏叫的不是同一个名字。**搜一种拼法就当没有**，同一族的病。
   * ★ 本端补这一条的当场就兑现了一次：`git grep 不再出题的` 说四处全清了，
   *   换成短词根再搜，`VaultSilent.svelte` 屏上那句还写着「—— 不再出题。」
   *   （已改成跟引导句同一个说法「不再考你了」）。
   * ★ 真要在屏上写这四个字（当句子，不当名字），照 `FOLDER_OK` 那样**按整句**豁免，
   *   别按文件。但先想想：解释这一档的话已经有一句了（core 的 `vault-learned`）。
   */
  [/不再出题/g, '静默（屏上只许从 SILENCE_FILTER_NAME 来）'],
  /**
   * ★★★ D-489（2026-09-15 晚 · 使用者裁）· 「已练成 / 收起来 / 放回去」退役。
   *
   * 「已练成」**整个说法退役**，行上那枚把这一档分成两半的小标也去掉了（两端同步）。
   *   ★ 判据没删：`silenceKind()` 还在 core，进度仍然只算练成的那一半（D-485）——
   *     退掉的只是「把这个区分写到他眼前」，不是「不再区分」。
   * 「收起来 / 放回去」换成 `SILENCE_ACTIONS` 的新值（静默 / 恢复）——
   *   屏上这两个动作只许从常量来，源码里写字面照红。
   */
  [/已练成/g, 'D-489 退役 —— 这一档不在屏上分两种了（silenceKind 判据仍在）'],
  [/收起/g, 'D-489 → 用 SILENCE_ACTIONS.shelve（现在是「静默」）；折叠义见 FOLD_OK'],
  [/放回去/g, 'D-489 → 用 SILENCE_ACTIONS.restore（现在是「恢复」）；词典那一路见 RESTORE_OK'],
  [/归档/g, 'D-485 废弃词 → 收起来 / 放回去（容器层那个动作，写的也是 silent）'],
  [/轮转/g, 'D-485 废弃词 → 在练（状态）/ 排进练习（动作）']
]

describe('N · 界面用词（D-471 命名重审 · D-476 术语表）', () => {
/**
 * ★★ 「文件夹」这条废弃词只废掉**内容层级**那个意思（它当年是 Lecture 的旧名）。
 *
 * 词典那一路说的是**真的一个操作系统文件夹** —— 使用者把 `.mdx` 放进去、
 * 在设置里选它、权限丢了要重选。那不是旧名，那就是那个东西本来的名字，
 * 换成 Lecture 才是胡说八道。
 *
 * 所以豁免按**整句**给，不按文件给：文件粒度会把同一个文件里将来新写的、
 * 真的指 Lecture 的那一句一起放过。这五句原样列在这里，
 * 谁改动其中一句，它就重新落回闸里 —— 这是有意的。
 *
 * ★ 已回报总控：`CROSS_PLATFORM_RULES.md` §四 那一行该补一句范围
 *   （「文件夹（指 Lecture 那一层）」），否则下一个人还会在这里重新纠结一次。
 */
/**
 * ★★★ 「收起」的两张豁免表（2026-09-15 · 主控裁）。**这两张按「全等」比，不是 includes。**
 *
 * ══ 为什么这一条不能照 `FOLDER_OK` 那样比子串 ═══════════════
 * 折叠那三处屏上的字**就是裸的「收起」两个字**（`{allOcc ? '收起' : …}`）。
 * 一条 `'收起'` 的子串豁免会把「**已收起 1 条**」一起放过 —— 那正是要拦的那四处。
 * ☞ 所以这里改成**全等**（空白归一后）：`'收起' !== '已收起 1 条'`，分得开。
 * ☞ 更一般的那句教训：**整句豁免只在「合法用法所在的句子比被禁词长」时才成立**；
 *   当合法用法本身就等于那个词，子串豁免会**退化成全局豁免** —— 闸还在，但它什么都不拦了。
 *
 * ── FOLD_OK：永久。这里的「收起」是**折叠**，不是静默动作 ──
 *   和「放回去」在词典那一路一样：那就是那件事本来的说法，改它才是错的。
 */
const FOLD_OK = ['收起', '关 = 星收起 · 分享/选中菜单这些明确动作仍可用']

/**
 * ★★★ 这里原来还有一张 `SHELVE_TODO`（2026-09-15 白天挂号的四处「已收起 N 条」）。
 *   **它自己到期了**：使用者点完审查页、A-2 把那四处改成走常量之后，
 *   下面 N-5 当场红在「豁免表里的『已收起 1 条』屏上已经没有了 —— 把这一行删掉」，
 *   逼着在同一笔里删掉整张表。**没有人需要记得回来收它。**
 *   ☞ 这就是当初「先挂号、不硬改」的理由：既没让主线红着挡别人，
 *     也没把一张免检表留成长住的。
 */

/** 空白归一：`已收起 ${n} 条` 去掉表达式之后是「已收起   条」 */
const normText = (s: string): string => s.trim().replace(/\s+/g, ' ')

/**
 * ★★★ 「放回去」的整句豁免（2026-09-15 · 主控点头）。
 *
 * 这两句说的是**把词典文件放回那个真的操作系统文件夹** —— 和静默毫无关系。
 * 「放回去」在那儿**就是那件事本来的说法，改它才是错的**。
 *
 * ☞ 和下面 `FOLDER_OK` 完全同形，连理由都是同一条：
 *   **豁免按整句给，不按文件给** —— 文件粒度会把同一个文件里将来新写的、
 *   真指静默动作的那一句一起放过。这两句原样列在这里，
 *   谁改动其中一句，它就重新落回闸里，**这是有意的**。
 * ★ 我先问过能不能换个词避开豁免；主控裁不换 —— 为了迁就闸去改一句本来正确的话，
 *   方向是反的。
 */
const RESTORE_OK = ['这本不在词典文件夹里了', '不在夹里了 —— 重新扫描或放回去']

const FOLDER_OK = [
  '读不了词典文件',
  '去 设置 → 词典 选文件夹、扫描一次',
  '词典文件夹',
  '把 .mdx 放进一个文件夹',
  '这本不在词典文件夹里了',
  // ★ 2026-09-14 闸扩到原生层之后新进来的两句：`DictPlugin.listFolder` 说的是
  //   他在系统选择器里挑的那个**真的文件夹**（权限丢了就读不了），不是 Lecture 的旧名。
  '没有文件夹 uri',
  '读不了这个文件夹：'
]

  it('N-1 · 屏幕上不许出现旧名：Lecture 这一层写 Lecture，废弃词一个不留', () => {
    const bad: string[] = []
    const hit = (f: string, body: string, text: string, at: number): void => {
      for (const [re, why] of BANNED) {
        for (const m of text.matchAll(re)) {
          if (m[0] === '文件夹' && FOLDER_OK.some((ok) => text.includes(ok))) continue
          if (m[0] === '放回去' && RESTORE_OK.some((ok) => text.includes(ok))) continue
          // ★ 全等，不是 includes —— 理由见 FOLD_OK 头上那段
          if (m[0] === '收起' && FOLD_OK.includes(normText(text))) continue
          const line = body.slice(0, at).split('\n').length
          bad.push(`${relative(ROOT, f)}:${line} 「${m[0]}」—— ${why}`)
        }
      }
    }

    for (const f of scanned()) {
      const body = stripComments(readFileSync(f, 'utf8'), f)
      // ★ 字面量里的 `${…}` 是**表达式**，不是屏上的字：`${lectureId}` 里的
      //   lecture 是标识符。不去掉它，闸会对着一句已经改好的话喊旧名。
      for (const m of body.matchAll(CJK_LITERAL)) {
        hit(f, body, dropExpr(m[2] ?? ''), m.index ?? 0)
      }
      // ★ 文字节点只有标记里才有；`.ts` 上跑这条只会捞到 `Promise<number>` 这种噪声
      if (!MARKUP.some((e) => f.endsWith(e))) continue
      for (const m of body.matchAll(TEXT_NODE)) {
        // ★ `>` 不只出现在标签末尾 —— 内联处理器里的箭头（`onclick={() => …}`）
        //   也有一个，于是「标签外的文字」这条朴素规则会把半截代码当成文案。
        //   先去掉插值 `{…}`，再要求剩下的不含代码符号：留下的才是真的文案。
        const seg = (m[1] ?? '').replace(/\{[^{}]*\}/g, ' ')
        if (/[={}'"`]/.test(seg)) continue
        hit(f, body, seg, m.index ?? 0)
      }
    }

    assert.deepEqual(bad, [], `界面上还留着旧名：\n  ${bad.join('\n  ')}`)
  })

  it('N-2 · 改过名的那几句真的在（改回旧名这条就红）', () => {
    const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
    const pinned: [string, string][] = [
      ['src/ui/views/Lecture.svelte', 'title="删除这个 Lecture？"'],
      ['src/ui/views/Lecture.svelte', '（这个 Lecture 还没有知识点）'],
      ['src/ui/views/Atlas.svelte', '（这个单元还没有 Lecture）'],
      ['src/ui/lib/CreateMenu.svelte', '还没有 Unit —— <b>先建一个 Unit</b>，Lecture 才有地方放。'],
      /**
       * ★ D-485：这一档是中性名（装着「已练成」和「收起来了」两种，叫其中一个是假话）。
       * ★★ 2026-09-15 起钉的是**引用**不是字面量：那几个字收进 core 了
       *   （`SILENCE_FILTER_NAME`），两端同一份。钉字面量的话，谁把它改回
       *   本端自己写死也照样绿 —— 而那正是「两端各写一份」重新长出来的第一步。
       */
      ['src/ui/views/Vault.svelte', '<span class="nm zh">{SILENCE_FILTER_NAME}</span>'],
      /**
       * ★ 2026-09-15 · 这一串跟着标记改了一次：`lecture-split` 的靶子挂上了这一行
       *   （`data-guide="lecture-split"`）。**强度一个字没松** —— 仍是全等，
       *   把「知识点」改回旧名照样红。只是「这一行」现在多了个属性。
       * ☞ 顺带记一课：钉整段标记的代价是**任何属性变动都会红**，
       *   而那时候红的理由和这条闸想说的话（「名字被改回去了」）对不上。
       *   下一个人若为此烦，正确的动作是把判据改成钉那一行的**文字**，不是删掉它。
       */
      ['src/ui/views/Lecture.svelte', '<div class="lab zh" data-guide="lecture-split">知识点</div>'],
      ['src/ui/lib/ItemMenu.svelte', '<span class="zh">随时认读这一条</span>'],
      ['src/ui/lib/ItemMenu.svelte', '<span class="zh">随时练习这一条</span>']
    ]
    for (const [f, s] of pinned) {
      assert.ok(read(f).includes(s), `${f} 里那句改过的名字没了：${s}`)
    }
  })

  it('★★ N-3 · 闸的范围：屏上有字的四个地方它都够得着（闸名不许比断言大）', () => {
    /**
     * ★★ H-3 乙那条教训的正面做法：**把范围本身写成断言**。
     *   上一版这道闸叫「屏幕上不许出现旧名」，而它只扫 `src/ui` + `src/db` ——
     *   名字盖住全屏，断言只盖住一半，**而第三方 App 里那一半界面（原生层）完全在外面**。
     *   2026-09-14 扩到黑名单之后当场多出 4 处，其中 2 处是真的退役词
     *   （引擎一句 + `NyxAssistService` 一条 toast）。
     * ★ 所以这条钉的不是「有没有旧名」，是「**它有没有在看**」：
     *   四个出屏口各挑一个真有可见文字的文件，少一个这条就红。
     */
    const files = scanned()
    const has = (p: string): boolean => files.includes(join(ROOT, p))
    const must: [string, string][] = [
      ['src/ui/views/Settings.svelte', '应用内的屏'],
      ['src/db/dict.ts', '库这一层也会上屏（2026-09-08 漏过一次）'],
      ['src/engine/main.ts', 'Assist 引擎（无头 WebView）回给他的话'],
      ['index.html', '启动那一帧 —— 它今天一个字都不说，但明天可能会'],
      ['android/app/src/main/java/com/nyx/android/NyxAssistService.java', '★ 第三方 App 里那一半界面，全在原生层'],
      ['android/app/src/main/res/values/strings.xml', '无障碍服务的说明（系统设置里他会读到）']
    ]
    const blind = must.filter(([p]) => !has(p)).map(([p, why]) => `${p}（${why}）`)
    assert.deepEqual(blind, [], `★★ 这道闸看不见这些地方了：\n  ${blind.join('\n  ')}`)
  })

  it('★ N-4 · 不扫的那几个都还在，而且各有理由', () => {
    // ★ 黑名单会漂的方向是「跳过一个已经不存在的文件」—— 那条理由就成了摆设，
    //   而真正该跳过的新文件没人加。所以每条都核一遍文件还在不在。
    for (const [p, why] of SKIP) {
      assert.ok(existsSync(join(ROOT, p)), `★ SKIP 里这条指的文件没了：${p}（${why}）`)
      assert.ok(why.length > 6, `★ ${p} 的理由太短 —— 「不扫」是个决定，得说清为什么`)
    }
  })
  it('★★ N-5 · 「收起」豁免表只许缩短：表里每一条都还得在屏上找得到', () => {
    /**
     * ★★★ 免检条目最坏的坏法不是「写错了」，是**它守的那件事早就没了、而它还在**。
     *   没人会回头查一张绿着的表。所以让闸来查：表里的句子一旦不在屏上了，
     *   这条当场红，逼人把那一行删掉。
     * ☞ `SHELVE_TODO` 就是靠这一条**自己过期**的 ——
     *   使用者划完 A-2、文案改成常量，那四句一消失，整张表就被逼着删掉。
     */
    const seen = new Set<string>()
    for (const f of scanned()) {
      const body = stripComments(readFileSync(f, 'utf8'), f)
      for (const m of body.matchAll(CJK_LITERAL)) seen.add(normText(dropExpr(m[2] ?? '')))
      if (!MARKUP.some((e) => f.endsWith(e))) continue
      for (const m of body.matchAll(TEXT_NODE)) {
        const seg = (m[1] ?? '').replace(/\{[^{}]*\}/g, ' ')
        if (/[={}'"`]/.test(seg)) continue
        seen.add(normText(seg))
      }
    }
    for (const ok of FOLD_OK) {
      assert.ok(
        seen.has(normText(ok)),
        `★★ 豁免表里的「${ok}」屏上已经没有了 —— 把这一行删掉。` +
          '（留着一条守着不存在的东西的免检，比没有免检更糟：它会一直绿着）'
      )
    }
  })

})
