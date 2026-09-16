/**
 * 令牌闸 · DS §十五 账③（2026-09-01）
 *
 * 两件事：
 *   ① `res/values/nyx_tokens.xml` 与 `tokens.css` 对不对得上（跑生成器比对）
 *   ② 原生层**不许再出现颜色字面量** —— 这一条才是根本
 *
 * ★ 为什么第②条必须有：光生成一份资源挡不住下一个人顺手
 *   `Color.parseColor("#5B44D6")`。这个文件里已经出现过一次
 *   「手抄件对齐了、但两处带 alpha 前缀的漏网」——
 *   靠人记得的规矩，早晚有一次记不得。
 *
 * 用法：node tools/check-tokens.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JAVA = join(ROOT, 'android/app/src/main/java/com/nyx/android')

let bad = 0

// ① 生成物是不是最新的
try {
  execFileSync('node', [join(ROOT, 'tools/tokens-to-android.mjs'), '--check'], { stdio: 'inherit' })
} catch {
  bad++
}

// ② 原生层里的颜色字面量
const HEX = /"#[0-9A-Fa-f]{6,8}"/g
for (const f of readdirSync(JAVA).filter((n) => n.endsWith('.java'))) {
  const src = readFileSync(join(JAVA, f), 'utf8')
  const hits = []
  src.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) return // 注释里提一嘴可以
    for (const m of line.match(HEX) ?? []) hits.push(`${f}:${i + 1}  ${m}`)
  })
  if (hits.length > 0) {
    bad++
    console.error(`\n✗ ${f} 里有颜色字面量（${hits.length} 处）：`)
    for (const h of hits.slice(0, 12)) console.error('    ' + h)
  }
}

if (bad > 0) {
  console.error(`
  ── 怎么办 ────────────────────────────────────────────────
  颜色的真相只有一份：src/ui/styles/tokens.css（D-326：改值先改 DS）。
  原生层从 R.color.nyx_* 读，取色走 NyxAssistService.tok(ctx, R.color.…)。
  少一个色就去 tools/tokens-to-android.mjs 的清单里加。
`)
  process.exit(1)
}
console.log('✓ 原生层零颜色字面量，生成物与 tokens.css 一致')
