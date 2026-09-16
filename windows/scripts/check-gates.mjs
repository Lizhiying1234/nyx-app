/**
 * check:gates · 具名闸清单的闸（Z-3 / Z-4，2026-09-15）
 *
 * ══ 病 ══════════════════════════════════════════════════════
 * 四门（check / test / test:db / smoke）全绿，能说明「跑过的都过了」，
 * **说不出「该跑的都还在」**。这几天连着栽了五次「闸看的不是它以为在看的」：
 *   注释被数进去 ×2 · 自己塞数据绕过产品代码 ×1 · import 了没用上 ×1 · 同名串骗绿 ×1；
 * 另有 `npm test` 441 → 440 无人拦、`seg('mode-practice')` 写好了一次没调。
 * 少一道闸、少一条用例、闸被改成哑巴 —— 这三件**都不会红**，只会安静地变绿。
 *
 * ══ 这道闸看三件事 ══════════════════════════════════════════
 *   ① 清单里每条 `path` 真存在（写了个不存在的路径 = 这条记录在骗人）
 *   ② 仓里每份用例文件 / 每条 `check:*` / 每套 `smoke:*` 都在清单里
 *      —— **没名字的闸不许存在**
 *   ③ 每条的实际标题数 ≥ 清单记的 `titles`（**棘轮，只许往上**）
 *      少了 = 有人把用例拿走了；多了要回来把数字改上去。
 *   ④ `control` 为 null 的条数 ≤ 清单里记的上限（**棘轮，只许往下**）
 *
 * ══ 它**不**看什么（写在明处）══════════════════════════════
 * 不判 `guards` 那句话写得对不对 —— 那是人读的时候的事。这道闸只回答
 * 「闸还在不在、用例有没有少、对照有没有做」。
 * ★ 也不给每条**标题**建清单：几千条，改一个字就要动清单，两天就没人维护。
 *   清单到文件 / 套，标题只记**数**。
 *
 * ══ 抽标题前先剥注释（B 提、主控采纳的通用判据之一）══════════
 * 注释里提一嘴 `it('…')` 不算一条用例。不剥的话，把一条用例改成注释、
 * 再在别处注释里原样写一遍，这道闸就哑了 —— 那正是 `check:css-dead`
 * 栽过的同一个坑（Z-1）。
 * ★ **字符串字面量不剥**：`it(` 的标题本来就住在字符串里。
 *
 * ══ Z-7（2026-09-15）· ② 档整个不在覆盖面里，那才是最大的一个洞 ══
 * 第一版的 `walk()` 只收 `*.test.ts`。可 `test:db` 那 600 多条检查住在
 * `tests/db-safety/*.ts` —— **不带 `.test`**，于是 23 份文件在这道闸眼里根本不存在，
 * 「没名字的闸不许存在」那句话漏了一整档。
 * ★ 这比「派单枚举写漏了」更值得记：**一道闸的覆盖面由它的文件名正则决定，
 *   而那个正则没有任何东西在核对**。写闸时问一句「我这个 `walk` 收得全吗」，
 *   和问「我这个断言对不对」一样重要。
 * ★ 单位也不一样：那些文件里一条检查写作 `check(…)` / `checkAsync(…)`，不是 `it(`。
 *   所以计数按**文件自己的写法**分流（见 `countUnits`），不硬套一种。
 *
 * 用法：node scripts/check-gates.mjs
 *   `NYX_GATES=<别的 json>` 让它去查另一份 —— 负向对照拿副本做，仓里那份一个字节不动。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { selfCheck, stripSource } from './lib/strip-comments.mjs'

/**
 * ★★ 先验一遍自己的尺（2026-09-15）。
 *
 * 这道闸数的是「用例标题」，而标题是从**剥掉注释之后**的源码里数的 ——
 * 尺子歪一点，数出来的标题数就跟着歪，而棘轮只认「只许往上」，
 * 于是**一把歪尺量出来的地板会被当成事实钉死**。
 * 真出过：剥注释那份判据不认正则字面量，一口吃掉几十行，
 * 注释掉的 `it('…')` 被算成真标题。所以量之前先验尺。
 */
const STRIP_OK = selfCheck()

const BS = String.fromCharCode(92) // 反斜杠绕开写（D-460）
const NL = String.fromCharCode(10)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..').split(BS).join('/')
const MANIFEST = process.env['NYX_GATES'] ?? join(ROOT, 'tests/gates.json').split(BS).join('/')

/**
 * ★ 剥注释那套判据搬进了 `lib/strip-comments.mjs`（Z-5，2026-09-15）：写第三个扫源码的闸时，
 *   这块代码就要有第三份拷贝了 —— 而这一整轮反复撞的正是
 *   「两份实现从第一天就会不一致，而不一致的那天没人会发现」。
 *   行为一个字没改；两道闸的负向对照改完重跑过。
 */

/**
 * 一份文件里有几条「用例」。**单位按文件自己的写法分流**（Z-7）：
 *   `tests/db-safety/*.ts`   → `check(…)` / `checkAsync(…)`（② 档的写法）
 *   其余 `*.test.ts`         → `it(` / `test(`（含 `.only` / `.skip`）
 * ★ 硬套一种的话，② 档全都数成 0，清单看着齐全而地板是假的。
 */
const countUnits = (rel, src) => {
  const s = stripSource(src, rel)
  const re = rel.startsWith('tests/db-safety/')
    ? /(?:^|[^a-zA-Z])check(?:Async)?[(]/g
    : /(?:^|[^a-zA-Z])(?:it|test)[.a-z]*[(]/g
  return [...s.matchAll(re)].length
}

/**
 * 收哪些文件算「仓里的闸」。
 * ★ `tests/db-safety/` 下的 **每一个 `.ts` 都要收**，不挑 `.test.ts`：② 档的文件不带那个中缀，
 *   按后缀挑就会把一整档漏在覆盖面外（Z-7 之前就是这样）。
 *   那一目录里的骨架 / 夹具（`harness.ts` / `fixtures.ts`）也要登记 ——
 *   它们不是闸，但**必须在册**：`check()` 本身要是被改成不断言，整档会一起变绿。
 */
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out
  const inDbSafety = dir.split('/').includes('db-safety')
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name).split(BS).join('/')
    if (e.isDirectory()) walk(full, out)
    else if (inDbSafety ? /[.]ts$/.test(e.name) : /[.]test[.]ts$/.test(e.name)) {
      out.push(full.slice(ROOT.length + 1))
    }
  }
  return out
}

const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const gates = doc.gates ?? []
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const bad = []

// ── ① 清单里每条 path 真存在 ─────────────────────────────────
for (const g of gates) {
  if (g.path === null || g.path === undefined) continue
  if (!existsSync(join(ROOT, g.path))) {
    bad.push(`清单里的 ${g.name} 指着一条不存在的路径：${g.path}`)
  }
  if (!g.guards || !String(g.guards).trim()) {
    bad.push(`${g.name} 没写 guards —— 一条说不出自己盯什么的闸，等于没有`)
  }
}

// ── ② 仓里每道闸都在清单里（没名字的闸不许存在）────────────────
const listed = new Set(gates.map((g) => g.path).filter(Boolean))
for (const f of [...walk(join(ROOT, 'src/core')), ...walk(join(ROOT, 'tests'))]) {
  if (!listed.has(f)) bad.push(`仓里有一份用例文件不在清单里：${f}（没名字的闸不许存在）`)
}
const names = new Set(gates.map((g) => g.name))
for (const k of Object.keys(pkg.scripts ?? {})) {
  if (!k.startsWith('check:') && !k.startsWith('smoke')) continue
  if (!names.has(k)) bad.push(`package.json 里有一道闸不在清单里：${k}`)
}

// ── ③ 标题数棘轮：只许往上 ───────────────────────────────────
let titlesNow = 0
for (const g of gates) {
  if (g.titles === null || g.titles === undefined || !g.path) continue
  const p = join(ROOT, g.path)
  if (!existsSync(p)) continue // ① 已经报过了
  const actual = countUnits(g.path, readFileSync(p, 'utf8'))
  titlesNow += actual
  if (actual < g.titles) {
    bad.push(
      `${g.path} 的用例少了：清单记 ${g.titles} 条，现在只有 ${actual} 条` +
        ` —— 有人把闸拿走了。真要删就同时改清单，并在 guards 里写「删于 / 为什么」`
    )
  }
}

/**
 * ★★ ④-b 先按**名字**核一遍：谁的对照记录没了（主控 2026-09-15 提，采纳）。
 *
 * 只数个数是不够的 —— 我自己就栽过：生成器整份重写把主控手填的几条抹成 null，
 * `controls_missing` 悄悄从 117 涨到 143，而**棘轮只拦「变多」，它不会告诉你是谁的记录没了**；
 * 更坏的情形是一增一减、数字纹丝不动。所以记下**哪几条有**，按名字对。
 */
const recorded = doc.controls_recorded ?? []
const hasControl = new Set(
  gates.filter((g) => g.control).map((g) => g.path ?? g.name)
)
for (const key of recorded) {
  if (!hasControl.has(key)) {
    bad.push(
      `「${key}」的对照记录没了 —— 它在 controls_recorded 里，可现在 control 是空的。` +
        ` 谁做的对照谁知道那句红在哪，别把它抹掉；真要撤，连 controls_recorded 一起改并写清为什么`
    )
  }
}

// ── ④ 对照记录棘轮：只许往下 ─────────────────────────────────
const missing = gates.filter((g) => g.control === null || g.control === undefined).length
const cap = doc.controls_missing_max
if (typeof cap !== 'number') {
  bad.push('清单里没有 controls_missing_max —— 没有上限的棘轮不是棘轮')
} else if (missing > cap) {
  bad.push(
    `没做过对照的闸有 ${missing} 条，超过上限 ${cap}` +
      ` —— 这一栏只许往下走：新加的闸要么当场做一次对照，要么先把别的补上`
  )
}

if (bad.length > 0) {
  console.error('✖ check:gates —— ' + bad.length + ' 条')
  console.error(bad.map((b) => '  ' + b).join(NL))
  console.error('')
  console.error('★ 清单在 tests/gates.json。它只回答三件事：闸还在不在 · 用例有没有少 · 对照有没有做。')
  console.error('  它不判 guards 那句话写得对不对 —— 那是人读的时候的事。')
  process.exit(1)
}

console.log(
  'check:gates　尺子自检 ' +
    STRIP_OK +
    ' 句 · ' +
    gates.length +
    ' 道闸都有名字（check ' +
    gates.filter((g) => g.name.startsWith('check:')).length +
    ' · smoke ' +
    gates.filter((g) => g.name.startsWith('smoke')).length +
    ' · 用例文件 ' +
    gates.filter((g) => g.titles !== null && g.titles !== undefined).length +
    '（含 ② 档 ' +
    gates.filter((g) => (g.path ?? '').startsWith('tests/db-safety/')).length +
    ' 份）' +
    '）· 标题 ' +
    titlesNow +
    ' 条（清单地板 ' +
    gates.reduce((n, g) => n + (g.titles ?? 0), 0) +
    '，只许往上）· 没做过对照的 ' +
    missing +
    ' / 上限 ' +
    cap +
    '（只许往下）· 按名钉住 ' +
    recorded.length +
    ' 条'
)
