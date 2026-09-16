/**
 * 把 Windows 端**屏上所有的字**导出成一份清单 · X-1（派单 `文案审计-两端-2026-09-15.md`）
 *
 * ══ 它不是闸 ══════════════════════════════════════════════════
 * 闸的取舍是「宁可漏报」—— 一个会误报的闸，第一次误报之后就会被下一个人加进白名单，
 * 然后失效（`check-copy.mjs` 头注里记着这条）。
 * 这份清单的取舍**正好相反：宁可多抓** —— 它是给人读的，多出来的行看一眼就划掉，
 * 而漏掉的那一行没有任何人会发现。
 * ☞ 所以这里**不复用** `check-copy.mjs` 的 `visibleOnly()`，两者要的东西不一样。
 *
 * ══ 但覆盖面不许比闸小（派单 X-1 的验收）══════════════════════
 * 跑完会真的去跑一次 `check:copy`，把它自报的份数拿来比：**比它少就退 1**。
 * —— 「我以为我扫得比它全」是这一轮反复栽的那种假设，所以让脚本自己去问。
 *
 * ══ 注释一律挖掉 ══════════════════════════════════════════════
 * 走仓里那份共用的 `lib/strip-comments.mjs`（它 2026-09-15 刚补上认正则字面量 ——
 * 在那之前有 23 份文件的注释会漏进来，这份清单第一版就被灌了一堆 JSDoc）。
 *
 * 用法：node scripts/copy-inventory.mjs [出口.tsv]
 *   默认写到 docs/ui/文案清单-Windows-2026-09-15.tsv
 * ★ 故意不进 `package.json` —— 它不是闸，不该出现在 `check` / `verify` 里，
 *   也就不该占 `check:gates` 那张具名闸清单的一行。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { stripSource } from './lib/strip-comments.mjs'

const NL = String.fromCharCode(10)
const CJK = /[一-龥]/
/** 和 `check-copy.mjs` 同一套根与跳过名单（那边改了，这边的自检会当场把差额喊出来） */
const ROOTS = ['src/renderer/src', 'src/main', 'src/core', 'src/shared']
const SKIP = ['src/main/db/migrations/', 'src/main/db/schema-dump.ts']

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const rel = dir + '/' + e
    if (SKIP.some((s) => rel.startsWith(s))) continue
    if (statSync(rel).isDirectory()) walk(rel, out)
    else if (/\.(svelte|ts)$/.test(e) && !/\.test\.ts$/.test(e)) out.push(rel)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(r))
const rows = []
const seen = new Set()
/** 插值挖成 ‹› —— 留个记号，让读的人看得出这句话里有一段是算出来的 */
const MARK = '‹›'

const push = (file, line, kind, text) => {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || !CJK.test(t)) return
  if (t.length > 300) return
  const key = file + '|' + t
  if (seen.has(key)) return
  seen.add(key)
  rows.push({ file, line, kind, len: t.split(MARK).join('').length, text: t })
}

for (const f of files) {
  const raw = readFileSync(f, 'utf8')
  const src = stripSource(raw, f, true)
  const rawLines = raw.split(NL)
  const lineOf = (i) => src.slice(0, i).split(NL).length
  /** 发给模型的那些行不是屏上的字（同 `check:copy` 的 `// copy:prompt`） */
  const isPrompt = (i) => (rawLines[lineOf(i) - 1] ?? '').includes('// copy:prompt')

  if (f.endsWith('.svelte')) {
    const body = src.indexOf('</' + 'script>')
    for (let i = body < 0 ? 0 : body; i < src.length; i++) {
      if (src[i] !== '>') continue
      let j = i + 1
      while (j < src.length && src[j] !== '<') j++
      const seg = src.slice(i + 1, j)
      if (seg.trim()) push(f, lineOf(i), '正文', seg.replace(/\{[^{}]*\}/g, MARK))
      i = j - 1
    }
    for (const attr of ['title=', 'aria-label=', 'placeholder=', 'alt=']) {
      let i = 0
      while ((i = src.indexOf(attr, i)) >= 0) {
        const q = src[i + attr.length]
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, i + attr.length + 1)
          if (end > 0) push(f, lineOf(i), attr.slice(0, -1), src.slice(i + attr.length + 1, end))
        }
        i += attr.length
      }
    }
  }

  for (const q of ["'", '"', '`']) {
    let i = 0
    while ((i = src.indexOf(q, i)) >= 0) {
      let j = i + 1
      while (j < src.length && src[j] !== q) {
        if (src[j] === String.fromCharCode(92)) j++
        j++
      }
      if (j >= src.length) break
      const seg = src.slice(i + 1, j)
      if (!isPrompt(i) && seg.length < 300) {
        push(f, lineOf(i), q === '`' ? '模板串' : '字符串', seg.replace(/\$\{[^{}]*\}/g, MARK))
      }
      i = j + 1
    }
  }
}

rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
const out = process.argv[2] ?? 'docs/ui/文案清单-Windows-2026-09-15.tsv'
writeFileSync(
  out,
  ['file\tline\tkind\tlen\ttext', ...rows.map((r) => [r.file, r.line, r.kind, r.len, r.text].join('\t'))].join(NL) + NL,
  'utf8'
)

/**
 * ★★★ 行号自检 —— 抽样回源码核一遍（2026-09-15 · 这一条是踩出来的）
 *
 * 第一版整张表的行号**全是歪的**：剥注释时注释里的换行被一起吃掉，
 * 「剥完的第 N 行」早就不是「文件的第 N 行」了。而清单自己看不出有问题 ——
 * 是拿几行去 `sed -n` 抽查源码才发现指到了别处。
 * ☞ 所以现在每跑一次都抽 60 行回原文核：那一行（或紧挨的两行内）得真有这段字。
 * ★ 允许 ±2 行：多行模板串的起始行与字面所在行可以差一两行，那不算错。
 */
const sample = rows.filter((r) => r.text.length >= 6 && !r.text.includes(MARK))
const step = Math.max(1, Math.floor(sample.length / 60))
let bad = 0
for (let k = 0; k < sample.length; k += step) {
  const r = sample[k]
  const lines = readFileSync(r.file, 'utf8').split(NL)
  /**
   * ★ 两边用**同一种规整**再比（2026-09-15 补）。
   *   第一版这里 `join('')`、而清单里的文本早已把连续空白压成一个空格 ——
   *   于是**跨行的那些句子**（模板串、长文案）永远对不上，
   *   自检报出 3 行「指到了别处」，而那三行其实是对的。
   *   ☞ 自检本身误报，和它要防的事一样坏：下一个人会去关掉它。
   * ★ 窗口往后开到 +8 行：跨行的句子起点在前、字在后。
   */
  const near = lines.slice(Math.max(0, r.line - 3), r.line + 8).join(' ').replace(/\s+/g, ' ')
  const head = r.text.slice(0, 8)
  if (!near.includes(head)) {
    bad++
    if (bad <= 3) console.error('  行号对不上：' + r.file + ':' + r.line + '  ' + r.text.slice(0, 40))
  }
}
if (bad > 0) {
  console.error('✖ 抽查 ' + Math.ceil(sample.length / step) + ' 行，' + bad + ' 行的「文件 : 行」指到了别处 —— 这份清单不能用来定位')
  process.exit(1)
}

/** ★ 覆盖面自检：真去跑一次闸，拿它自报的份数比 */
let gateFiles = 0
try {
  const said = execFileSync(process.execPath, ['scripts/check-copy.mjs'], { encoding: 'utf8' })
  gateFiles = Number((said.match(/扫了 (\d+) 份/) ?? [])[1] ?? 0)
} catch (err) {
  const said = String(err.stdout ?? '')
  gateFiles = Number((said.match(/扫了 (\d+) 份/) ?? [])[1] ?? 0)
}
console.log(
  '文案清单　' + rows.length + ' 句 · 扫了 ' + files.length + ' 份' +
    '（check:copy 扫 ' + gateFiles + ' 份）· 写到 ' + out
)
if (gateFiles > 0 && files.length < gateFiles) {
  console.error(
    '✖ 覆盖面比闸小 —— 清单会漏掉闸看得见的屏上文案。' +
      '八成是 check-copy.mjs 的扫描范围改了而这里没跟（ROOTS / SKIP）'
  )
  process.exit(1)
}
