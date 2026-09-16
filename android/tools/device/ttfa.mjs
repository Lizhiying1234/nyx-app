#!/usr/bin/env node
/**
 * ══ T-6.5 · 把 probe.txt 算成那张 TTFA 表 ═══════════════════════
 *
 * 用法（**不装包、不连手机也能跑** —— 它只读一个文本文件）：
 *
 *   1) 把探针打开 —— **`assist.probe` 没有界面开关，直接写库**（2026-09-06 更正：
 *      这里原来写着「Settings → Assist 那颗星旁边的探针开关」，**那个开关不存在**；
 *      C 在真机批上就是直接写库开的）：
 *
 *        node tools/device/eval.mjs "<ws://…>" \
 *          "nyxDb && 0" ;# 先确认拿得到页面，再用下面这句写库
 *        # 在 App 的 WebView 里执行：
 *        #   await store.db.db.run("insert into settings(key,value,updated_at) \
 *        #     values('assist.probe','1',?) on conflict(key) do update set value='1'", [Date.now()])
 *
 *      写完**拨一下星**（进一次取词模式）让服务重读 —— `readConfig()` 每次进模式都读，
 *      所以不必重装（见 `NyxAssistService.probe()` 头注）。
 *   1b) ★ 量之前**先把旧的清掉**：`adb shell "run-as com.nyx.android rm files/probe.txt"`
 *       —— 探针文件有 64 KB 上限，满了会**整个删掉重来**，上一轮的行会把这一轮挤掉。
 *   2) 按四组各点三次喇叭（A 普通 Nyx → 系统音；B Assist → 词典音；
 *      C Assist → 系统音；D Assist → 云端 / 缓存音）
 *   3) 取回来并算表：
 *
 *        adb shell "run-as com.nyx.android cat files/probe.txt" > probe.txt
 *        node tools/device/ttfa.mjs probe.txt
 *
 *      （`run-as` 只对 debug 包有效 —— 而 `ship.sh` / `live.sh` 装的正是 debug 包）
 *
 * ══ 它怎么分组 ═══════════════════════════════════════════════
 *
 * 每一次发音以 `pronounce <词>` 开头，到下一条 `pronounce` 之前的所有行算一趟。
 * 一趟里认这些（都是 T-6.5 加的，格式见 `NyxAssistService` / `AssistEngine`）：
 *
 *   engine call … ready=… queued=…     引擎当时预热了没 / 有没有被冻着（怀疑点 ⑤）
 *   engine done  … <ms>                引擎往返（JS + 端口）
 *   tts trip <ms> tried=… dict=…       每一步各用了多久（core 的 StepRecord）
 *                                      + 词典扫了几本 / 几本现开（怀疑点 ①②）
 *   bridge b64=… decode+write=<ms>     base64 过桥 + 写临时文件（怀疑点 ④）
 *   audio start prepare=<ms> TTFA=<ms> 字节那条路真的出声（MediaPlayer）
 *   systts new/init/speak … TTFA=<ms>  系统音那条路（怀疑点 ③；冷 / 热分得开）
 *
 * ★ 表里**看不到** `dict prewarm …`（T-6.6 第二段那行）—— 它不属于任何一趟发音，
 *   就排在第一次 `lookup` 答完之后。要看它直接翻 `probe.txt`：
 *   它应当出现在第一条 `engine done` 之后、第一条 `pronounce` 之前。
 *
 * ★ **只读不改**：这个脚本不 adb、不写手机、不碰库。
 * ★ 分组（A/B/C/D）**它猜不出来**，也不去猜 —— 按 `source=` 与是否有 `systts`
 *   如实标一列「走了哪条」，四组怎么对应由跑的人在报告里写。不许脚本替他判。
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('用法：node tools/device/ttfa.mjs <probe.txt>')
  console.error('先取：adb shell "run-as com.nyx.android cat files/probe.txt" > probe.txt')
  process.exit(2)
}

/** 一行 = `<毫秒> <消息>`（`Probe.write` 的格式，一份） */
const lines = readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const m = /^(\d+)\s+(.*)$/.exec(l)
    return m ? { at: Number(m[1]), msg: m[2] } : null
  })
  .filter((x) => x !== null)

if (lines.length === 0) {
  console.error(`${path} 里一行探针都没有 —— settings 里的 assist.probe 写成 '1' 了吗？（没有界面开关，见头注）`)
  process.exit(1)
}

const num = (re, s) => {
  const m = re.exec(s)
  return m ? Number(m[1]) : null
}

/** 切成一趟一趟 —— 以 `pronounce ` 为界 */
const runs = []
for (const l of lines) {
  if (l.msg.startsWith('pronounce ')) runs.push({ word: l.msg.slice(10), at: l.at, lines: [] })
  else if (runs.length > 0) runs.at(-1).lines.push(l)
}

const rows = runs.map((r, i) => {
  const find = (p) => r.lines.find((l) => l.msg.startsWith(p))?.msg ?? ''
  const call = find('engine call')
  const done = find('engine done')
  const trip = find('tts trip')
  const bridge = find('bridge ')
  const audio = find('audio start')
  const sysNew = find('systts new')
  const sysInit = find('systts init')
  const sysSpeak = find('systts speak')

  // 走了哪条：字节（词典/缓存/云端）还是系统音 —— 只如实读 source=，不猜
  const source = /source=(\S+)/.exec(trip)?.[1] ?? (sysSpeak ? 'system' : '?')
  const ttfa = num(/TTFA=(\d+)ms/, audio) ?? num(/TTFA=(\d+)ms/, sysSpeak)

  return {
    '#': i + 1,
    词: r.word,
    走的哪条: source,
    'TTFA(ms)': ttfa ?? '—',
    '引擎往返(ms)': num(/ (\d+)ms$/, done) ?? '—',
    '整趟到出声前(ms)': num(/tts trip (\d+)ms/, trip) ?? '—',
    预热了吗: /ready=true/.test(call) ? '是' : /ready=false/.test(call) ? '否(排队)' : '—',
    排队: num(/queued=(\d+)/, call) ?? '—',
    '每步 ms': /tried=(\[.*?\])/.exec(trip)?.[1] ?? '—',
    '词典账': /dict=(\{.*?\})/.exec(trip)?.[1] ?? '—',
    'b64 过桥(ms)': num(/decode\+write=(\d+)ms/, bridge) ?? '—',
    'prepare(ms)': num(/prepare=(\d+)ms/, audio) ?? '—',
    '系统TTS冷启(ms)': sysNew ? (num(/took=(\d+)ms/, sysInit) ?? '?') : '—'
  }
})

console.log(`# TTFA · 共 ${rows.length} 趟（来源：${path}）\n`)
console.table(rows)
console.log(`
读法（T-6.5 的五个怀疑点，一列一条）：
  ①「词典账」里的 books = 出声前扫了几本书。A 组（普通 Nyx）根本不该有这一列。
  ②「词典账」里的 opened = 其中几本是**现开的**（装好的书只驻 MDX_CACHE_MAX 本，
     那个常量在 src/db/dict.ts —— 别在这里抄第二份数）。
     启用 ≥3 本时若每趟 opened 都 >0 —— ② 证实。
  ③「系统TTS冷启」只有第一趟有数、后面是「—」= 只在首次建，③ 证实。
  ④「b64 过桥」+「prepare」两列相加占 TTFA 的比重就是 ④ 的答案。
  ⑤「预热了吗」= 否(排队) → 那一趟在等引擎活过来，⑤ 证实。

★ 系统音那条的 TTFA 记的是 speak() 交出去的时刻，**不含系统合成到出声的那一段** ——
  C 组的数要按「≥ 这个数」读，真机上再对一次秒表。这条写在这里免得把表读窄了。`)
