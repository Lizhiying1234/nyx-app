/**
 * ★★ core 锁（T-1.3 · 2026-09-04）—— Android 用的 core 是 submodule 锁定的那一版，不是 Windows 工作树
 *
 * ── 它挡的是哪一种事故 ────────────────────────────────────
 *
 * 2026-09-04 之前，`src/core-link.ts` 用相对路径直接 import Windows 仓库的**主检出**（往上两级再进那个仓）。
 * 后果：Windows 那边改一行 core，手机下一次构建就静默跟着变；换台机器、换个目录名，
 * 整个 Android 构建不过。审计记为 R-002。
 *
 * 现在 core 与 schema 来自 git submodule `nyx-core/`，Android 仓的 HEAD 记着它的 commit SHA。
 * 这组用例把三件事钉死：
 *   ① 依赖链里再也没有物理路径
 *   ② core-link / schema-link 只指 submodule
 *   ③ submodule 是**锁定**的：HEAD 记的指针 = 工作树检出的 commit，且 src/core 与 schema 干净
 *   ④ ★★★ 负向：Android import 到的正文 = 锁定 commit 里的正文 —— 别处（包括 Windows 主检出）
 *      改了什么都影响不到这里，除非有人更新指针并提交
 *   ⑤ 构建打出来的 core SHA 就是那个指针
 *
 * ★ 它有意**不**去看 Windows 仓库在哪 —— 那正是要摆脱的依赖。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { stripSource } from '../tools/lib/strip-comments.mjs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SUB = join(ROOT, 'nyx-core')
const git = (args: string[], cwd = ROOT): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'nyx-core' || name === 'build' || name === 'www') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 依赖链：源码 · 测试 · 构建配置 · 还在读 core / schema 的工具 */
const CHAIN = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'tests')),
  join(ROOT, 'vite.config.ts'),
  join(ROOT, 'vite.engine.config.ts'),
  join(ROOT, 'tsconfig.json'),
  join(ROOT, 'package.json'),
  join(ROOT, 'tools', 'build-info.mjs'),
  join(ROOT, 'tools', 'check-java-sql.mjs'),
  join(ROOT, 'tools', 'sync-pc.ts'),
  join(ROOT, 'tools', 'db-probe', 'run-node.mjs')
]

const pinnedOf = (): string => {
  const head = git(['ls-tree', 'HEAD', 'nyx-core']).split(/\s+/)[2] ?? ''
  const index = git(['ls-files', '--stage', 'nyx-core']).split(/\s+/)[1] ?? ''
  return head || index
}

describe('★★ core 锁：Android 不再读 Windows 工作树（T-1.3）', () => {
  it('① 依赖链里没有物理路径', () => {
    // ★ 针不写成字面量 —— 不然这个文件自己就是第一条命中
    const needle = ['claude_code', 'workspace'].join('_')
    /**
     * ★★ 先剥注释再扫（ZA-1）。这是**反向**断言：链里任何一个文件只要在**注释**里
     *   提一句那条老路径（而它们正是爱提的 —— 「这里原来指 Windows 工作树」），
     *   这条就假红。剥掉注释之后它盯的才是**真的 import**。
     */
    const hits = CHAIN.filter((f) =>
      stripSource(readFileSync(f, 'utf8'), f).includes(needle)
    ).map((f) =>
      relative(ROOT, f)
    )
    assert.deepEqual(hits, [], `★ 这些文件还在指 Windows 工作树：${hits.join('、')}`)
  })

  it('② core-link / schema-link 只指 submodule', () => {
    const link = readFileSync(join(ROOT, 'src', 'core-link.ts'), 'utf8')
    const froms = [...link.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string)
    assert.ok(froms.length > 30, `core-link 的导出条数不对：${froms.length}`)
    const bad = froms.filter((f) => !f.startsWith('../nyx-core/src/core/'))
    assert.deepEqual(bad, [], `★ core-link 有不指 submodule 的 import：${bad.join('、')}`)
    const schema = readFileSync(join(ROOT, 'src', 'schema-link.ts'), 'utf8')
    assert.match(schema, /from '\.\.\/nyx-core\/schema\/v\d+\.sql\?raw'/, '★ schema-link 没指 submodule')
  })

  it('③ submodule 是锁定的：HEAD 记的指针 = 工作树检出的 commit，且 src/core 与 schema 干净', () => {
    const pinned = pinnedOf()
    assert.match(pinned, /^[0-9a-f]{40}$/, `★ Android 仓里没有 nyx-core 的 gitlink（拿到「${pinned}」）`)
    const checkedOut = git(['rev-parse', 'HEAD'], SUB)
    assert.equal(checkedOut, pinned, '★ nyx-core 工作树检出的不是锁定那一版 —— 有人 update 了没提交，或者反过来')
    assert.equal(git(['status', '--porcelain', '--', 'src/core', 'schema'], SUB), '', '★ nyx-core 的 core / schema 有未提交改动')
  })

  it('★★★ ④ 负向：Android import 到的正文 = 锁定 commit 里的正文', () => {
    const pinned = pinnedOf()
    for (const rel of ['src/core/sync-tables.ts', 'src/core/sync-protocol.ts', 'src/core/prefs.ts', 'schema/v36.sql']) {
      const onDisk = readFileSync(join(SUB, rel), 'utf8').replace(/\r/g, '').trim()
      const inCommit = git(['show', `${pinned}:${rel}`], SUB).replace(/\r/g, '').trim()
      assert.equal(onDisk, inCommit, `★ ${rel} 在磁盘上的正文和锁定 commit 不一样`)
    }
  })

  it('⑤ 构建打出来的 core SHA 就是那个指针，指纹是 16 位', () => {
    const j = JSON.parse(
      execFileSync('node', [join(ROOT, 'tools', 'build-info.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8' })
    ) as { pinned: string; pinnedFull: string; dirty: boolean; schemaVersion: number; fingerprint: string }
    assert.equal(j.pinnedFull, pinnedOf())
    assert.equal(j.dirty, false)
    assert.match(j.fingerprint, /^[0-9a-f]{16}$/, `指纹不是 16 位十六进制：${j.fingerprint}`)
    const linkVersion = Number(/TARGET_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src', 'schema-link.ts'), 'utf8'))?.[1])
    assert.equal(j.schemaVersion, linkVersion)
  })
})
