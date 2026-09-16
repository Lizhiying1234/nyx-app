/**
 * 练习路由（屏 7 · 全屏，压过四 Tab）。
 * D-360：练习永远是「练某个东西」—— 入口都在对象上（讲次 / Vault 勾选），
 * 这里只记「现在在练什么」。
 */
export type PracticeOpen =
  /** 讲次认读（到期卡 · D-229 上限 40）或 Vault 勾选的随时测（I-097） */
  | { kind: 'reading'; lectureId?: number | null; ids?: number[] }
  /** 产出：今日/讲次按 lectureIds（结算会推进讲次排期）；Vault 勾选按 ids（D-012） */
  | { kind: 'production'; lectureIds?: number[]; ids?: number[] }

class PracticeState {
  open = $state<PracticeOpen | null>(null)
}

export const practice = new PracticeState()
