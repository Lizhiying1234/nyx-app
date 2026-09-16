/**
 * 压实的触发点 · T-2.10 —— 判据用例
 *
 * 这一套只验**判据**：什么时候该压、什么时候不该压、读到多少算超。
 * 接线那一层（`run()` 之后真的调了一次、账本上真的多了一行、失败不影响同步结果）
 * 在 `tests/db-safety.ts` 里，那边跑真的主进程 + 真的假云。
 *
 * ★ 负向对照的重点是**「不该压的时候不压」**那几条：
 *   压实会删云端的东西，误触发一次的代价比漏触发一次大得多。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SYNC_TABLES } from '../sync-tables.ts'
import { PRESERVED_SYNC_KEYS } from '../sync-metadata.ts'
import {
  COMPACT_LIMITS,
  COMPACT_PACK_LIMIT,
  COMPACT_PENDING_KEY,
  COMPACT_RETRY_MS,
  COMPACT_TRIED_KEY,
  markCompactPending,
  noteCompactTried,
  overBudget,
  readCompactState,
  shouldCompact,
  type CompactStateDb
} from './compact-trigger.ts'

const NOW = 1_800_000_000_000

/** 默认是「配好了同步、没立过碑、从没压过、桶里空空」 */
const input = (over: Partial<Parameters<typeof shouldCompact>[0]> = {}): Parameters<typeof shouldCompact>[0] => ({
  configured: true,
  pendingAt: 0,
  triedAt: 0,
  bucketPacks: 0,
  now: NOW,
  ...over
})

describe('T-2.10 · 什么时候压实', () => {
  it('没配同步 → 不压（没有云端可压）', () => {
    const v = shouldCompact(input({ configured: false, pendingAt: NOW - 1000 }))
    assert.equal(v.go, false)
    assert.match(v.why, /还没配同步/)
  })

  it('★ 立过碑 → 压。不看包数、不看冷却（D-435 的正事）', () => {
    const v = shouldCompact(input({ pendingAt: NOW - 1000, bucketPacks: 2, triedAt: NOW - 1000 }))
    assert.equal(v.go, true)
    assert.match(v.why, /彻底删过东西/)
  })

  it('★ 负向对照 · 没有标记、包数也没到线 → 不压', () => {
    const v = shouldCompact(input({ bucketPacks: COMPACT_PACK_LIMIT - 1 }))
    assert.equal(v.go, false)
    assert.match(v.why, /还没到/)
  })

  it('★ 负向对照 · 不知道桶里有几个包（还没跑过同步）→ 不压', () => {
    const v = shouldCompact(input({ bucketPacks: -1 }))
    assert.equal(v.go, false)
    assert.match(v.why, /没有列过桶/)
  })

  it('包数到线 → 压', () => {
    const v = shouldCompact(input({ bucketPacks: COMPACT_PACK_LIMIT }))
    assert.equal(v.go, true)
    assert.match(v.why, new RegExp(String(COMPACT_PACK_LIMIT)))
  })

  it('★ 包数到线，但刚压过 → 不压（冷却；否则每趟同步都白读一遍整个桶）', () => {
    const v = shouldCompact(input({ bucketPacks: 500, triedAt: NOW - COMPACT_RETRY_MS + 1000 }))
    assert.equal(v.go, false)
    assert.match(v.why, /刚压过/)
  })

  it('包数到线，冷却过去了 → 压', () => {
    const v = shouldCompact(input({ bucketPacks: 500, triedAt: NOW - COMPACT_RETRY_MS - 1 }))
    assert.equal(v.go, true)
  })

  it('★ 时钟往回走（上次尝试在未来）→ 放行，不许被一个未来的时刻挡到天荒地老', () => {
    const v = shouldCompact(input({ bucketPacks: 500, triedAt: NOW + 10 * COMPACT_RETRY_MS }))
    assert.equal(v.go, true)
  })
})

describe('T-2.10 · 桶大小上限', () => {
  it('都没超 → null', () => {
    assert.equal(overBudget({ rows: 10, chars: 100 }), null)
    assert.equal(overBudget({ rows: COMPACT_LIMITS.maxRows, chars: COMPACT_LIMITS.maxChars }), null)
  })

  it('★ 行数超了 → 一句人话，而且说清「云端一个字都没动」', () => {
    const why = overBudget({ rows: COMPACT_LIMITS.maxRows + 1, chars: 0 })
    assert.ok(why !== null)
    assert.match(why, /行/)
    assert.match(why, /一个字都没动/)
  })

  it('★ 字符数超了 → 一句人话，按 MB 说', () => {
    const why = overBudget({ rows: 0, chars: COMPACT_LIMITS.maxChars + 1 })
    assert.ok(why !== null)
    assert.match(why, /MB/)
  })

  it('上限可以注入 —— ②档要能用真 store 证伪，而造一个 24 MB 的桶不是能跑的用例', () => {
    assert.equal(overBudget({ rows: 2, chars: 2 }, { maxRows: 1, maxChars: 999 })?.includes('行'), true)
    assert.equal(overBudget({ rows: 0, chars: 2 }, { maxRows: 999, maxChars: 1 })?.includes('MB'), true)
  })
})

// ══════════════════════════════════════════════════════════════
// 那两把钥匙
// ══════════════════════════════════════════════════════════════

/** 只认这三条语句的假库 —— 判据要的库面本来就只有这么大 */
class MemSettings implements CompactStateDb {
  rows = new Map<string, string>()

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    if (sql.includes('delete from settings')) {
      this.rows.delete(String(params[0]))
      return
    }
    if (sql.includes('insert into settings')) {
      this.rows.set(String(params[0]), String(params[1]))
      return
    }
    throw new Error(`假库不认识这条语句：${sql}`)
  }

  async get(_sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown> | undefined> {
    const v = this.rows.get(String(params[0]))
    return v === undefined ? undefined : { value: v }
  }
}

describe('T-2.10 · 待压实标记', () => {
  it('★ 这把钥匙永不上云：settings 不在 SYNC_TABLES，键也不在清空保留白名单里', () => {
    assert.equal((SYNC_TABLES as readonly string[]).includes('settings'), false)
    assert.equal((PRESERVED_SYNC_KEYS as readonly string[]).includes(COMPACT_PENDING_KEY), false)
    assert.equal((PRESERVED_SYNC_KEYS as readonly string[]).includes(COMPACT_TRIED_KEY), false)
  })

  it('记 → 读得到；试过 → 标记没了、时刻记下了', async () => {
    const db = new MemSettings()
    assert.deepEqual(await readCompactState(db), { pendingAt: 0, triedAt: 0 })

    await markCompactPending(db, NOW)
    assert.deepEqual(await readCompactState(db), { pendingAt: NOW, triedAt: 0 })

    await noteCompactTried(db, NOW + 5)
    assert.deepEqual(await readCompactState(db), { pendingAt: 0, triedAt: NOW + 5 })
  })

  it('★ 记不上标记不许把彻底删除带崩 —— 库炸了也只是吞掉', async () => {
    const broken: CompactStateDb = {
      run: () => Promise.reject(new Error('磁盘满了')),
      get: () => Promise.resolve(undefined)
    }
    await markCompactPending(broken, NOW) // 不抛就是对的
    assert.deepEqual(await readCompactState(broken), { pendingAt: 0, triedAt: 0 })
  })

  it('脏值一律当没有（负数 / 不是数字 / 空）', async () => {
    const db = new MemSettings()
    for (const bad of ['', '不是数字', '-1', '0']) {
      db.rows.set(COMPACT_PENDING_KEY, bad)
      assert.equal((await readCompactState(db)).pendingAt, 0, `脏值 ${bad} 该当成没有`)
    }
  })
})
