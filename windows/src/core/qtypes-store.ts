/**
 * 题型的增删改 —— **两端唯一的一份**（⑤ · 2026-09-01 上提 core）
 *
 * 使用者当初的原话（Windows 侧那一轮）：「像现有的 Lumen（导师）和体裁一样，
 * 支持题型的增 / 删 / 改。每个题型都有自己的提示词（用户可自己写）。
 * 题型列表可管理，支持启用/禁用。」
 * 需求 ⑤ 把同一件事要到了手机上，所以判据从 `main/db/qtypes.ts` 上提到这里。
 *
 * ══ 有一条不能让它变成口味问题 ★★★ ══════════════════════════
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
 * ══ 删掉一个题型，老题目怎么办 ═══════════════════════════════
 *
 * 软删。`questions.type` 里存的是 `key`，历史题目照常显示、报告照常算 ——
 * 只是不再出新的。硬删会让报告里的知识流向图断掉，而那是他看进度的地方。
 *
 * ══ 调用方负责事务 ═══════════════════════════════════════════
 * 两端的事务写法不一样（better-sqlite3 的 `db.transaction` vs 异步 begin/commit），
 * 所以这里不开事务 —— 和 `core/purge.ts` 同一个约定。
 */
import { canonicalUid } from './builtin-identity.ts'
import { qtypeUid } from './identity.ts'
import { QTYPES as SEED_QTYPES, type QTypeDef } from './qtypes.ts'
import type { CascadeDb } from './cascade.ts'

/**
 * 停用最后一种题型时拦住他的那一句 —— **两处在说**（R-05，2026-09-15）：
 * core 这一份判据，和 `main/db/qtypes.ts` 里落库前的那一道。整句以前各写一遍。
 */
export const LAST_ENABLED_QTYPE =
  '就剩这一种是启用的。停用它，产出练习会出不了题 —— 先启用另一种，再停用它。'

/** 同上：删到只剩一种时拦住他的那一句，core 与 Windows 两处在用 */
export const KEEP_ONE_QTYPE = '至少要留一种题型 —— 删光了产出练习就出不了题。'

export interface QTypeRow {
  uid: string
  key: string
  name: string
  brief: string
  guide: string
  prompt: string
  enabled: boolean
  canonical: boolean
  builtin: boolean
  sort: number
}

/**
 * ══ 这一种题型**真正发给 AI 的是哪一段** · I-187（D-482 附记）★★★ ═══
 *
 * ── 病是什么（2026-09-15 在他真库里查出来的）──────────────
 *
 * 12 种内置题型里有 **10 种**带着 5～10 千字的英文 `prompt`，而且**和题型名错位**
 * （「造句」那一条写的是 cohesion reconstruction）。生成那条路一直是
 * 「有 `prompt` 就用 `prompt`，没有才退回 `guide`」——
 * **所以「造句」一直在按别的题型出题，而屏幕上一切正常。**
 *
 * 使用者 2026-09-15 答：那些正文**是生成的，不是他写的**。
 * 于是「有 prompt 就用」这条优先级的前提没了 —— 它当初成立是因为
 * 「`prompt` = 他自己写的，当然压过内置说明」。
 *
 * ── 现在的判据 ────────────────────────────────────────────
 *
 *   内置题型（`builtin`）→ **只用 `guide`**，`prompt` 一个字都不读
 *   自建题型            → `prompt || guide`（那是他自己造的一种，`prompt` 就是它的形状）
 *
 * ★★ **数据一个字不动**（D-216）：`qtypes.prompt` 那一列照旧留着。
 *   删它是不可逆的，而「不读」已经把病治了；万一哪天查出别的来历，正文还在。
 * ★★ 判据在 core 一份：两端的生成路各自写一份的话，
 *   **同一个题型在电脑上按 guide 出、在手机上按那段垃圾出**，而两边都不报错。
 *
 * ══ ★★★ grep `.prompt` 的人先读这一段 ══════════════
 *
 * 仓里有**两个叫 `prompt` 的东西，同名不同物**：
 *
 *   `qtypes.prompt`     这一种题型的出题说明  ← **只有它走本函数**
 *   `questions.prompt`  一道具体题目的**题面正文**（`main/study/production.ts:469` 入库、
 *                       `:617` 喂给判分）—— **不得改走本函数**
 *
 * 按「凡是 `.prompt` 都改成 `effectiveQTypePrompt`」扫一遍的话，
 * **判分会拿题型说明去判他写的那句话，而且不报错** ——
 * 分数照样出、评语照样有模有样。（Nyx-UI-Android 2026-09-15 在手机那侧
 * 差点顺手改了，写下来免得下一个人 grep 到四处就改四处。）
 */
export function effectiveQTypePrompt(row: {
  builtin: boolean
  guide: string
  prompt: string
}): string {
  const guide = (row.guide ?? '').trim()
  if (row.builtin) return guide
  return (row.prompt ?? '').trim() || guide
}

const toRow = (x: Record<string, unknown>): QTypeRow => ({
  uid: x['uid'] as string,
  key: x['key'] as string,
  name: x['name'] as string,
  brief: (x['brief'] as string) ?? '',
  guide: (x['guide'] as string) ?? '',
  prompt: (x['prompt'] as string) ?? '',
  enabled: (x['enabled'] as number) !== 0,
  canonical: (x['canonical'] as number) !== 0,
  builtin: (x['builtin'] as number) !== 0,
  sort: (x['sort'] as number) ?? 0
})

const SEL = `select uid, key, name, brief, guide, prompt, enabled, canonical, builtin, sort
               from qtypes where deleted_at is null order by sort, uid`

/** 全部（含停用的）—— 管理页要看得见停用的那些 */
export async function allQTypes(db: CascadeDb): Promise<QTypeRow[]> {
  return (await db.all(SEL)).map(toRow)
}

/** 启用的 —— 练习那边只该看见这些 */
export async function activeQTypes(db: CascadeDb): Promise<QTypeRow[]> {
  return (await allQTypes(db)).filter((q) => q.enabled)
}

export async function saveQType(
  db: CascadeDb,
  q: Partial<QTypeRow> & { name: string },
  now: number
): Promise<string> {
  const name = q.name.trim() || '未命名题型'
  if (q.uid) {
    await db.run(
      `update qtypes set name = ?, brief = ?, guide = ?, prompt = ?,
                         enabled = ?, updated_at = ?
        where uid = ?`,
      [name, q.brief ?? '', q.guide ?? '', q.prompt ?? '', q.enabled === false ? 0 : 1, now, q.uid]
    )
    return q.uid
  }
  /**
   * key 一旦生成不再变 —— `questions.type` 里存的就是它。
   * 用名字当 key（和内置那 12 个一致，看日志时认得出是哪一种）；
   * 撞了就挂个短后缀，**绝不覆盖已有的那一行**。
   */
  let key = name
  const taken = async (k: string): Promise<boolean> =>
    !!(await db.get(`select 1 as x from qtypes where key = ?`, [k]))
  if (await taken(key)) {
    let n = 2
    while (await taken(`${name}-${n}`)) n++
    key = `${name}-${n}`
  }
  const maxRow = await db.get(`select coalesce(max(sort), 0) as n from qtypes`)
  const max = Number(maxRow?.['n'] ?? 0)
  /**
   * ★★ C-1 · 身份**由 key 算出来**，不再随机（D-280）。
   *
   * 随机的后果：两台设备各建一个同名题型 → 两个 uid、同一个 `key`
   * → `on conflict(uid)` 不命中 → INSERT → 撞 `idx_qtypes_key` → 永久失败。
   * 算出来就没有这回事：同一个 key 在两台上必然是同一个 uid，upsert 正常接管。
   */
  const uid = qtypeUid(key)
  await db.run(
    // ★ `tier` 列按 D-216 留着（not null 且无默认值）但没含义了（D-478），一律写 1
    `insert into qtypes (uid, key, name, tier, brief, guide, prompt, enabled, canonical, builtin,
                         sort, created_at, updated_at)
     values (?, ?, ?, 1, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    [uid, key, name, q.brief ?? '', q.guide ?? '', q.prompt ?? '',
     q.enabled === false ? 0 : 1, max + 1, now, now]
  )
  return uid
}

/**
 * 删（软删）。护栏只剩一条：**至少留一种** —— 删光了产出练习就出不了题。
 * ★ 2026-09-08（D-478）· 原来还有一条「不能把某一档删空」，随档位机制一起撤了。
 */
export async function removeQType(db: CascadeDb, uid: string, now: number): Promise<void> {
  const list = await allQTypes(db)
  const target = list.find((q) => q.uid === uid)
  if (!target) return
  if (list.length <= 1) throw new Error(KEEP_ONE_QTYPE)
  await db.run(`update qtypes set deleted_at = ?, updated_at = ? where uid = ?`, [now, now, uid])
}

export async function setQTypeEnabled(
  db: CascadeDb,
  uid: string,
  on: boolean,
  now: number
): Promise<void> {
  if (!on) {
    const list = await allQTypes(db)
    const q = list.find((x) => x.uid === uid)
    if (q) {
      const others = list.filter((x) => x.uid !== uid && x.enabled)
      if (others.length === 0) {
        throw new Error(LAST_ENABLED_QTYPE)
      }
    }
  }
  await db.run(`update qtypes set enabled = ?, updated_at = ? where uid = ?`, [on ? 1 : 0, now, uid])
}

/** 按拖拽后的顺序落库（同一档内）。★ 调用方开事务 */
export async function reorderQTypes(db: CascadeDb, uids: string[], now: number): Promise<void> {
  for (let i = 0; i < uids.length; i++) {
    await db.run(`update qtypes set sort = ?, updated_at = ? where uid = ?`, [i + 1, now, uids[i]])
  }
}

/**
 * 恢复出厂的那 12 种（他改坏了想退回来）。
 * **只补不删** —— 他自己加的一条都不动，内置的那些改回原样。★ 调用方开事务
 */
export async function restoreBuiltinQTypes(db: CascadeDb, now: number): Promise<number> {
  let n = 0
  let sort = 0
  for (const q of SEED_QTYPES as QTypeDef[]) {
    sort++
    const had = await db.get(`select uid from qtypes where key = ?`, [q.id])
    if (had) {
      await db.run(
        `update qtypes set name = ?, brief = ?, guide = ?, prompt = '',
                           enabled = 1, deleted_at = null, updated_at = ?
          where key = ?`,
        [q.name, q.brief, q.guide, now, q.id]
      )
    } else {
      /**
       * ★ R-4-G · 补回来的那一条也要拿确定性身份，不能让触发器随机发一个 ——
       * 随机的那个在另一台设备上认不出来，同步时会撞主键。
       *
       * `updated_at` 写 `now` 是**对的**：点「恢复出厂题型」是一次用户动作，
       * 它要传到另一台去（那边可能正把这条改成了别的样子）。
       */
      const uid = canonicalUid('qtypes', { builtin: 1, key: q.id })
      await db.run(
        // ★ `tier` 同上：列留着、写 1、不再读
        `insert into qtypes (key, name, tier, brief, guide, prompt, enabled, canonical, builtin,
                             sort, uid, created_at, updated_at)
         values (?, ?, 1, ?, ?, '', 1, ?, 1, ?, ?, ?, ?)`,
        [q.id, q.name, q.brief, q.guide, q.canonical ? 1 : 0, sort, uid, now, now]
      )
    }
    n++
  }
  return n
}
