/**
 * 把 `prompts/*.md` 的**全部历史出厂版指纹**收集成一份清单 · I-113
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 *
 * 升级时要判断「这份提示词他动过没有」。播种时记指纹是对的做法，
 * 但**老版本没记** —— 于是装完新版一跑，11 份都被判成「他改过」而不敢动，
 * 其中就有还带着 12 处 hold sway 污染的 analyse-item.md。
 * 判据太保守的代价，就是那些改进对他全部落空。
 *
 * 而正确的判据一直在手边：**git 里有每一个历史出厂版**。
 * 他那份的指纹只要出现在历史里，就说明它是某一版的原样出厂内容 ——
 * 他没动过，可以放心更新。
 *
 * 这份清单是**生成物**，跟着 prompts 一起改就重新生成：
 *
 *     node scripts/prompt-history.mjs
 *
 * 不手工维护 —— 手工维护的清单一定会漏，而漏掉的表现是「又不敢更新了」。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const sha = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const commits = git('log', '--format=%H', '--', 'prompts/').trim().split('\n').filter(Boolean)

/** { 'analyse-item.md': ['指纹1', '指纹2', …] } —— 从新到旧 */
const history = {}
let versions = 0

for (const c of commits) {
  let files
  try {
    files = git('ls-tree', '--name-only', `${c}`, 'prompts/').trim().split('\n').filter(Boolean)
  } catch {
    continue
  }
  for (const path of files) {
    if (!path.toLowerCase().endsWith('.md')) continue
    const name = path.slice(path.lastIndexOf('/') + 1)
    let text
    try {
      text = git('show', `${c}:${path}`)
    } catch {
      continue
    }
    const h = sha(text)
    history[name] ??= []
    if (!history[name].includes(h)) {
      history[name].push(h)
      versions++
    }
  }
}

const out = 'src/main/prompt-history.json'
writeFileSync(out, JSON.stringify(history, null, 2) + '\n', 'utf8')
console.log(
  `prompt-history　${Object.keys(history).length} 份提示词 · ${versions} 个历史版本 → ${out}`
)
