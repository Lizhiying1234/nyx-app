/**
 * 跨仓库护栏 —— **Android 用的是本仓 core 的一个锁定版本，而本仓看不见那些引用。**
 * （F-008 · 2026-09-01；T-1.3 · 2026-09-04 改成 submodule 之后跟着改）
 *
 * ── 它挡的是哪一种事故 ────────────────────────────────────
 *
 * Nyx-Android 的 `src/core-link.ts` re-export 本仓的 core 源码（D-238/D-365：core 只有一份，
 * 不复制、不包装）。2026-09-04 起它经 git submodule `Nyx-Android/nyx-core/` 读**锁定 SHA**
 * 的那一份，不再读本仓的工作树。代价没变：
 *
 *   **本仓的任何检查都不知道那些符号有人在用。**
 *
 * 于是「这个 export 好像没人引用了，删掉吧」这个再正常不过的清理动作，
 * 会让本仓 `check` 全绿、`test` 全绿，而 Android **下一次更新指针时构建当场炸**。
 *
 * ★ 已有的 `Nyx-Android/tests/core-parity.test.ts` 挡得住「行为变了」，
 *   **挡不住「符号没了」** —— 那是编译期的事，测试还没跑就已经失败。
 * ★ `Nyx-Android/tests/core-lock.test.ts` 守的是另一件事：手机用的正文 = 锁定 commit。
 *
 * ── 判据 ──────────────────────────────────────────────────
 *
 * 读 Android 的 `core-link.ts`，把每一条 `export { … } from '…/core/x.ts'` 拆成 (符号, 目标文件)，
 * ★ 把 submodule 路径（`../nyx-core/src/core/x.ts`）映射回**本仓 HEAD 的** `src/core/x.ts`，
 *   逐个断言本仓当前的 core 真的导出了它 —— 这样指针一更新，手机就一定编译得过。
 * ★ 顺带报告：Android 锁定的 core SHA 是哪个、是不是本仓 HEAD 的祖先、core / schema 落后了几个文件。
 *   落后**不算错**（那正是锁定的意义），只是让人知道。
 *
 * ★ 找不到 Android 仓库就**跳过并打印一行**：本仓的 CI 不该依赖另一个仓库存在。
 *
 * 用法：node scripts/check-android-imports.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { WIN_ROOT as ROOT, findAndroidRepo, skipLine } from './android-repo.mjs'

/**
 * Android 仓库的位置 —— 由 `android-repo.mjs` 一处判断（T-1.4）。
 * ★ 原来写死成 `../../Nyx-Android`：主检出上对，**worktree 里永远找不到**，
 *   于是这条护栏在 worktree 里一次都没生效过，还绿着。
 */
const { dir: ANDROID } = findAndroidRepo()

if (!ANDROID) {
  console.log(skipLine('本仓的检查'))
  process.exit(0)
}

const LINK = resolve(ANDROID, 'src/core-link.ts')
const SUB = resolve(ANDROID, 'nyx-core')

if (!existsSync(LINK)) {
  console.log(`跳过 · 找到了 Android 仓库但没有 core-link.ts（找的是 ${LINK}）`)
  console.log('  —— 本仓的检查不依赖 Android 存在。两个都在的机器上这条才生效。')
  process.exit(0)
}

const git = (args, cwd = ROOT) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
/** 只看退出码的那一类 git 命令（merge-base --is-ancestor 没有输出，成功 = 0） */
const gitOk = (args, cwd = ROOT) => {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

/**
 * 花括号名单里剥注释 —— 这个项目习惯在 `export { … }` 中间写整段说明，
 * 不剥的话「// ★ 唯一一处改名 …」会被当成一个符号名（第一版就这么报了假警）。
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * 把 `A, B as C, type D` 拆开。
 *
 * ★ `side` 分得很清 —— 这是第一版报出三个假警的地方：
 *   `export { toText as mdxToText } from './mdx.ts'`
 *   **要去 mdx.ts 里找的是 `toText`（源名），不是 `mdxToText`（别名）。**
 *   反过来，问「这个文件对外露出了什么」时要的才是别名。
 */
const namesIn = (braces, side) =>
  stripComments(braces)
    .split(',')
    .map((raw) => {
      const n = raw.trim().replace(/^type\s+/, '')
      const as = n.split(/\s+as\s+/)
      return (side === 'source' ? as[0] : as[1] ?? as[0]).trim()
    })
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))

/** core-link 那一侧：我们要求目标文件提供的**源名** */
const sourceNames = (b) => namesIn(b, 'source')
/** 目标文件那一侧：它实际对外露出的**别名** */
const exposedNames = (b) => namesIn(b, 'exposed')
const linkSrc = readFileSync(LINK, 'utf8')
const LINK_DIR = dirname(LINK)

/**
 * ★ submodule 路径 → 本仓路径。core-link 写的是 `../nyx-core/src/core/x.ts`，
 *   解析出来落在 Android 仓的 submodule 里；这条检查要对的是**本仓 HEAD 的** core，
 *   所以把 `<Android>/nyx-core/` 这一段换成本仓根。不在 submodule 里的路径原样保留（那是错的写法，下面会报）。
 */
const toRepo = (p) => {
  const rel = relative(SUB, p)
  return rel && !rel.startsWith('..') && !rel.includes(':') ? resolve(ROOT, rel) : p
}

const wanted = new Map() // 绝对路径（本仓） → Set<符号>
const starOnly = new Set()
const notSubmodule = []

for (const m of linkSrc.matchAll(/export\s+(\*|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"]/g)) {
  const raw = resolve(LINK_DIR, m[3])
  const target = toRepo(raw)
  if (target === raw) notSubmodule.push(m[3])
  if (m[1] === '*') {
    starOnly.add(target)
    continue
  }
  if (!wanted.has(target)) wanted.set(target, new Set())
  for (const n of sourceNames(m[2])) wanted.get(target).add(n)
}

/** 一个文件导出了哪些名字（它自己再 re-export 出去的也跟进去） */
const cache = new Map()
function exportsOf(file, seen = new Set()) {
  if (cache.has(file)) return cache.get(file)
  if (seen.has(file)) return new Set()
  seen.add(file)
  const out = new Set()
  if (!existsSync(file)) {
    cache.set(file, out)
    return out
  }
  const src = readFileSync(file, 'utf8')

  for (const m of src.matchAll(
    /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
  )) {
    out.add(m[1])
  }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}\s*(?!from)[;\s]*$/gm)) {
    for (const n of exposedNames(m[1])) out.add(n)
  }
  for (const m of src.matchAll(/export\s+(\*|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"]/g)) {
    const next = resolve(dirname(file), m[3])
    if (m[1] === '*') for (const n of exportsOf(next, seen)) out.add(n)
    else for (const n of exposedNames(m[2])) out.add(n)
  }
  cache.set(file, out)
  return out
}

const problems = []
let checked = 0

if (notSubmodule.length > 0) {
  problems.push(
    `core-link.ts 里有不走 submodule 的 import（T-1.3 之后不许再指 Windows 工作树）：\n    ` +
      notSubmodule.join('\n    ')
  )
}

for (const target of [...starOnly, ...wanted.keys()]) {
  if (!existsSync(target)) {
    problems.push(`文件不存在：${relative(ROOT, target)}\n    Android 的 core-link.ts 指着它`)
  }
}

for (const [target, names] of wanted) {
  if (!existsSync(target)) continue
  const have = exportsOf(target)
  for (const n of names) {
    checked++
    if (!have.has(n)) {
      problems.push(
        `${relative(ROOT, target)} 没有导出 \`${n}\`\n    但 Android 的 core-link.ts 正在 re-export 它`
      )
    }
  }
}

if (problems.length > 0) {
  console.error(`\n✗ Android 直连的 core 符号对不上（${problems.length} 处）：\n`)
  for (const p of problems) console.error('  • ' + p)
  console.error(`
  ── 怎么办 ────────────────────────────────────────────────
  Android 与本仓**共享同一份 core 源码**（D-238/D-365），经 submodule 锁定 SHA。
  本仓删掉/改名一个 core 导出，Android 下一次更新指针就编译不过。

  · 那个符号确实该退休：先改 Nyx-Android/src/core-link.ts 和它的使用点，再更新指针。
  · 只是改名：两边一起改。
  · 这条检查找不到 Android 仓库时会自动跳过，不会挡住别人的 CI。
`)
  process.exit(1)
}

// ── 锁定的 SHA 是哪个、落后了多少 —— 只报告，不判红 ──
const pinned = (git(['ls-tree', 'HEAD', 'nyx-core'], ANDROID).split(/\s+/)[2] ?? '').slice(0, 7)
const head = git(['rev-parse', '--short=7', 'HEAD'])
let lag = ''
if (pinned) {
  const ancestor = gitOk(['merge-base', '--is-ancestor', pinned, 'HEAD'])
  const stat = git(['diff', '--shortstat', pinned, 'HEAD', '--', 'src/core', 'schema'])
  lag = ancestor ? (stat ? `core / schema 落后：${stat}` : 'core / schema 与本仓 HEAD 一致') : '★ 锁定的 SHA 不是本仓 HEAD 的祖先（本仓被改写过，或指针指向别的线）'
}
console.log(
  `✓ Android core-link.ts 的 ${checked} 个直连符号在本仓 HEAD 里全部还在（${wanted.size} 个 core 文件）` +
    (pinned ? `\n  · Android 锁定 core ${pinned} · 本仓 HEAD ${head} · ${lag}` : '\n  · （Android 仓里还没有 nyx-core 的指针）')
)
