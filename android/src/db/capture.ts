/**
 * Assist · L0 认出 + L1 收下（阶段 6 第一件 —— ASSIST_CONTRACT 的离线半场）。
 *
 * ══ 判据来处 ═══════════════════════════════════════════════
 *   normalizeTerm       ← `core/normalize-term.ts`（**只有这一份**；查重与 L0 同一把尺）
 *   assistCapture       ← repo.ts::addItem（299-366）逐字：D-026 重复收集
 *                         只算跨讲 · source='self'（他自己收的 —— 与手动加词
 *                         同语义，不发明新值）· recordOccurrence 走 trusted
 *                         fallback 分支（Capture 无材料，讲内找句那半天然为空
 *                         —— I-107 的简化不是另一份规则）· promoteOutOfEmpty
 *   落点                 ← D-305/D-306 + D-400② + T-5.9②：按**谁在收**（`SaveOrigin`）
 *                         分两侧，判据只有 `decideSaveTarget` 一份：
 *                         `assist` → `assist.save.lectureId` 活着就用它，
 *                                    否则 `Inbox / <宿主 App> / Saved`
 *                         `lookup` → `lookup.save.mode = custom` 且
 *                                    `lookup.save.lectureId` 活着就用它 →
 *                                    否则跟随 Assist → 再否则 `Inbox / Lookup / Saved`
 *                         全是**本机** settings（fk-map 会跨端重编号，
 *                         id 不许进 USER prefs）；缺哪级建哪级
 *                         （建法 = manage-nodes 的 create*，同一份默认规则）。
 *                         ★ 失效不静默存错：回落约定位，回执路径如实（D-399③尾）
 *                         ★ 「跟随」是解析时才读 —— Assist 改了默认位置，Lookup
 *                           自然跟着变，不抄第二份值
 *   包名                 ← D-335：只记录不作分析输入 —— 进 Unit 名 + ops_log
 *                         detail（items 无 device/包名列，不借机扩表 D-349）
 * ★ D-334 零输入 · D-338 词典没命中静默留白（Explain 缺失绝不阻断这里）。
 */
import { normalizeTerm } from '../core-link.ts'
import * as ledger from './ledger.ts'
import { createLecture, createProject, createUnit } from './manage-nodes.ts'
import type { Db } from './types.ts'

/**
 * 「同一个说法」那把尺 —— **从 core 读，这里不再留第二份**（2026-09-05）。
 *
 * 原来这里是 `repo.ts::normalizeTerm` 的逐字拷贝。T-2.11 把那一份上提到了
 * `core/normalize-term.ts`，而那个文件的头注就写着：「Android 的 `capture.ts:26`
 * 目前是同源的第二份拷贝……等下一次提 submodule 指针时让它改成从 core 读，
 * 那时才算真的只剩一份。」指针已经提到 `ff41358`，所以就是现在。
 *
 * ★ 仍然从这里导出：`db/lookup.ts` 与本文件的查重都按这个名字引它，
 *   换来源不该逼着调用方跟着改（行为逐字相同，只是少一份）。
 */
export { normalizeTerm }

export interface AssistStatus {
  known: boolean
  id?: number
  productionState?: string
  cardSilent?: boolean
  lectureName?: string | null
  recollected?: number
}

/** L0 · 两秒内说出「Nyx 里有没有它」—— 本地库直查 */
export async function assistStatus(db: Db, text: string): Promise<AssistStatus> {
  const norm = normalizeTerm(text)
  if (!norm) return { known: false }
  const r = await db.get(
    `select i.id, i.production_state as s, i.recollected_count as rc, rc2.silent as cs,
            (select l.name from item_lectures il join lectures l on l.id = il.lecture_id
              where il.item_id = i.id and il.deleted_at is null and il.is_owner = 1 limit 1) as lec
       from items i join reading_cards rc2 on rc2.item_id = i.id
      where i.deleted_at is null and lower(trim(i.term)) = ? limit 1`,
    [norm]
  )
  if (!r) return { known: false }
  return {
    known: true,
    id: Number(r['id']),
    productionState: String(r['s']),
    cardSilent: Number(r['cs']) !== 0,
    lectureName: r['lec'] != null ? String(r['lec']) : null,
    recollected: Number(r['rc'] ?? 0)
  }
}

/** 账本提醒（R-027）：他删过/静默过这个说法吗 —— 收下前如实说一句 */
export async function ledgerVerdicts(db: Db, text: string): Promise<string[]> {
  const norm = ledger.normTerm(text)
  if (!norm) return []
  return (
    await db.all(
      `select verdict from term_ledger where norm = ? and revoked_at is null order by verdict`,
      [norm]
    )
  ).map((r) => String(r['verdict']))
}

/** 包名 → Unit 名（`com.reddit.frontpage` → `Reddit`）；拿不到就 Captured */
export function unitNameOf(pkg: string | null): string {
  if (!pkg) return 'Captured'
  const seg = pkg.split('.').filter((x) => !['com', 'org', 'net', 'io', 'android', 'app'].includes(x))
  const pick = seg[0] ?? pkg
  return pick.charAt(0).toUpperCase() + pick.slice(1)
}

/** D-305/306 · 确保 Inbox / <单元名> / Saved 路径在（Inbox 是普通 Project，缺哪级建哪级） */
async function ensureSavePathNamed(db: Db, unitName: string): Promise<number> {
  const p = await db.get(`select id from projects where deleted_at is null and name = 'Inbox' limit 1`)
  const projectId = p ? Number(p['id']) : await createProject(db, 'Inbox')

  const u = await db.get(
    `select id from units where deleted_at is null and project_id = ? and name = ? limit 1`,
    [projectId, unitName]
  )
  const unitId = u ? Number(u['id']) : await createUnit(db, projectId, unitName)

  const l = await db.get(
    `select id from lectures where deleted_at is null and unit_id = ? and name = 'Saved' limit 1`,
    [unitId]
  )
  return l ? Number(l['id']) : await createLecture(db, unitId, 'Saved')
}

/**
 * ══ 谁在收（T-5.9②）════════════════════════════════════════
 *
 * 同一条写入路径（`captureAt`）现在有两个入口在用：第三方 App 里的 Assist 气泡、
 * 应用内的 Lookup。**写入一个字不动**，分开的只有「默认落哪」这一个维度 ——
 * 使用者要的是「Lookup 收的词可以跟 Assist 一起走，也可以自己去一个地方」。
 */
export type SaveOrigin = 'assist' | 'lookup'

/** 两侧各自的约定位单元名：Assist 记宿主 App（D-335 只记不析），Lookup 就是它自己 */
const FALLBACK_UNIT = (origin: SaveOrigin, pkg: string | null): string =>
  origin === 'assist' ? unitNameOf(pkg) : 'Lookup'

/** 配置里那个讲次还活着吗（三级都没被软删）—— 失效就是没配 */
async function aliveLecture(db: Db, lid: number): Promise<boolean> {
  if (!(lid > 0)) return false
  const r = await db.get(
    `select l.id from lectures l join units u on u.id = l.unit_id
       join projects p on p.id = u.project_id
      where l.id = ? and l.deleted_at is null and u.deleted_at is null and p.deleted_at is null`,
    [lid]
  )
  return r !== undefined
}

/** 本机 settings 里的一个数（没有 / 不是数 → 0）。★ id 只进本机，不进 USER prefs（D-400②） */
async function settingId(db: Db, key: string): Promise<number> {
  const s = await db.get(`select value from settings where key = ?`, [key])
  return s?.['value'] ? Number(s['value']) : 0
}

/**
 * 落点判据 —— **只判不建**。
 *
 * 分成「判」与「建」两半，是因为 Settings 要显示「现在会落到哪」，
 * 而**显示不该有副作用**：直接调 `resolveSaveTarget` 去拿一个标签，
 * 会把 `Inbox › Lookup › Saved` 三级当场建出来（打开设置页就长出一个讲次）。
 * 判据仍然只有这一份，下面两个都只是它的皮。
 */
type SaveTarget = { kind: 'lecture'; lectureId: number } | { kind: 'fallback'; unitName: string }

async function decideSaveTarget(
  db: Db,
  origin: SaveOrigin,
  pkg: string | null
): Promise<SaveTarget> {
  // ① Lookup 自定：只有 mode = custom **且**那个讲次还活着才算数
  if (origin === 'lookup') {
    const mode = (await db.get(`select value from settings where key = 'lookup.save.mode'`))?.['value']
    if (String(mode ?? 'follow') === 'custom') {
      const lid = await settingId(db, 'lookup.save.lectureId')
      if (await aliveLecture(db, lid)) return { kind: 'lecture', lectureId: lid }
    }
    // ② 没配 / 配了但失效 → 回落 follow，也就是往下走 Assist 那一档。
    //    ★ 「跟随」是**解析时才读**，所以他在 Assist 里改了默认位置，Lookup 自然跟着变 ——
    //      不需要把值抄一份到 lookup.save.lectureId（抄了就是第二份真相）。
  }

  // ③ Assist 的默认位置（Lookup 的 follow 也落在这一档）
  const lid = await settingId(db, 'assist.save.lectureId')
  if (await aliveLecture(db, lid)) return { kind: 'lecture', lectureId: lid }

  // ④ 谁都没配 → 各自的约定位。判不准不静默存错 —— 回执路径如实（D-400②）
  return { kind: 'fallback', unitName: FALLBACK_UNIT(origin, pkg) }
}

/**
 * D-400② + T-5.9② · 保存目标解析（会建路径）。
 *
 * `assist` → `assist.save.lectureId` 活着就用它，否则 `Inbox › <宿主App> › Saved`
 * `lookup` → 自定活着就用它 → 否则跟随 Assist → 再否则 `Inbox › Lookup › Saved`
 */
export async function resolveSaveTarget(
  db: Db,
  origin: SaveOrigin,
  pkg: string | null
): Promise<number> {
  const t = await decideSaveTarget(db, origin, pkg)
  return t.kind === 'lecture' ? t.lectureId : ensureSavePathNamed(db, t.unitName)
}

/**
 * 「现在会落到哪」的**只说不建**版本 —— Settings 的默认位置行用它。
 * 约定位还没建出来时说的是**将会建的那条路径**，不是一句「自动」：
 * 他该在按下去之前就知道东西会去哪（D-400② 回执如实的同一条精神）。
 */
export async function saveTargetLabel(
  db: Db,
  origin: SaveOrigin,
  pkg: string | null = null
): Promise<string> {
  const t = await decideSaveTarget(db, origin, pkg)
  return t.kind === 'lecture'
    ? savePathLabel(db, t.lectureId)
    : `Inbox › ${t.unitName} › Saved`
}

/** 目标 lecture 的三级路径标签（P › U › L）—— ⑫ 确认条与气泡回执用同一句话 */
export async function savePathLabel(db: Db, lectureId: number): Promise<string> {
  const r = await db.get(
    `select p.name pn, u.name un, l.name ln from lectures l join units u on u.id = l.unit_id
      join projects p on p.id = u.project_id where l.id = ?`,
    [lectureId]
  )
  return r ? `${String(r['pn'])} › ${String(r['un'])} › ${String(r['ln'])}` : 'Inbox'
}

export interface CaptureResult {
  id: number
  lectureId: number
  layer: 'A' | 'B'
  duplicateOf: number | null
  pathLabel: string
}

/** L1 · 收下（repo.addItem 逐字 + Inbox 落点 + ops_log 流水） */
export async function assistCapture(
  db: Db,
  term: string,
  layer: 'A' | 'B',
  pkg: string | null,
  /**
   * 谁在收（T-5.9②）。★ **必填、没有默认值**：三个调用点各自说清自己是谁
   * （气泡 / 引擎 = `'assist'`，Lookup = `'lookup'`）。给默认值就等于
   * 「忘了写的人静默拿到 Assist 的落点」—— 那正是这条要修掉的形状。
   */
  origin: SaveOrigin,
  url?: string | null,
  /** D-399③ · 词所在完整句子（选择层抽取）—— 出处引用走它 */
  quote?: string | null
): Promise<CaptureResult> {
  const lectureId = await resolveSaveTarget(db, origin, pkg)
  const r = await captureAt(db, term, layer, lectureId, pkg, url, quote)
  /**
   * T-4.14 · 查词记账回填：这一次**查完收下了** —— 记在那一行 lookup 的
   * `detail.saved` 上，不新记一行（收下自己那一行流水在 `captureAt` 里）。
   * ★ 放在 `assistCapture` 而不是 `captureAt`：这一层的两个入口（气泡 · Lookup 页）
   *   之前必有一次同词查询；「添加表达」直接走 `captureAt`，那一条不是查出来的。
   */
  await ledger.markLookupSaved(db, term, r.id)
  return r
}

/**
 * 收进**指定讲次**（第十一则指令 · 「添加表达」接通）。
 * 与 Windows Capture 的 `addTo(lectureId)` 同一形状：位置是调用方给的，
 * 其余判据（重复收集 D-026 · 出处 I-107/D-399③ · empty 晋升 N-1 · 流水
 * D-335）与 assistCapture 完全同一份 —— assistCapture 只是「位置来自
 * 默认保存设置」的这层皮。
 */
export async function captureAt(
  db: Db,
  term: string,
  layer: 'A' | 'B',
  lectureId: number,
  pkg: string | null = null,
  url?: string | null,
  quote?: string | null
): Promise<CaptureResult> {
  const t = Date.now()
  const clean = term.trim()
  if (!clean) throw new Error('还没写要加什么。')

  // D-026 · 已经在库里的表达再收一次，是有意义的信号，不能悄悄合并
  const prior = await db.get(
    `select id from items where deleted_at is null and lower(trim(term)) = ? limit 1`,
    [normalizeTerm(clean)]
  )
  const hadBefore =
    prior !== undefined &&
    (await db.get(`select 1 as x from item_lectures where item_id = ? and lecture_id = ? and deleted_at is null`, [
      Number(prior['id']),
      lectureId
    ])) !== undefined

  await db.begin()
  try {
    await db.run(
      `insert into items (term, gloss, layer, kind, source, owner_lecture_id, confidence, created_at, updated_at)
       values (?, '', ?, 'chunk', 'self', ?, 1.0, ?, ?)`,
      [clean, layer, lectureId, t, t]
    )
    const id = Number((await db.get(`select last_insert_rowid() as id`))?.['id'] ?? 0)

    await db.run(
      `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
       values (?, ?, 1, ?, ?)
           on conflict(item_id, lecture_id) do update set
             deleted_at = null, updated_at = excluded.updated_at
           where item_lectures.deleted_at is not null`,
      [id, lectureId, t, t]
    )

    // I-107 · Capture 无材料：trusted fallback = 他给的原文。
    // D-399③ · 选择层给了完整句子就存句子 —— 知识点页面的出处引用因此
    // 与既有词条完全同构（整句 + 词高亮）。
    const occQuote = quote?.trim() || clean
    await db.run(
      `insert into occurrences (item_id, material_id, lecture_id, quote, para, created_at, updated_at)
       values (?, null, ?, ?, null, ?, ?)`,
      [id, lectureId, occQuote, t, t]
    )

    // 6.3 · 只有在别的 lecture 里再次遇到才算重复收集
    if (prior && !hadBefore) {
      await db.run(`update items set recollected_count = recollected_count + 1, updated_at = ? where id = ?`, [
        t,
        Number(prior['id'])
      ])
    }

    // N-1 · 收下也是内容 —— empty 讲次晋升 review
    const lec = await db.get(
      `select (select count(*) from item_lectures il join items i on i.id = il.item_id
                where il.lecture_id = l.id and il.deleted_at is null and i.deleted_at is null) as items
         from lectures l where l.id = ? and l.status = 'empty' and l.deleted_at is null`,
      [lectureId]
    )
    if (lec && Number(lec['items']) > 0) {
      await db.run(`update lectures set status = 'review', updated_at = ? where id = ?`, [t, lectureId])
    }

    // D-335 · 包名/URL 只记流水，不作分析输入
    await ledger.op(db, 'capture', 'item', id, clean, { pkg, url: url ?? null, layer })
    await db.commit()

    return {
      id,
      lectureId,
      layer,
      duplicateOf: prior ? Number(prior['id']) : null,
      pathLabel: await savePathLabel(db, lectureId)
    }
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }
}
