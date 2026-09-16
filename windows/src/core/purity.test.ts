import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * core/ 必须保持纯净 · D-238
 *
 * 「调度算法、判分规则、状态机、静默判定、半数规则匹配 —— 全部写成不依赖界面的
 *  纯逻辑模块，两端共用同一份。**现在做代价接近于零；等做手机端时才发现逻辑和界面
 *  缠在一起，就是重写。**」
 *
 * 光靠纪律守不住：某天有人为了图方便在判分里 import 一下数据库，代码照样能跑，
 * 单元测试照样绿，**要等到几个月后开始做手机端才会发现搬不走**。所以让机器守。
 */

const CORE = dirname(fileURLToPath(import.meta.url))

/** 这些东西一旦出现在 core/ 里，就说明业务逻辑和运行环境粘上了。 */
const FORBIDDEN = [
  'electron',
  'better-sqlite3',
  'svelte',
  'node:fs',
  'node:path',
  'node:os',
  'node:child_process',
  'node:worker_threads'
]

/**
 * ★ 递归扫，不是只扫顶层。
 *
 * `core/sync/` 是 Step 6 才建的子目录 —— 只扫顶层的话，
 * **整个同步会话都不在纯度闸的守备范围里**，而它恰恰是最需要守的那一块
 * （一行 `import better-sqlite3` 就能让它搬不到 Android，而且编译得过、测试全绿）。
 * 这种「新加的东西没人守」是这个项目最典型的静默失效形状。
 */
function sourceFiles(dir = CORE): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(full))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('core/ 是纯逻辑（D-238）', () => {
  it('至少扫到了文件 —— 免得规则名存实亡', () => {
    assert.ok(sourceFiles().length >= 5, 'core/ 里的源文件太少，这条测试可能扫错了目录')
  })

  it('一行 import 都不指向 electron / 数据库 / 界面框架 / 文件系统', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        const spec = m[1]!
        if (FORBIDDEN.some((f) => spec === f || spec.startsWith(f + '/'))) {
          offenders.push(`${file.slice(CORE.length + 1)} → ${spec}`)
        }
        /**
         * ★ 判据是「**不许逃出 core**」，不是「不许出现 `..`」。
         *
         * 原来那条写的是 `spec.startsWith('..')` —— 那是为扁平的 `core/` 写的，
         * 那时 `..` 必然意味着「出了 core」。Step 6 建了 `core/sync/` 子目录之后，
         * `../sync-merge.ts` 仍然在 core 里，完全正当。
         * 按老判据会把它误判成污染，而误判多了这道闸就会被人绕过去 ——
         * 那比没有闸更糟。
         */
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec)
          if (!target.startsWith(CORE + sep) && target !== CORE) {
            offenders.push(`${file.slice(CORE.length + 1)} → ${spec}（跑到 core 外面去了）`)
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `core/ 被污染了，这几处将来搬不到手机端：\n  ${offenders.join('\n  ')}`
    )
  })

  it('没有用到只有浏览器或只有 Node 才有的全局对象', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8')
      for (const g of ['window.', 'document.', 'localStorage', 'process.env', '__dirname']) {
        if (src.includes(g)) offenders.push(`${file.slice(CORE.length + 1)} → ${g}`)
      }
    }
    assert.deepEqual(offenders, [], `core/ 里出现了环境相关的全局对象：\n  ${offenders.join('\n  ')}`)
  })
})
