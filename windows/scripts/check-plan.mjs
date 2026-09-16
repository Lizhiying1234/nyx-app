/**
 * check:plan · NYX_MASTER_PLAN.md 的健康闸（2026-09-04 · Phase 1C）
 *
 * 它不判断内容对不对 —— 内容本来就该常改；它只守住计划文件**不再退化**的几条形式规矩：
 *
 *   · 该有的节都在（被脚本切掉一截也能当场发现 —— 2026-09-01 真出过这种事）
 *   · 每条任务只用九个状态词之一
 *   · DONE 必须有证据；NEXT 必须有前置与完成标准；BLOCKED 要写被谁挡住；
 *     DECISION REQUIRED 要指向一条存在的 D-R 裁决；IMPLEMENTED / AWAITING VERIFICATION
 *     要写已实现与还差的验证；FROZEN 要写解冻条件；SUPERSEDED / CANCELLED 要写依据
 *   · 任务编号唯一；前置 / 被谁挡住里引用的 T-x.y 与 D-Rn 都存在
 *   · 至少有一条 NEXT；NEXT ACTION 一节点名的任务真的是 NEXT
 *   · 不许再出现 `- [ ]` 这种旧式待办（已完成的活不能继续当 TODO）
 *
 * ★ 有意不做的：不校验措辞、不数任务、不比对源码。那是人读的时候的事。
 */
import { readFileSync } from 'node:fs'

const FILE = 'NYX_MASTER_PLAN.md'
const NL = String.fromCharCode(10)
const s = readFileSync(FILE, 'utf8').split(String.fromCharCode(13)).join('')
const fail = []

const SECTIONS = [
  '## CURRENT STATE',
  '## CURRENT PHASE',
  '## NEXT ACTION',
  '## ARCHITECTURE LOCKED',
  '## EXECUTION PLAN',
  '## DEPENDENCY MAP',
  '## DECISION REQUIRED',
  '## BLOCKED',
  '## FROZEN',
  '## CANCELLED / SUPERSEDED',
  '## COMPLETED HISTORY',
  '## EVIDENCE / SOURCE OF TRUTH',
  '## PLAN HEALTH RULES'
]
for (const h of SECTIONS) if (!s.includes(NL + h)) fail.push(`缺节：${h}`)

const STATUS = [
  'DONE',
  'IMPLEMENTED / AWAITING VERIFICATION',
  'IN PROGRESS',
  'NEXT',
  'BLOCKED',
  'DECISION REQUIRED',
  'FROZEN',
  'CANCELLED',
  'SUPERSEDED'
]

/** 一节的正文（到下一个 `## ` 为止） */
function section(name) {
  const i = s.indexOf(NL + name)
  if (i < 0) return ''
  const rest = s.slice(i + 1 + name.length)
  const j = rest.search(new RegExp(NL + '## '))
  return j < 0 ? rest : rest.slice(0, j)
}

// ── 任务块：`### T-x.y · 标题` 到下一个 `### ` 或 `## ` ──
const blocks = s.split(new RegExp(NL + '(?=### T-)')).slice(1)
const tasks = blocks.map((raw) => {
  const block = raw.split(new RegExp(NL + '(?=## )'))[0]
  const id = block.match(/^### (T-\d+\.\d+)/)?.[1] ?? '?'
  const st = block.match(/\*\*状态\*\*：([^\n]+)/)?.[1]?.trim() ?? ''
  return { id, st, block }
})
const ids = tasks.map((t) => t.id)
for (const id of ids) if (ids.filter((x) => x === id).length > 1) fail.push(`任务编号重复：${id}`)

const has = (t, key) => new RegExp(`\\*\\*${key}\\*\\*：\\S`).test(t.block) || new RegExp(`\\*\\*${key}\\*\\*：${NL}- \\S`).test(t.block)
const need = (t, key) => {
  if (!has(t, key)) fail.push(`${t.id}（${t.st || '无状态'}）缺「${key}」`)
}

const decisionIds = new Set([...section('## DECISION REQUIRED').matchAll(/\| (D-R\d+) \|/g)].map((m) => m[1]))

for (const t of tasks) {
  if (!STATUS.includes(t.st)) {
    fail.push(`${t.id}：状态词不合法「${t.st}」`)
    continue
  }
  switch (t.st) {
    case 'DONE':
      need(t, '证据')
      break
    case 'NEXT':
      need(t, '前置')
      need(t, '完成标准')
      break
    case 'IN PROGRESS':
      need(t, '完成标准')
      break
    case 'BLOCKED':
      need(t, '被谁挡住')
      need(t, '完成标准')
      break
    case 'DECISION REQUIRED':
      need(t, '裁决')
      break
    case 'IMPLEMENTED / AWAITING VERIFICATION':
      need(t, '已实现')
      need(t, '还差的验证')
      break
    case 'FROZEN':
      need(t, '解冻条件')
      break
    case 'SUPERSEDED':
      need(t, '被谁取代')
      break
    case 'CANCELLED':
      need(t, '取消依据')
      break
  }
  // 引用都得存在
  for (const key of ['前置', '被谁挡住', '裁决']) {
    const line = t.block.match(new RegExp(`\\*\\*${key}\\*\\*：([^\\n]+)`))?.[1] ?? ''
    for (const ref of line.match(/T-\d+\.\d+/g) ?? []) if (!ids.includes(ref)) fail.push(`${t.id}：「${key}」引用了不存在的 ${ref}`)
    for (const ref of line.match(/D-R\d+/g) ?? []) if (!decisionIds.has(ref)) fail.push(`${t.id}：「${key}」引用了不存在的 ${ref}`)
  }
}

// ── 至少一条 NEXT；NEXT ACTION 点名的任务真的是 NEXT ──
const nexts = tasks.filter((t) => t.st === 'NEXT').map((t) => t.id)
if (nexts.length === 0) fail.push('一条 NEXT 都没有 —— 计划不能没有下一步')
const named = section('## NEXT ACTION').match(/T-\d+\.\d+/g) ?? []
if (named.length === 0) fail.push('NEXT ACTION 一节没有点名任何任务')
for (const ref of named) {
  const t = tasks.find((x) => x.id === ref)
  if (!t) fail.push(`NEXT ACTION 点名了不存在的 ${ref}`)
  else if (t.st !== 'NEXT') fail.push(`NEXT ACTION 点名的 ${ref} 状态是 ${t.st}，不是 NEXT`)
}

// ── 旧式待办禁止 ──
const todo = s.split(NL).findIndex((l) => /^\s*- \[ \]/.test(l))
if (todo >= 0) fail.push(`第 ${todo + 1} 行还有旧式待办「- [ ]」—— 用九个状态词之一`)

// ── 裁决表：每条 D-R 只出现一次，且有「挡住谁」列内容 ──
const drows = [...section('## DECISION REQUIRED').matchAll(/^\| (D-R\d+) \|/gm)].map((m) => m[1])
for (const d of drows) if (drows.filter((x) => x === d).length > 1) fail.push(`裁决编号重复：${d}`)

const tally = {}
for (const t of tasks) tally[t.st] = (tally[t.st] ?? 0) + 1

if (fail.length) {
  console.error(`✗ check:plan · ${FILE} 有 ${fail.length} 处不合规矩：`)
  for (const f of fail) console.error('  · ' + f)
  process.exit(1)
}
const summary = Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')
console.log(`✓ check:plan · ${tasks.length} 条任务 · ${decisionIds.size} 条裁决 · ${summary}`)
