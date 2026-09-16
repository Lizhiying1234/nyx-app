/**
 * 把源码里「不是代码的那部分」剥掉 —— **只剥注释，绝不剥字符串字面量**。
 *
 * ══ 为什么这份要单独住一个文件（2026-09-15，Z-5）══════════════
 * 在这之前它有两份拷贝（`check-css-dead.mjs` 与 `check-gates.mjs`），写 Z-5 时
 * 差点写第三份。而这一整轮（Z-1～Z-7）反复撞的就是同一句话：
 * **两份实现从第一天就会不一致，而不一致的那一天没人会发现。**
 * 扫源码的闸越来越多，这块判据必须只有一处。
 *
 * ══ 为什么必须剥注释 ═════════════════════════════════════════
 * 一条早已没人用的东西，只要还有谁在注释里提过它的名字，就能一直躲过闸；
 * 而注释恰恰最爱提死掉的东西（「这里原来是一个 X」）。三天里骗绿三次。
 *
 * ══ 为什么**不**剥字符串 ═════════════════════════════════════
 * 判据要认的东西本来就住在字符串里：类名（`class="{x} pvcard"`）· 用例标题
 * （`it('…')`）· 引导 id（`askGuide('today-paste')`）。剥了就把活的判死。
 * ★ 所以扫描器**先认字符串，再认注释** —— 顺序反了会把 `https://x` 里那两个
 *   斜杠当成行注释，从那儿一路吃到行尾。
 *
 * ══ `.svelte` 为什么只在 `<script>` 里剥 JS 注释 ═══════════════
 * markup 那半里的两个斜杠多半是正文或不带引号的属性值，不是注释；在那儿动手
 * 会误伤 `class:sel` 这种**不带引号**的活类名。markup 的注释是 `<!-- -->`，单独剥。
 */

const BS = String.fromCharCode(92) // 反斜杠绕开写（D-460）
const NL = String.fromCharCode(10)
const WS = ' ' + NL + String.fromCharCode(9) + String.fromCharCode(13)

const isWordChar = (c) =>
  c !== undefined &&
  ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$')

/** 这些词后面跟的 `/` 一定是正则开头，不是除号 */
const BEFORE_REGEX = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'instanceof',
  'do', 'else', 'new', 'delete', 'void', 'yield', 'await', 'throw'
])

/**
 * 这个 `/` 是**正则的开头**还是**除号**？只看它前面最近的那个有意义的字符。
 *
 * 判错的代价不对称，所以这里故意偏保守 —— 见 `regexEnd` 的「不跨行」那条：
 * 把除号错当正则，最多吃掉同一行里的一小段；反过来（今天的行为）会吃掉几十行。
 */
function regexCanStart(out) {
  let k = out.length - 1
  while (k >= 0 && WS.includes(out[k])) k--
  if (k < 0) return true
  if ('([{,;:=!&|?+-*%^~<>'.includes(out[k])) return true
  let s = k
  while (s >= 0 && isWordChar(out[s])) s--
  return BEFORE_REGEX.has(out.slice(s + 1, k + 1))
}

/**
 * 从 `/` 扫到正则结尾（含 `gimsuy` 那些标志位），返回结尾后一位；认不出就 -1。
 *
 * ★ **正则不跨行**：扫到换行还没收口就判 -1，当它是除号。
 *   这条是这次修复真正的保险 —— 就算 `regexCanStart` 判错了，损失也被关在一行里。
 * ★ 认字符类 `[...]`：`/[/]/` 里那个斜杠不收口。
 */
function regexEnd(src, i) {
  let j = i + 1
  let inClass = false
  while (j < src.length) {
    const c = src[j]
    if (c === NL) return -1
    if (c === BS) {
      j += 2
      continue
    }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      j++
      while (j < src.length && isWordChar(src[j])) j++
      return j
    }
    j++
  }
  return -1
}

/**
 * ★★ 挖空一段注释时，**换行要不要留**（2026-09-15 加的选项）。
 *
 * 默认（`keepLines` 为假）整段换成一个空格 —— 闸只做子串 / 正则匹配，不关心位置。
 * 但**要报行号的调用方**（`copy-inventory.mjs` 那份给人读的清单）不行：
 * 一段 12 行的 JSDoc 塌成一个空格，后面每一行的行号都往前挪 ——
 * 报出来的「文件 : 行」指到别处去，而**清单自己看不出有问题**，
 * 是抽查源码才发现的（第一版整张表的行号全是歪的）。
 * ☞ `keepLines: true` 时逐字符换空格、换行原样留下：行号 = 文件里的行号。
 */
const blank = (seg, keepLines) => {
  if (!keepLines) return ' '
  let out = ''
  for (const c of seg) out += c === NL ? NL : ' '
  return out
}

/** JS / TS 注释。字符串与模板串整段原样留下 */
export function stripJsComments(src, keepLines = false) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n) {
        if (src[i] === BS) {
          out += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        out += src[i]
        const closed = src[i] === quote
        i++
        if (closed) break
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const from = i
      while (i < n && src[i] !== NL) i++
      out += blank(src.slice(from, i), keepLines)
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*' + '/', i + 2)
      const to = end === -1 ? n : end + 2
      out += blank(src.slice(i, to), keepLines)
      i = to
      continue
    }
    /**
     * ★★★ 正则字面量（2026-09-15 · B 发现并修，这是我提的）
     *
     * ══ 不认它会怎样 ══════════════════════════════════════════
     * 上一版这里没有这一段：碰到 `/` 不是 `//` 也不是 `/*`，就当普通字符吐出去。
     * 于是 `.replace(/…`…`…/g, '<code>$1</code>')` 里那个反引号被当成**模板串的开头**，
     * 扫描器从那儿一路吃到下一个反引号 —— `FileStudy.svelte` 实测一口吃掉 **37 行**。
     * 被吃掉的那一段里，**注释原样留了下来**。
     *
     * 而这份判据的全部意义就是「注释里提过的名字不算数」（见文件头）。
     * 结果：`check:css-dead` 里一条只在注释里出现过的类名会被当成活的 ——
     * **死规则安安静静地绿着**，正是文件头说要防的那件事。
     * `check:gates` 同理：注释掉的 `it('…')` 会被算成真标题，而标题数是只许往上的棘轮。
     *
     * ══ 波及面（实测）═════════════════════════════════════════
     * 全仓 432 份文件里 23 份有这种「跨行的假字符串」，`tests/study.test.ts` 最多。
     * 三道闸吃这份判据（`css-dead` · `gates` · `guide-ids`），而它**一条用例都没有** ——
     * 判据集中到一处是对的，但集中之后没配用例，等于把三道闸的命押在没人验过的 60 行上。
     * 所以这一版连 `selfCheck()` 一起加，由 `check:gates` 每次跑。
     *
     * ══ 为什么原样吐出去而不是剥掉 ════════════════════════════
     * 同字符串一个道理（见文件头「为什么**不**剥字符串」）：正则里住着判据要认的东西
     * （`/pvcard|ppane/` 这种类名白名单、用例标题里的匹配串）。剥了就把活的判死。
     */
    if (c === '/' && regexCanStart(out)) {
      const end = regexEnd(src, i)
      if (end > 0) {
        out += src.slice(i, end)
        i = end
        continue
      }
    }
    out += c
    i++
  }
  return out
}

/** `<!-- … -->`。换成空格而不是删空 —— 免得把两边的词粘成一个新词 */
export const stripHtmlComments = (src, keepLines = false) =>
  src
    .split('<!--')
    .map((part, k) => {
      if (k === 0) return part
      const end = part.indexOf('-->')
      if (end === -1) return keepLines ? blank(part, true) : ''
      return blank('<!--' + part.slice(0, end + 3), keepLines) + part.slice(end + 3)
    })
    .join('')

/** 按后缀分流。`file` 只用来看后缀，可以是相对路径 */
export function stripSource(src, file, keepLines = false) {
  if (file.endsWith('.svelte') || file.endsWith('.html')) {
    const noHtml = stripHtmlComments(src, keepLines)
    return noHtml.replace(/<script[^>]*>[^]*?<[/]script>/g, (blk) => stripJsComments(blk, keepLines))
  }
  return stripJsComments(src, keepLines)
}

/**
 * ★★★ 这份判据自己的用例（2026-09-15 · 跟正则那个洞一起加的）
 *
 * ══ 为什么钉在模块里，而不是另起一份 `.test.ts` ═══════════════
 * `npm test` 只收 `src/core/**` 那一圈，`scripts/` 底下的东西它**看不见**。
 * 另写一份测试文件要么没人跑（最坏的一种：文件在、绿着、但不在任何一档里），
 * 要么得动 `check:suites` 那套簿记。而这份判据的三个消费者都是闸 ——
 * 让闸每次启动先验一遍自己的尺，是最短也最不容易烂掉的一条路。
 * `check:copy` 的「自检 11 句」就是同一个做法。
 *
 * ★ 每条都写清**它守的是哪件事**。将来哪条红了，读的人要能当场知道
 *   「这是在防什么」，而不是只看到一句 expected/actual。
 */
export function selfCheck() {
  const TICK = String.fromCharCode(96)
  const Q = String.fromCharCode(39)
  const cases = [
    // 本行 —— 剥注释这件事本身
    ['/* 走开 */ let a = 1', 'let a = 1', '块注释要剥掉'],
    ['let a = 1 // 走开', 'let a = 1', '行注释要剥掉'],
    ['/** 这里原来有个 pvcard */ let a = 1', 'let a = 1',
      '注释里提过的名字不算引用 —— 这份判据的全部理由'],

    // 字符串绝不能被剥（剥了就把活的判死）
    [Q + 'pvcard' + Q, Q + 'pvcard' + Q, '字符串原样留下'],
    [Q + 'https://x' + Q, Q + 'https://x' + Q, '网址里那两个斜杠不是行注释'],
    [TICK + 'a // b' + TICK, TICK + 'a // b' + TICK, '模板串里的两个斜杠也不是'],

    // ★ 正则字面量 —— 这次真踩的那个洞
    /**
     * ★★★ 拄现场那一句的**原样**（`FileStudy.svelte`）—— 不凭印象重写。
     *   我第一版把它写成了 `/` + TICK + `(.+?)` + TICK + `/g`，
     *   里面反引号是**偶数个**—— 自己配上对，**没修也绿**。
     *   跑负向对照才发现它是摆设：红在下一句上，不是这一句。
     *   真现场那一句是 `/` + TICK + `([^` + TICK + `]+)` + TICK + `/g` —— **奇数个**，
     *   最后那一个配不上对，扫描器就从那儿一路吃到下一个反引号。
     * ☆ 教训：对照用的例子要拄真的那一行；自己编一个「差不多的」，
     *   很容易刚好编成不触发那个条件的那种。
     */
    ['x.replace(/' + TICK + '([^' + TICK + ']+)' + TICK + '/g, ' + Q + 'c' + Q + ') // 走开',
      'x.replace(/' + TICK + '([^' + TICK + ']+)' + TICK + '/g, ' + Q + 'c' + Q + ')',
      '正则里的反引号不是模板串开头（FileStudy.svelte 实测被吃掉 37 行）'],
    ['if (/[' + Q + '"]/.test(x)) { } // 走开', 'if (/[' + Q + '"]/.test(x)) { }',
      '正则里的单双引号也不是字符串开头'],
    ['const re = /[/]/ // 走开', 'const re = /[/]/', '字符类里的斜杠不收口'],
    ['x.match(/pvcard/) ', 'x.match(/pvcard/)', '正则里的类名要留着 —— 同字符串一个道理'],

    // 除号不能被当成正则
    ['const r = a / b // 走开', 'const r = a / b', '除号不是正则开头'],
    ['const r = (a) / (b) // 走开', 'const r = (a) / (b)', '右括号后面的斜杠是除号'],

    // 认错了也要被关在一行里
    ['let a = 1 / 2' + NL + '// 走开' + NL + 'let b = 2', 'let a = 1 / 2' + NL + ' ' + NL + 'let b = 2',
      '斜杠到行尾都没收口 → 当除号，下一行的注释照剥'],

    // ★ keepLines：挖空但行数不变（报行号的调用方靠它）
    ['let a = 1' + NL + '/* 一' + NL + '   二 */' + NL + 'let b = 2', null,
      'keepLines 下行数必须原样', 'keep'],

    // .svelte 两半各走各的
    ['<script>let a = 1 // 走开' + NL + '</script>' + NL + '<!-- 走开 -->' + NL + '<b>留着</b>',
      null, '两半的注释都要剥、正文留下', 'x.svelte']
  ]

  let ok = 0
  for (const [src, want, why, file] of cases) {
    if (file === 'keep') {
      const kept = stripJsComments(src, true)
      if (kept.split(NL).length !== src.split(NL).length) {
        throw new Error(
          '剥注释自检红：' + why + ' —— 行数从 ' + src.split(NL).length +
            ' 变成了 ' + kept.split(NL).length + '，报出来的行号会指到别处'
        )
      }
      if (kept.includes('二')) throw new Error('剥注释自检红：' + why + ' —— 注释没挖掉')
      ok++
      continue
    }
    const got = (file ? stripSource(src, file) : stripJsComments(src)).replace(/[ ]+/g, ' ').trim()
    if (file) {
      if (got.includes('走开')) throw new Error('剥注释自检红：' + why + ' —— 还留着注释：' + JSON.stringify(got))
      if (!got.includes('留着')) throw new Error('剥注释自检红：' + why + ' —— 正文被剥掉了：' + JSON.stringify(got))
      ok++
      continue
    }
    const exp = want.replace(/[ ]+/g, ' ').trim()
    if (got !== exp) {
      throw new Error(
        '剥注释自检红：' + why + NL + '  给它：' + JSON.stringify(src) + NL +
          '  应得：' + JSON.stringify(exp) + NL + '  实得：' + JSON.stringify(got)
      )
    }
    ok++
  }
  return ok
}
