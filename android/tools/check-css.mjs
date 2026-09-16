/**
 * CSS 注释闸 —— **一类 svelte-check 永远抓不到的 bug**（2026-09-01）
 *
 * ── 它抓的是什么 ────────────────────────────────────────────
 *
 * Windows 那边的 `enhancements.css` 里有过这么一行注释：
 *
 *     全部用总原型已有的令牌（--fs-<星><斜杠>--accent/--serif/--pad-work），
 *
 * 那两个字符正好是注释结束符。注释在那里就断了，后半句变成裸文本，
 * 被解析器当成选择器的一部分吞掉 —— **紧跟其后的整条规则从来没有生效过**。
 * 不报错、不警告、检查全绿，只是那一页的版式一直是浏览器默认值。
 *
 * 这一端的 CSS 注释写得同样密（而且同样爱在注释里写令牌名），
 * 所以这道闸两端都要有。
 *
 * ── 为什么不能「数符号个数」★★ ──────────────────────────────
 *
 * 第一版是数开始符与结束符的个数是否相等。**不够。**
 * 写修复说明的时候在注释里引用了这两个符号，个数照样相等，
 * 但 **CSS 注释不嵌套** —— 里面那个结束符照样把注释提前关掉。
 * 一个「平衡但断掉」的注释，数个数看不出来。
 *
 * 所以这里按 CSS 的真实规则走状态机：不在注释里看到结束符 = 错。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const OPEN = '/' + '*'
const CLOSE = '*' + '/'
const ROOTS = ['src/ui/styles']

function cssFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) cssFiles(p, out)
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

let bad = 0
let n = 0
for (const root of ROOTS) {
  for (const f of cssFiles(root)) {
    n++
    const lines = readFileSync(f, 'utf8').split('\n')
    let inC = false
    let openedAt = 0
    const problems = []
    lines.forEach((l, i) => {
      let j = 0
      while (j < l.length) {
        if (!inC && l.startsWith(OPEN, j)) { inC = true; openedAt = i + 1; j += 2; continue }
        if (inC && l.startsWith(CLOSE, j)) { inC = false; j += 2; continue }
        if (inC && l.startsWith(OPEN, j)) {
          problems.push(`第 ${i + 1} 行：注释（第 ${openedAt} 行开的）里又出现开始符 —— CSS 注释不嵌套`)
          j += 2; continue
        }
        if (!inC && l.startsWith(CLOSE, j)) {
          problems.push(`第 ${i + 1} 行：**不在注释里却出现结束符** → 前面某条注释提前关了，紧跟其后的规则会被吃掉\n     ${l.trim().slice(0, 90)}`)
          j += 2; continue
        }
        j++
      }
    })
    if (inC) problems.push(`文件结束时第 ${openedAt} 行那条注释还没关`)
    if (problems.length) { console.error(`✗ ${f}`); for (const p of problems) console.error('   ' + p); bad++ }
  }
}
if (bad) {
  console.error('\n★ 注释断在半路 = 后面的规则被静默吃掉。先修注释。')
  process.exit(1)
}
console.log(`✓ ${n} 份 CSS 的注释按 CSS 规则扫过，没有提前关掉的`)
