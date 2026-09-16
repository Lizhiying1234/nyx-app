import type { Database } from 'better-sqlite3'
import {
  practiceFaceOf,
  practiceRulesOf,
  QUIZ_RULE_KEYS,
  type PracticeFace,
  type PracticeRules
} from '@core/quiz-rules.ts'
import { Prefs } from './db/prefs.ts'

/**
 * 写作层出题规则的四个选项 · D-482（使用者 2026-09-15「全部按照推荐的来」）
 *
 * ── 为什么单独一个模块 ★ ──────────────────────────────────
 *
 * 和 `reading-faces.ts` 抽出来是同一个理由：写在 `index.ts` 的 IPC 闭包里就**验不到**。
 * 这里有两条会悄悄坏掉的判据 —— 「老数据认账只跑一次」和「不自动清空他写过的题型提示词」——
 * 它们必须能被 `test:db` 够着。判据够不着的地方，就是下一次没人发现的地方。
 *
 * ── 存在哪 ────────────────────────────────────────────────
 *
 *   `practice.hintLevel` / `practice.contextSpread`
 *   `practice.requireFullSentence` / `practice.matchRegister`   USER · 同步（白名单在 core）
 *   `qtypes.optionsMigratedAt`                                   **DEVICE**，在 `settings` 里
 *
 * ★ 记号为什么是 DEVICE：和 `reading.facesMigratedAt` 逐字同一个理由 ——
 *   它是「这台机器认过账了」，不是「他想要什么」。进同步表的话两台机器算出同一个 uid、
 *   各写各的时间戳 = 必然冲突（2026-09-08 `smoke:sync` S7 真红过一次）。
 */

const QTYPES_MIGRATED_KEY = 'qtypes.optionsMigratedAt'

/**
 * ══ 老数据认账 · 写作层（确认单 §四）════════════════════════
 *
 * 扫 `qtypes.prompt` 非空的行：
 *   · 一行都没有 → 按新出厂值勾上四个选项，**无声**
 *   · 有         → 那几个题型**继续用他写的那段**（`typesBrief` 的优先级一个字没改），
 *                  只是设置页不再给编辑框；那几行旁边一句小字 +「改回默认」。
 *
 * ★★★ **不自动清空。** 清空 = 悄悄改掉他调过的出题方式，而他不会联想到是这次改动干的。
 * ★ 这一趟**一个字都不往同步表里写**：选项不写 = 读的时候回出厂值（core 的宽容读法），
 *   行为完全一样，而同步表上少一次无条件写。
 */
export function migrateQtypeOptionsOnce(db: Database): void {
  const has = db.prepare(`select value from settings where key = ?`).get(QTYPES_MIGRATED_KEY) as
    | { value: string }
    | undefined
  if (has) return
  const t = Date.now()
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(QTYPES_MIGRATED_KEY, String(t), t)
}

/** 四个选项的现值。没设过的按出厂 —— 判据在 core 一处 */
export function practiceOptions(db: Database): PracticeRules {
  migrateQtypeOptionsOnce(db)
  const prefs = new Prefs(db)
  return practiceRulesOf((k) => prefs.raw(k))
}

/** 产出的牌面现值（D-486）。只动渲染，不进提示词 —— 所以和上面那四个分开 */
export function practiceFace(db: Database): PracticeFace {
  return practiceFaceOf((k) => new Prefs(db).raw(k))
}

export function savePracticeFace(db: Database, v: PracticeFace): PracticeFace {
  new Prefs(db).set(QUIZ_RULE_KEYS.practiceFace, v)
  return practiceFace(db)
}

/**
 * 存一个选项。
 * ★ 只递「改了哪一项」，不递整份 —— 递整份的话，两处同时开着时
 *   后存的那一次会把前一次的改动一起写回去。
 */
export function savePracticeOption(db: Database, patch: Partial<PracticeRules>): PracticeRules {
  const prefs = new Prefs(db)
  if (patch.hintLevel !== undefined) prefs.set(QUIZ_RULE_KEYS.practiceHint, patch.hintLevel)
  if (patch.contextSpread !== undefined) prefs.set(QUIZ_RULE_KEYS.contextSpread, patch.contextSpread)
  if (patch.requireFullSentence !== undefined) {
    prefs.set(QUIZ_RULE_KEYS.requireFullSentence, patch.requireFullSentence ? '1' : '0')
  }
  if (patch.matchRegister !== undefined) {
    prefs.set(QUIZ_RULE_KEYS.matchRegister, patch.matchRegister ? '1' : '0')
  }
  return practiceOptions(db)
}
