// NEXT ACTION 一节里只许点名状态是 NEXT 的任务编号（check:plan 规则）。
// 这个脚本把那一节里所有非 NEXT 任务的编号换成「<标题>那条（<状态>）」，跑在每次改状态的脚本之后、plan-gate 之前。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const f = resolve(dirname(fileURLToPath(import.meta.url)), '../../NYX_MASTER_PLAN.md')
let s = readFileSync(f, 'utf8')
const status = new Map(), title = new Map()
for (const m of s.matchAll(/^### (T-\d+\.\d+) · ([^\n]*)\n\*\*状态\*\*：([^\n]+)/gm)) {
  status.set(m[1], m[3].trim()); title.set(m[1], m[2].trim())
}
const a = s.indexOf('\n## NEXT ACTION'), b = s.indexOf('\n## ARCHITECTURE LOCKED')
if (a < 0 || b < 0 || b < a) throw new Error('NEXT ACTION 节找不到')
let sec = s.slice(a, b), n = 0
sec = sec.replace(/T-\d+\.\d+/g, (id) => {
  const st = status.get(id)
  if (!st || st === 'NEXT') return id
  n++
  const short = (title.get(id) || id).split(/[（(·]/)[0].trim().slice(0, 18)
  const word = st.startsWith('DONE') ? '已 DONE' : st.startsWith('IMPLEMENTED') ? '已合回待验' : st.startsWith('DECISION') ? '等裁决' : st.startsWith('BLOCKED') ? '被挡着' : st
  return `${short}那条（${word}）`
})
s = s.slice(0, a) + sec + s.slice(b)
writeFileSync(f, s, 'utf8')
console.log(n === 0 ? 'NEXT ACTION 无需去编号' : `NEXT ACTION 去编号 ${n} 处`)
