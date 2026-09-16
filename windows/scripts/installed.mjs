/**
 * 他手上那份，是从哪个提交打的？
 *
 * 这个脚本要回答的就是 2026-08-10 那次的问题：
 * 我说「拖拽修好了」，他说「拖拽的不行」—— 两句话都是对的，
 * 因为**他装的是 03:58 的包，修复是 04:17 写的**。
 *
 * 规矩（写进 CLAUDE.md 第九节）：
 *   **在告诉他「某个功能修好了 / 做好了」之前，先跑这一条。**
 *   它说「落后」，那句话就还不能说 —— 先打包、装上，再说。
 *
 * 用法：node scripts/installed.mjs [目标目录]   默认 D:\Nyx
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = resolve(process.argv[2] ?? 'D:\\Nyx')

/**
 * ★★ 先比**产物**，再比纸条（T-9.9 · 2026-09-06）
 *
 * ── 为什么加这一档 ────────────────────────────────────────
 *
 * 2026-09-06 这个脚本报过一次「✔ 一致」，而那是**一次什么都没验到的绿**：
 * 装机中途另一条线在同一个检出跑了 `npm run gate`（里面有 build），
 * `src/main/build-info.json` 被盖成了另一个提交；`install.mjs` 拷的是早先打的包，
 * 写进 `BUILD.txt` 的却是那份新纸条。于是这里比「BUILD.txt 的提交」与「仓库 HEAD」——
 * **两边都来自同一次构建，当然一致**。装的是 A、纸条说是 B，而它说没事。
 *
 * 判据因此换成：**他装的那个 `app.asar`，和你现在打好的那个，是不是同一个文件。**
 * 纸条会撒谎（它是事后抄的），文件不会。
 *
 * ★ 用**字节数 + sha256** 比内容，不用 mtime：`cpSync` 默认不保证保留时间戳
 *   （那天看到两边 mtime 相同是 Windows 拷贝语义顺带给的，不能当判据）。
 *   18 MB 哈希一次几十毫秒，值这个钱。
 * ★ 本地没有打包产物时**不判红也不装作没事**：明说「这一档没比」，
 *   剩下的纸条比对照常做。
 */
const fileFacts = (p) => {
  if (!existsSync(p)) return null
  const st = statSync(p)
  return {
    size: st.size,
    mtime: st.mtime.toLocaleString('sv'),
    sha: createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
  }
}
const ASAR = join('resources', 'app.asar')
const packed = fileFacts(join(root, 'release', 'win-unpacked', ASAR))
const running = fileFacts(join(dest, ASAR))

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const head = git('rev-parse', '--short', 'HEAD')
const headSubject = git('log', '-1', '--format=%s')

/**
 * 判据只有一条：**他运行的东西变了没有。**
 *
 * 所以「未提交的改动」也要按同一把尺子量 —— 只看 `src/` 和 `prompts/`。
 * 改 `scripts/`、`docs/`、`tests/` 不会让他手上那份行为不同。
 *
 * 两次误报都栽在这里：
 *   · 第一版任何改动都算 —— 而 `build-info.json` 每次构建都被重写，打完包当场红
 *   · 第二版只排除了 build-info —— 改一下安装脚本又红了，
 *     而且列出来的文件是**空的**（判红的是 dirty，列的是 touched，两个判据没对齐）
 *
 * 报警器天天响，人就不看了，真的那次也一起被忽略 ——
 * 这道闸本来就是防这种事的，自己先误报是最糟的。
 */
const RUNTIME = ['src/', 'prompts/']
/** build-info.json 就在 src/ 底下，但它是构建自己盖的戳，不是行为 */
const isRuntime = (f) => f !== 'src/main/build-info.json' && RUNTIME.some((p) => f.startsWith(p))

const dirtyFiles = git('status', '--porcelain')
  .split('\n')
  .map((x) => x.trim())
  // porcelain 前两位是状态码，后面才是路径；改名是 `R  old -> new`
  .map((x) => x.replace(/^\S+\s+/, '').split(' -> ').pop() ?? '')
  .filter(Boolean)
  .filter(isRuntime)
const dirty = dirtyFiles.length > 0

const stamp = join(dest, 'BUILD.txt')
if (!existsSync(stamp)) {
  console.log(`装在 ${dest} 的那份没有 BUILD.txt —— 说明它是加这个机制之前装的。`)
  const exe = join(dest, 'Nyx.exe')
  if (existsSync(exe)) {
    console.log(`  Nyx.exe 的时间：${statSync(exe).mtime.toLocaleString('sv')}`)
  }
  console.log(`  仓库 HEAD：${head} ${headSubject}`)
  console.log('\n结论：无法确认他手上是哪一份。要跟他说「修好了」之前，先重新装一次。')
  process.exit(2)
}

const info = JSON.parse(readFileSync(stamp, 'utf8'))

/**
 * 落后的那几个提交里，**有没有动到软件本身**。
 *
 * 一开始写的是「只要落后一个提交就红」。那样任何一次改脚本、改文档都会让它红 ——
 * 报警器天天响，人就不看了，真的那次也一起被忽略。
 *
 * 所以判据收窄成「他运行的东西变了没有」：`src/` 和 `prompts/`。
 * 改 `scripts/`、`docs/`、`tests/` 不会让他手上那份行为不同，据实说明即可。
 */
const missing = git('log', '--format=%h %s', `${info.commit}..HEAD`).split('\n').filter(Boolean)
/**
 * 他手上那份和现在的差别，**落到具体文件**。
 *
 * 已提交的差异 + 还没提交的改动，两者用同一把尺子（`isRuntime`）量。
 * 第二版栽在这里：判红看的是 `dirty`、列出来的是 `touched`，
 * 两个判据没对齐 —— 于是出现「说软件变过了，底下的文件清单是空的」。
 * **报出来的理由要和判定用的是同一件事**，否则这条报警没法核对。
 */
const touched = [
  ...git('diff', '--name-only', `${info.commit}..HEAD`).split('\n').filter(isRuntime),
  ...dirtyFiles
]

console.log(`装在 ${dest} 的那份`)
console.log(`  提交　${info.commit}${info.dirty ? '（打包时有未提交改动）' : ''}　${info.subject ?? ''}`)
console.log(`  构建　${String(info.builtAt).slice(0, 19).replace('T', ' ')}`)
console.log(`仓库 HEAD`)
console.log(`  提交　${head}${dirty ? '（现在有未提交改动）' : ''}　${headSubject}`)

if (missing.length > 0) {
  console.log(`\n他没有的提交（${missing.length} 个）：`)
  for (const m of missing) console.log('  ' + m)
}

// ── ★★ 产物这一档：他装的 app.asar 和你打好的那个是不是同一个文件 ──────
if (packed === null) {
  console.log(`\n· 产物没比：本地还没有打包产物（release/win-unpacked/${ASAR}）。`)
  console.log('  这一档是 2026-09-06 那次假绿加的 —— 想真的确认他手上是哪一份，先 npm run package。')
} else if (running === null) {
  console.log(`\n✖ 装在 ${dest} 的那份里找不到 ${ASAR} —— 那不是一个装好的 Nyx。`)
  process.exit(1)
} else {
  console.log(`\n产物比对（判据是这一档，纸条只作辅助）`)
  console.log(`  他装的　${running.size} 字节 · sha ${running.sha} · ${running.mtime}`)
  console.log(`  你打的　${packed.size} 字节 · sha ${packed.sha} · ${packed.mtime}`)
  if (running.sha !== packed.sha || running.size !== packed.size) {
    console.log(
      `\n✖ **他装的那份和你现在打好的包不是同一个文件。**\n` +
        `  纸条上写什么都不作数 —— 它是安装时从 build-info.json 抄的，抄的那一刻可能已经被别人的构建盖掉了\n` +
        `  （2026-09-06 就是这么出的事：装的是 A、纸条说是 B，而这里当时报「一致」）。\n\n` +
        `  要么他还没装这一版（去装），要么你打包之后又改过代码（重新打包再装）。`
    )
    process.exit(1)
  }
  console.log('  ✔ 同一个文件 —— 他跑的确实是你打的这一份。')
}

if (touched.length === 0) {
  if (missing.length > 0) {
    console.log(`\n✔ 一致（这 ${missing.length} 个提交没动 src/ 或 prompts/，他手上的行为不受影响）。`)
  } else {
    console.log('\n✔ 一致。他手上跑的就是现在这份代码。')
  }
  process.exit(0)
}

console.log(
  `\n✖ 软件本身变过了${dirty ? '，而且现在还有没提交的改动' : ''}：` +
    `\n  ${touched.slice(0, 8).join('\n  ')}${touched.length > 8 ? `\n  …共 ${touched.length} 个文件` : ''}` +
    `\n\n  在他装上之前，**不要说「这个功能好了」** —— 他试的是旧的那份。`
)
process.exit(1)
