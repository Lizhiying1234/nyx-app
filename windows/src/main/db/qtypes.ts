import { KEEP_ONE_QTYPE, LAST_ENABLED_QTYPE } from '@core/qtypes-store.ts'
import type { Database } from 'better-sqlite3'
import { canonicalUid } from '@core/builtin-identity.ts'
import { qtypeUid } from '@core/identity.ts'
import { QTYPES as SEED_QTYPES, type QTypeDef } from '@core/qtypes.ts'
import type { QTypeRow } from '@shared/api.ts'

/**
 * 题型的增删改 · 使用者「产出练习题型系统」
 *
 * 「像现有的 Lumen（导师）和体裁一样，支持题型的增 / 删 / 改。
 *   每个题型都有自己的提示词（用户可自己写）。题型列表可管理，支持启用/禁用。」
 *
 * ── 有一条不能让它变成口味问题 ─────────────────────────────
 *
 * ★ 2026-09-08 · **档位机制整个取消**（D-478）。这里原来写着「五个难度档是机制」——
 * D-116 的递进、M-027 说的
 * 「连续 3 次正确必然横跨 3 种题型」，判据都挂在档上。
 * 如果自定义题型不挂档，他可以只留三种一样简单的题型 ——
 * 于是「3 连正确」全是同一个难度，**静默判定当场失效，而分数还很好看**。
 * 那是最坏的组合：软件说他学会了，而他并没有。
 *
 * ★ 现在没有档了：题型只有「他勾了哪几种、按什么顺序」，出几道由 `param.questionsPerItem` 定。
 *
 * ── 删掉一个题型，老题目怎么办 ─────────────────────────────
 *
 * 软删。`questions.type` 里存的是 `key`，历史题目照常显示、报告照常算 ——
 * 只是不再出新的。硬删会让报告里的知识流向图断掉，而那是他看进度的地方。
 */

const now = (): number => Date.now()

const toRow = (x: Record<string, unknown>): QTypeRow => ({
  uid: x.uid as string,
  key: x.key as string,
  name: x.name as string,
  brief: (x.brief as string) ?? '',
  guide: (x.guide as string) ?? '',
  prompt: (x.prompt as string) ?? '',
  enabled: (x.enabled as number) !== 0,
  canonical: (x.canonical as number) !== 0,
  builtin: (x.builtin as number) !== 0,
  sort: (x.sort as number) ?? 0
})

const SEL = `select uid, key, name, brief, guide, prompt, enabled, canonical, builtin, sort
               from qtypes where deleted_at is null order by sort, uid`

export class QTypes {
  constructor(private db: Database) {}

  /** 全部（含停用的）—— 管理页要看得见停用的那些 */
  all(): QTypeRow[] {
    return (this.db.prepare(SEL).all() as Record<string, unknown>[]).map(toRow)
  }

  /** 启用的 —— 练习那边只该看见这些 */
  active(): QTypeRow[] {
    return this.all().filter((q) => q.enabled)
  }



  save(q: Partial<QTypeRow> & { name: string }): string {
    const t = now()
    const name = q.name.trim() || '未命名题型'
    if (q.uid) {
      this.db
        .prepare(
          `update qtypes set name = ?, brief = ?, guide = ?, prompt = ?,
                             enabled = ?, updated_at = ?
            where uid = ?`
        )
        .run(
          name,
          q.brief ?? '',
          q.guide ?? '',
          q.prompt ?? '',
          q.enabled === false ? 0 : 1,
          t,
          q.uid
        )
      return q.uid
    }
    /**
     * key 一旦生成不再变 —— `questions.type` 里存的就是它。
     * 用名字当 key（和内置那 12 个一致，看日志时认得出是哪一种）；
     * 撞了就挂个短后缀，**绝不覆盖已有的那一行**。
     */
    let key = name
    const taken = (k: string): boolean =>
      !!this.db.prepare(`select 1 as x from qtypes where key = ?`).get(k)
    if (taken(key)) {
      let n = 2
      while (taken(`${name}-${n}`)) n++
      key = `${name}-${n}`
    }
    const max = (
      this.db.prepare(`select coalesce(max(sort), 0) as n from qtypes`).get() as { n: number }
    ).n
    /**
     * ★ uid 是主键，插入时**必须自己给**（R-3-h / V27）。
     *   老写法靠 after-insert 触发器补 uid —— 那个触发器已经删掉了。
     */
    /**
     * ★★ Step 2 · C-1 · 身份**由 key 算出来**，不再随机（D-280）。
     *
     * 随机的后果：两台设备各建一个同名题型 → 两个 uid、同一个 `key`
     * → `on conflict(uid)` 不命中 → INSERT → 撞 `idx_qtypes_key` → 永久失败。
     * 算出来就没有这回事：同一个 key 在两台上必然是同一个 uid，upsert 正常接管。
     *
     * `key` 一经创建就不再改（`save()` 的更新分支从不写 `key`），
     * 所以身份是稳的 —— `db-safety` 里有一条扫源码的用例守着这一点。
     */
    const uid = qtypeUid(key)
    this.db
      .prepare(
        // ★ `tier` 列按 D-216 留着（not null 且无默认值）但没含义了（D-478），一律写 1
        `insert into qtypes (uid, key, name, tier, brief, guide, prompt, enabled, canonical, builtin,
                             sort, created_at, updated_at)
         values (?, ?, ?, 1, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
      )
      .run(
          uid,
          key,
          name,
          q.brief ?? '',
          q.guide ?? '',
          q.prompt ?? '',
          q.enabled === false ? 0 : 1,
          max + 1,
          t,
          t
      )
    return uid
  }

  /**
   * 删（软删）。护栏只剩一条：**至少留一种** —— 删光了产出练习就出不了题。
   * ★ 2026-09-08（D-478）· 原来还有一条「不能把某一档删空」，随档位机制一起撤了。
   */
  remove(uid: string): void {
    const list = this.all()
    const target = list.find((q) => q.uid === uid)
    if (!target) return
    if (list.length <= 1) throw new Error(KEEP_ONE_QTYPE)
    const t = now()
    this.db.prepare(`update qtypes set deleted_at = ?, updated_at = ? where uid = ?`).run(t, t, uid)
  }

  setEnabled(uid: string, on: boolean): void {
    const t = now()
    if (!on) {
      const q = this.all().find((x) => x.uid === uid)
      if (q) {
        const others = this.all().filter((x) => x.uid !== uid && x.enabled)
        if (others.length === 0) {
          throw new Error(LAST_ENABLED_QTYPE)
        }
      }
    }
    this.db
      .prepare(`update qtypes set enabled = ?, updated_at = ? where uid = ?`)
      .run(on ? 1 : 0, t, uid)
  }

  /** 按拖拽后的顺序落库（同一档内） */
  reorder(uids: string[]): void {
    const t = now()
    const up = this.db.prepare(`update qtypes set sort = ?, updated_at = ? where uid = ?`)
    this.db.transaction(() => {
      uids.forEach((uid, i) => up.run(i + 1, t, uid))
    })()
  }

  /**
   * 恢复出厂的那 12 种（他改坏了想退回来）。
   * **只补不删** —— 他自己加的一条都不动，内置的那些改回原样。
   */
  restoreBuiltin(): number {
    const t = now()
    let n = 0
    const upd = this.db.prepare(
      `update qtypes set name = ?, brief = ?, guide = ?, prompt = '',
                         enabled = 1, deleted_at = null, updated_at = ?
        where key = ?`
    )
    const ins = this.db.prepare(
      // ★ `tier` 同上：列留着、写 1、不再读
      `insert into qtypes (key, name, tier, brief, guide, prompt, enabled, canonical, builtin,
                           sort, uid, created_at, updated_at)
       values (?, ?, 1, ?, ?, '', 1, ?, 1, ?, ?, ?, ?)`
    )
    this.db.transaction(() => {
      let sort = 0
      for (const q of SEED_QTYPES as QTypeDef[]) {
        sort++
        const had = this.db.prepare(`select uid from qtypes where key = ?`).get(q.id)
        if (had) upd.run(q.name, q.brief, q.guide, t, q.id)
        else {
          /**
           * ★ R-4-G · 补回来的那一条也要拿确定性身份，不能让触发器随机发一个 ——
           * 随机的那个在另一台设备上认不出来，同步时会撞主键。
           *
           * `updated_at` 写 `now` 是**对的**：点「恢复出厂题型」是一次用户动作，
           * 它要传到另一台去（那边可能正把这条改成了别的样子）。
           * 只有「从没被人碰过」的出厂内容才用 0，见 `db/builtins.ts`。
           */
          const uid = canonicalUid('qtypes', { builtin: 1, key: q.id })
          ins.run(q.id, q.name, q.brief, q.guide, q.canonical ? 1 : 0, sort, uid, t, t)
        }
        n++
      }
    })()
    return n
  }
}
