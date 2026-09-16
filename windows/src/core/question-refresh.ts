/**
 * 出题的**替换次序** —— 两端唯一的一份（I-207，2026-09-16）
 *
 * ── 为什么这一段非得只有一份 ★★★ ────────────────────────
 *
 * 2026-09-16 手机真机实测：`quixoticism` **14 道未做题 → 0 道**，
 * 全库未做 **145 → 116**。不是做掉的（`used_at` 没变多），是**删掉的**。
 *
 * 老次序是：**先删旧的未做题 → 再去调 AI 生成**。
 * 而那次生成大约一半会抛错（模型把额度全用在思考上）。于是：
 * **旧题没了，新题也没有**，屏上还只说「模型额度不够」——
 * 一个字都没提「你缓存的那批题刚被清掉了」。
 *
 * 正确的次序只有一条：**先把新题拿到手，再在同一个事务里删旧插新。**
 * 生成失败 = 什么都没发生，他手上那批题一道不少。
 *
 * 两端各写一份的后果不是「提示语不一致」，是**一端会删、一端不删** ——
 * 而删掉的东西是他花过钱、也花过时间等出来的。所以判据在这里，
 * Windows（`main/study/production.ts`）与 Android（`practice.ts`）都调它。
 *
 * ★ 这里**不碰数据库、不认识题**，只回答两个问题：
 *   ① 这一次要不要生成、生成成功之后要不要替换旧的
 *   ② 生成失败了，是「照旧用上一批」还是「必须报错」
 */

export interface RefreshFacts {
  /** 未做的题里，**出题规则签名和现在对不上**的有几道（`qtype_sig` 比对的结果） */
  staleCount: number
  /** 未做的题**一共**有几道 */
  haveCount: number
}

export interface RefreshPlan {
  /** 要不要去调 AI */
  generate: boolean
  /**
   * 生成**成功之后**，要不要把旧的未做题删掉。
   * ★ 只有这个字段为真时才允许删 —— 而且必须和插新题在同一个事务里。
   */
  dropOld: boolean
}

/**
 * 这一次该做什么。
 *
 * · 有过期的（他改过勾选 / 规则）→ 生成，成功后替换（使用者 7：改过勾选，没做过的题要按新勾选重出）
 * · 没过期但手上还有题 → 什么都不做（D-129：一次生成此后离线可用，别白花钱）
 * · 手上一道都没有 → 生成，没有旧的可替换
 */
export function planQuestionRefresh(f: RefreshFacts): RefreshPlan {
  if (f.staleCount > 0) return { generate: true, dropOld: true }
  if (f.haveCount > 0) return { generate: false, dropOld: false }
  return { generate: true, dropOld: false }
}

/**
 * 生成失败时对他说的那一句。
 *
 * ★ **不是模型那句**（「模型把额度全用在思考上了…」）—— 那句是给日志和排查用的。
 *   摆在他面前的要回答他真正的问题：**我现在还能不能练？**
 */
export const KEPT_OLD_NOTICE = '这次没出成，还是上一批题。'

export type FailureVerdict =
  /** 手上还有旧题 —— 练习照常进行，只报这一句 */
  | { kind: 'keep-old'; notice: string }
  /** 一道题都没有 —— 必须把真实原因报出来，不能假装练得下去 */
  | { kind: 'report' }

export function onGenerateFailed(f: { haveCount: number }): FailureVerdict {
  return f.haveCount > 0 ? { kind: 'keep-old', notice: KEPT_OLD_NOTICE } : { kind: 'report' }
}
