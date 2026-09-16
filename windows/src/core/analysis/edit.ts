/**
 * 改一条知识点的**正文**（term / gloss / gloss_zh）· **写入计划** —— T-9.14 / D-478 ③
 *
 * ── 这个文件答的是哪个问题 ────────────────────────────────
 *
 * 「他在对话框里按了保存 —— **到底要改哪几列、留痕里写什么、能不能改**」。
 * 只算，不写库：谁执行、用什么语句，是平台的事（同 `plan.ts` 的分工）。
 *
 * ── 为什么必须是 core 的一份 ──────────────────────────────
 *
 * 两端都能改（Windows T-9.14 · Android T-5.14 / D-R23），而这件事有三处**判断**：
 *
 *   ① 哪几列真的变了 —— 决定要不要写、要不要动 `updated_at`
 *   ② 留痕那一笔长什么样 —— **`field` 是 core 失效判定认的键**
 *      （`stale.ts::countsAsTermChange`：改释义不算改词、只改大小写也不算）
 *   ③ 什么情况下拒绝 —— 词条不能空、一个字没改就不该写一笔留痕
 *
 * 这三件各写一份的后果是**静默的**：手机改一次中文释义把整份解析报成「过期」，
 * 电脑不报；或者两端留痕的形状差一个键，`staleAfterEdit` 在一端永远返回 false。
 * 两边都说得通、都不报错 —— 正是 `judgement-must-not-come-from-the-thing-judged` 那类。
 *
 * ★ Android 今天的写入逻辑在它自己的仓（`src/db/edit-item.ts`，T-5.14 早于本文件）。
 *   它下一次提指针时可以改用这里的 `planItemEdit`，两端就真的是一份了 ——
 *   在那之前，这份实现与它**逐条对齐**（列白名单 · 拒绝三条 · 留痕五个键）。
 */
import { normalizeTerm } from '../normalize-term.ts'
import type { CorrectionEntry } from './stale.ts'

/** 能改的三列。★ 别的列一列都不许进来 —— 归属 / 层 / 学习史各有各的入口 */
export const EDITABLE_COLUMNS = ['term', 'gloss', 'gloss_zh'] as const
export type EditableColumn = (typeof EDITABLE_COLUMNS)[number]

/** 库里现在这三列是什么 */
export interface ItemText {
  term: string
  gloss: string
  glossZh: string
}

/** 他在对话框里填的。没给的键 = 这一列不动（不是「清空」） */
export interface ItemEditInput {
  term?: string
  gloss?: string
  glossZh?: string
}

export interface ItemEditPlan {
  /** 真的要改的那几列（按 term → gloss → gloss_zh 的固定顺序） */
  columns: { column: EditableColumn; value: string }[]
  /** 要追加进 `corrections` 的那几笔（每改一列一笔） */
  log: CorrectionEntry[]
  /** 词条改了没有 —— 出处摘句要不要跟着改看它（M-012） */
  termChanged: boolean
  /** 改之前的词条：出处里要被替换掉的旧串 */
  termWas: string
  /** 改之后的词条 */
  termNow: string
  /**
   * ★ 只改了大小写 / 空白 / 尾标点。
   *   仍然要写（他看见的就该是他打的那个样子），但**不该让解析失效** ——
   *   `countsAsTermChange` 判的就是这件事，这里把答案一起带出来，
   *   免得调用方再算一遍、算出第二个说法。
   */
  termSameAfterNormalize: boolean
}

/** 拒绝的三种理由 —— 每一种都直接是给他看的那句话 */
export class ItemEditRefused extends Error {
  /** 哪一种拒绝 —— 调用方要分开报，不是同一句话 */
  readonly why: 'empty-term' | 'no-change'

  /**
   * ★ 不用构造函数参数属性（`constructor(readonly why: …)`）：
   *   `npm test` 走的是 node 的 strip-only TS，它不支持那个写法 ——
   *   写了会在**加载这个文件时**就抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，
   *   而 `check:types` 是绿的（tsc 支持）。两道闸不一致的那种坑。
   */
  constructor(why: 'empty-term' | 'no-change', message: string) {
    super(message)
    this.name = 'ItemEditRefused'
    this.why = why
  }
}

/**
 * @param cur   库里现在的三列
 * @param input 他填的（没给的键不动）
 * @param at    这一笔的时间戳（调用方给，便于测试与「一个事务一个时间」）
 *
 * @throws {ItemEditRefused} 词条空了 · 一个字都没改
 *
 * ★ 释义 / 中文释义**可以清空**（默认值本来就是空串）：写错的中文释义得能删掉。
 *   只有词条不许空 —— 那一行字就是这条知识点本身。
 */
export function planItemEdit(cur: ItemText, input: ItemEditInput, at: number): ItemEditPlan {
  const was: Record<EditableColumn, string> = {
    term: cur.term,
    gloss: cur.gloss,
    gloss_zh: cur.glossZh
  }
  const given: [EditableColumn, string | undefined][] = [
    ['term', input.term],
    ['gloss', input.gloss],
    ['gloss_zh', input.glossZh]
  ]

  const columns: ItemEditPlan['columns'] = []
  const log: CorrectionEntry[] = []
  for (const [column, raw] of given) {
    if (raw === undefined) continue
    const value = raw.trim()
    if (column === 'term' && value === '') {
      throw new ItemEditRefused('empty-term', '知识点不能空着 —— 那一行字就是它本身。')
    }
    if (value === was[column]) continue
    columns.push({ column, value })
    log.push({ field: column, was: was[column], should: value, why: '手动修改', at })
  }

  if (columns.length === 0) {
    throw new ItemEditRefused('no-change', '没有改动 —— 和原来一模一样。')
  }

  const termNext = columns.find((c) => c.column === 'term')
  const termNow = termNext?.value ?? cur.term
  return {
    columns,
    log,
    termChanged: termNext !== undefined,
    termWas: cur.term,
    termNow,
    termSameAfterNormalize:
      termNext !== undefined && normalizeTerm(cur.term) === normalizeTerm(termNow)
  }
}
