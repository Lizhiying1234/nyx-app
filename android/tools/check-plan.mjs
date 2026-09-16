/**
 * 计划文件结构闸 —— **2026-09-01 真出过一次事**
 *
 * 那天我用脚本改 PLAN，锚点写的是 `startsWith('- [ ] **⑧')`，
 * 而那时 ⑧ 已经被标成 `- [x]` —— 循环找不到终点，一路跑到文件尾，
 * **把 ⑧⑨⑩⑪⑫ 连同 §四 §五 §六 整段切掉了**，而且没有任何报错。
 *
 * 计划文件是这个项目唯一的「现在做什么」文件，每个新会话都从它进。
 * 它被悄悄削掉一半的后果不是「少几行」，是**下一个会话以为那些活不存在**。
 *
 * 所以这里只做一件很笨但有效的事：**该有的节必须都在**。
 * 不校验内容 —— 内容本来就该常改；校验的是「有没有被整段吃掉」。
 * ★ 状态词 / 证据 / 引用那一类的闸在 Windows 仓 `scripts/check-plan.mjs`（它守的是同一份文件）。
 *
 * ★ 2026-09-04（Phase 1A）起计划文件是 `nyx_project/NYX_MASTER_PLAN.md`（两端唯一），
 *   本仓 `docs/nyx-system/PLAN.md` 只剩一枚指针；同日 Phase 1C 把结构改成十三节。
 *   找不到 Windows 仓就跳过（物理相邻关系，只在两个都在的机器上生效）。
 * ★ 2026-09-05（第二轮集成）：Windows 仓改成**从本仓根一路往上找**（同 Windows 仓 `scripts/android-repo.mjs`）。
 *   此前写死 `..`，主检出找得到，git worktree（`.claude/worktrees/x`）里永远「跳过」而且是绿的 ——
 *   T-6.2 的会话报出来的；R-018 最怕的就是这种「绿着却什么都没验到」。设了 NYX_WINDOWS 就只认它。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const POINTER = resolve(ROOT, 'docs', 'nyx-system', 'PLAN.md')

/** 每一层都试 `<层>/claude_code_workspace/nyx_project/NYX_MASTER_PLAN.md`；近的优先 */
function findPlan() {
  if (process.env.NYX_WINDOWS) {
    return { plan: resolve(process.env.NYX_WINDOWS, 'NYX_MASTER_PLAN.md'), where: `NYX_WINDOWS=${resolve(process.env.NYX_WINDOWS)}` }
  }
  let cur = ROOT
  let tried = 0
  for (;;) {
    tried++
    const p = resolve(cur, 'claude_code_workspace', 'nyx_project', 'NYX_MASTER_PLAN.md')
    if (existsSync(p)) return { plan: p, where: p }
    const up = dirname(cur)
    if (up === cur) return { plan: null, where: `本仓根往上 ${tried} 层都没有 claude_code_workspace/nyx_project/NYX_MASTER_PLAN.md，也没有设 NYX_WINDOWS` }
    cur = up
  }
}
const { plan: PLAN, where: WHERE } = findPlan()
const MUST = [
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

// 本仓那枚指针必须还指着正确的地方 —— 指针丢了，下一个会话就找不到计划
const pointer = readFileSync(POINTER, 'utf8')
if (!pointer.includes('NYX_MASTER_PLAN.md')) {
  console.error(`✗ ${POINTER} 里没有指向 NYX_MASTER_PLAN.md 的指针`)
  process.exit(1)
}

if (!PLAN || !existsSync(PLAN)) {
  console.log(`跳过 · 找不到 Windows 仓的计划文件（${WHERE}）—— 本仓的检查不依赖 Windows 仓存在`)
  process.exit(0)
}

const s = readFileSync(PLAN, 'utf8')
const miss = MUST.filter((h) => !s.includes(h))
if (miss.length > 0) {
  console.error(`✗ NYX_MASTER_PLAN.md 少了这些节：${miss.join(' ')}`)
  console.error('  ★ 多半是脚本改它时锚点没对上、切过头了。先从 git 恢复，再改。')
  process.exit(1)
}
// 计划文件被削到很短，也是同一种事故
const lines = s.split('\n').length
if (lines < 150) {
  console.error(`✗ NYX_MASTER_PLAN.md 只剩 ${lines} 行 —— 太短了，八成被切掉了一截。`)
  process.exit(1)
}
console.log(`✓ NYX_MASTER_PLAN.md 结构完整（${MUST.length} 节 · ${lines} 行）· PLAN.md 指针在`)
