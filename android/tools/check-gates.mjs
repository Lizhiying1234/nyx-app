/**
 * `check:gates` —— 具名闸清单的闸（ZA-3 · 2026-09-15）。
 *
 * ══ 它拦什么 ═══════════════════════════════════════════════
 * 闸被删掉、改名、或者悄悄不再盯它原来盯的东西时，**四门照样全绿**。
 * 这一轮撞过两次：I-187 的修复与盯着它的那条用例**死在同一次合并里**；
 * `port-names` 那条数出现次数的断言被一条注释顶替。两次都没有任何东西说话。
 * 这道闸让「少了一道闸」「一条用例悄悄没了」本身变成红的。
 *
 * ══ ★ 覆盖面：`walk()` 收哪些、故意不收哪些 ══════════════════
 *   **收**：`tests/*.test.ts`（每份一道闸）· `tools/check-*.mjs`（每支一道）。
 *          例：`tests/upgrade.test.ts` 收 · `tools/check-css.mjs` 收。
 *   **不收**：
 *     · `tests/` 下的非 `.test.ts`（`helpers.ts` / `fixtures/`）——
 *       它们不是闸，但**在册**（清单里有、`titles` 为 null），
 *       这样「有人把 helpers 改成一道闸」也会被发现。
 *       例：`tests/helpers.ts` 不收进「必须有 titles」那一组。
 *     · `tools/` 下不以 `check-` 开头的（`build-info.mjs` / `tokens-to-android.mjs`
 *       / `device/*`）—— 它们是构建与真机工具，不是判据。
 *       例：`tools/prune-woff.mjs` 不收。
 *     · `nyx-core/`（判据在那边，有它自己的门，Android 不重复跑）。
 *       例：`nyx-core/src/core/prefs.ts` 不收。
 *   ☞ 覆盖面写在这儿是因为**闸的范围本身会漂**：某天有人把用例放进
 *     `tests/sub/` 目录，这支脚本看不见它，而清单不会红（N-3 同族）。
 *
 * ══ 五条判据 ═══════════════════════════════════════════════
 *   ① 清单里每条的 `path` 真的存在（N-4：闸指着不存在的东西 = 哑闸）
 *   ② 磁盘上每道闸都在清单里（没名字的闸不许存在）
 *   ③ `titles` 只许升 —— 一条用例悄悄没了要红
 *   ④ `controls_missing_max` 只许降 —— 没有对照记录的闸只许越来越少
 *   ⑤ `controls_recorded` **按名字钉住** —— 一增一减数字不动那种要拦得住
 *
 * ★ `--fix` 只**补**不**盖**：新闸补一行占位（`guards` 留空会被 ① 拦下，
 *   逼人手写），已手填的 `control` 一个字不动。
 *   理由：`control` 是「真记过」的记录，机器补写出来的就是假的（ZA-4）。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { selfCheck, stripSource } from './lib/strip-comments.mjs'

/**
 * ★★ 先验一遍自己的尺（2026-09-15 · 逐字跟 Windows 的修法）。
 *
 * 这道闸数的是「用例标题」，而标题是从**剥掉注释之后**的源码里数的 ——
 * 尺子歪一点，数出来的标题数就跟着歪，而棘轮只认「只许往上」，
 * 于是**一把歪尺量出来的地板会被当成事实钉死**。
 * 真出过：剥注释那份判据不认正则字面量，一口吃掉几十行，
 * 注释掉的 `it('…')` 被算成真标题。所以量之前先验尺。
 */
const STRIP_OK = selfCheck()

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const LIST = join(ROOT, 'tests', 'gates.json')
const FIX = process.argv.includes('--fix')

/** 标题条数。★ 先剥注释；★★ 排除 `/re/.test(x)` 里那个 `.test(` */
const TITLE_RE = /(^|[;{}()\s])(it|test)\s*\(\s*['"`]/gm
const countTitles = (file) =>
  (stripSource(readFileSync(file, 'utf8'), file).match(TITLE_RE) ?? []).length


/**
 * ★★★ ⑥ 同一份用例文件里，编号不许重复（2026-09-15 · C 让给我做）。
 *
 * ══ 它拦什么 ═══════════════════════════════════════════════
 * 两个人各写一条闸、各给了同一个编号，**合并之后两条都在、两边都绿**，
 * 而任何人说「GD-11 红了」时，说的是哪一条没人知道。
 * 今天真出了：我的「引导句不许用「」」和 C 的「点遮罩不关也不穿透」都叫 `GD-11`，
 * 合并后 `guide.test.ts` 里并排躺着两条，**四门全绿**。
 * ☞ 和「I-187 的修复与盯着它的那条用例死在同一次合并里」是同族：
 *   **两个人分头改同一份文件，撞出来的东西没有任何闸在看。**
 *
 * ══ 为什么只管「同一份文件内」═══════════════════════════════
 * 跨文件重名是**正常的**：`N-1` 在 `ui-copy` 里是「屏上不许出现旧名」，
 * 在别处是另一族的第一条 —— 编号本来就是按族给的，族和文件对齐。
 * 量过：全仓 311 条带编号的用例里，跨文件重名一大把，**同文件内只有这一处**。
 * 一上来就把跨文件也拦上，等于逼所有人改一遍编号，而那改不出任何安全性。
 */
function dupIdsIn(file) {
  const src = stripSource(readFileSync(file, 'utf8'), file)
  const seen = new Map()
  for (const m of src.matchAll(/\bit\(\s*['"`]([^'"`]*)['"`]/g)) {
    const id = (m[1].match(/([A-Z]{1,4}-[0-9]+[a-z]?)/) ?? [])[1]
    if (!id) continue
    seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, n]) => n > 1)
}

/** 覆盖面：见头注。收 tests/*.test.ts 与 tools/check-*.mjs */
function walk() {
  const out = []
  for (const f of readdirSync(join(ROOT, 'tests')).sort()) {
    if (f.endsWith('.test.ts')) out.push({ rel: 'tests/' + f, kind: 'test' })
  }
  for (const f of readdirSync(join(ROOT, 'tools')).sort()) {
    if (f.startsWith('check-') && f.endsWith('.mjs')) out.push({ rel: 'tools/' + f, kind: 'tool' })
  }
  return out
}

const raw = JSON.parse(readFileSync(LIST, 'utf8'))
const gates = raw.gates
const byPath = new Map(gates.map((g) => [g.path, g]))
const problems = []

// ① path 真的存在（`tools/check-*` 那几条的 path 就是文件；svelte-check 那条是 package.json）
for (const g of gates) {
  const p = g.path.split('::')[0]
  if (!existsSync(join(ROOT, p))) problems.push(`★ 「${g.name}」指着不存在的 ${p}`)
  if (!g.guards || !String(g.guards).trim()) problems.push(`★ 「${g.name}」的 guards 是空的 —— 必须手写一句它现在盯什么`)
}

// ② 磁盘上每道闸都在清单里
const disk = walk()
const missing = disk.filter((d) => !byPath.has(d.rel))
if (missing.length && FIX) {
  for (const d of missing) {
    gates.push({
      name: d.rel.replace(/^tests\/|^tools\//, '').replace(/\.test\.ts$|\.mjs$/, ''),
      path: d.rel,
      guards: '',
      titles: d.kind === 'test' ? countTitles(join(ROOT, d.rel)) : null,
      control: null
    })
  }
  // ★ 只补不盖：已有的条目一个字不动
  writeFileSync(LIST, JSON.stringify(raw, null, 2) + '\n')
  console.log(`补了 ${missing.length} 条占位 —— guards 是空的，必须人工写（①会拦着）`)
} else {
  for (const d of missing) problems.push(`★★ 没名字的闸：${d.rel} —— 新闸要先进 tests/gates.json`)
}

// ⑥ 同一份文件里编号不许重复
for (const d of disk) {
  if (d.kind !== 'test') continue
  for (const [id, n] of dupIdsIn(join(ROOT, d.rel))) {
    problems.push(
      `★★★ ${d.rel} 里有 ${n} 条用例都叫「${id}」—— ` +
        '两个人各写一条、各给了同一个编号，合并之后两条都在、两边都绿，' +
        '而「它红了」说的是哪一条没人知道。改一个号'
    )
  }
}

// ③ titles 只许升
for (const g of gates) {
  if (g.titles === null) continue
  const p = join(ROOT, g.path)
  if (!existsSync(p) || statSync(p).isDirectory()) continue
  const now = countTitles(p)
  if (now < g.titles) {
    problems.push(`★★★ 「${g.name}」少了用例：清单 ${g.titles} → 现在 ${now}（一条闸悄悄没了）`)
  } else if (now > g.titles && FIX) {
    g.titles = now
  } else if (now > g.titles) {
    problems.push(`「${g.name}」多了用例：清单 ${g.titles} → 现在 ${now}，跑 check:gates --fix 更新`)
  }
}

// ④⑤ 对照：数只许降，而且**按名字钉住**
const recorded = gates.filter((g) => g.control).map((g) => g.name).sort()
const missingCtl = gates.filter((g) => g.titles !== null && !g.control).length
const PINNED = raw.controls_recorded ?? null
const MAXMISS = raw.controls_missing_max ?? null
if (MAXMISS !== null && missingCtl > MAXMISS) {
  problems.push(`★★ 没有对照记录的闸变多了：${MAXMISS} → ${missingCtl}（这个数只许降）`)
}
if (PINNED) {
  const gone = PINNED.filter((n) => !recorded.includes(n))
  if (gone.length) problems.push(`★★★ 这些闸的对照记录没了：${gone.join('、')}（一增一减数字不动，所以按名字钉）`)
}
/**
 * ★★★ `--fix` **不许碰 `controls_missing_max`**（2026-09-15 晚 · C 实测 39 → 40）。
 *
 * 这个字段是棘轮的地板：「没有对照记录的闸最多这么多」，只许降。
 * 原来 `--fix` 无条件把它写成当前值 —— 于是**它红一次、然后自己把地板抬高，下次就绿了**。
 * 一道自己会给自己放宽的棘轮，等于没有棘轮，而且比没有更糟：它看起来还在。
 *
 * ☞ 现在：要抬只能**人手改，并在提交信息里写清为什么多了一条没对照的闸**。
 *   能降的时候也不自动降 —— 只提示一句，让人去改。**字段归人，不归生成器**
 *   （与判据⑤「会被人手填的字段，生成器只许补不许盖」同一条）。
 */
if (FIX) {
  raw.controls_recorded = recorded
  writeFileSync(LIST, JSON.stringify(raw, null, 2) + '\n')
  if (MAXMISS !== null && missingCtl > MAXMISS) {
    console.error(
      `★★★ --fix 拒绝把 controls_missing_max 从 ${MAXMISS} 抬到 ${missingCtl} —— ` +
        '那是把棘轮的地板往上挪。要抬就人手改 tests/gates.json，并写清为什么多了一条没有对照记录的闸'
    )
  } else if (MAXMISS !== null && missingCtl < MAXMISS) {
    console.log(
      `（可以收紧：没有对照记录的闸只剩 ${missingCtl} 条，而地板还写着 ${MAXMISS} —— ` +
        '人手改小它，`--fix` 不替你动这个字段）'
    )
  }
}

if (problems.length) {
  for (const p of problems) console.error(p)
  process.exit(1)
}
console.log(
  `✓ 尺子自检 ${STRIP_OK} 句 · 具名闸 ${gates.length} 条 · 用例标题 ${gates.reduce((a, g) => a + (g.titles ?? 0), 0)} 条 · ` +
    `有对照记录 ${recorded.length} 条 · 还没有的 ${missingCtl} 条`
)
