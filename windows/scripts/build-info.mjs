/**
 * 把「这一份是从哪个提交、什么时候构建出来的」写进产物。
 *
 * ── 为什么要有 ────────────────────────────────────────────────
 *
 * 2026-08-10：我告诉他拖拽修好了。他试了，说「拖拽的不行」。
 * 我又查了一遍，代码是对的、验收是绿的 —— 因为**他手上那份是 03:58 打的包，
 * 而修复是 04:17 写的**。我们俩谁都没法从软件本身看出这件事。
 *
 * 同一类还有别的形状：I-113 是他那份提示词没跟着升级，
 * 表现也是「我改了，对他没生效」。
 *
 * 共同点：**「我改的那份」和「他运行的那份」之间没有可见的连线。**
 * 所以在产物里刻一个号：他在设置里看得见，我用 `npm run installed` 查得到。
 *
 * 生成 `src/main/build-info.json`，跟着 `npm run build` 自动跑，不手工维护。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const commit = git('rev-parse', '--short', 'HEAD') || 'unknown'
const commitAt = git('log', '-1', '--format=%cI') || ''
const subject = git('log', '-1', '--format=%s') || ''
/**
 * 工作区有没有没提交的改动 —— 「装上的是提交 X」在脏工作区里是句假话。
 *
 * ★ **这张纸条自己不算。** `src/main/build-info.json` 每次构建都被重写，
 *   上一次装完留在工作区里，下一次构建就会因为它把自己判成「脏」——
 *   于是 BUILD.txt 永远写着「打包时有未提交改动」，而实际上代码干干净净。
 *   `scripts/installed.mjs` 早就为同一个理由把它排除在判据之外了
 *  （那边的注释里记着两次误报的经过）；两边用同一把尺子。
 */
const dirty = git('status', '--porcelain')
  .split(String.fromCharCode(10))
  .map((x) => x.trim())
  .map((x) => x.replace(/^\S+\s+/, '').split(' -> ').pop() ?? '')
  .filter(Boolean)
  .filter((f) => f !== 'src/main/build-info.json').length > 0

const info = { commit, commitAt, subject, dirty, builtAt: new Date().toISOString() }
const out = join(root, 'src', 'main', 'build-info.json')
writeFileSync(out, JSON.stringify(info, null, 2) + '\n', 'utf8')
console.log(
  `build-info　${commit}${dirty ? '+改动未提交' : ''} · ${info.builtAt.slice(0, 19).replace('T', ' ')}`
)
