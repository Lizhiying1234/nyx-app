/**
 * 「这个库还是长在原来那台机器上吗」的**判据** · F-009（2026-09-01）
 *
 * ── 背景 ──────────────────────────────────────────────────
 *
 * 同步的设备编号存在库里（`settings['sync.device']`），而 Android 的自动备份
 * 会把整个库恢复到另一台机器上。不换号的话两台同号，`planTodo` 会让它们
 * **各自跳过对方的全部包** —— 永远收不到对方的数据，两边都显示「同步成功，收到 0 行」。
 * 不报错、不算失败、体检也不亮，正是本项目定义的最贵失败形态。
 *
 * ── 判据在这里，动作在平台侧 ──────────────────────────────
 *
 * 这个文件只回答「该不该换号、换了之后旧号怎么办」。
 * 「本机标识怎么取」是平台的事（Android = ANDROID_ID，它不跟着备份走）。
 *
 * ★ Windows 目前不调它 —— 那边没有「把库恢复到另一台机器」这条自动路径。
 *   放在 core 是因为**判据只能有一份**：哪天 Windows 也要防撞，不该再写第二遍。
 */

export interface RebindFacts {
  /** 平台读到的本机标识。取不到就是空串 */
  hardwareId: string
  /** 上次记下来的本机标识（`settings['sync.deviceHw']`）。第一次运行是空串 */
  knownHardwareId: string
  /** 当前设备编号（`settings['sync.device']`）。还没铸过是空串 */
  device: string
  /** 已经退休的编号（`settings['sync.formerDevices']`） */
  formerDevices: readonly string[]
}

export type RebindAction =
  /** 什么都不做 */
  | { kind: 'none' }
  /** 只记一下本机标识（老库第一次运行，或还没铸过号）—— 不换号 */
  | { kind: 'remember'; hardwareId: string }
  /** 换号：这个库是从别的机器恢复来的 */
  | {
      kind: 'rebind'
      hardwareId: string
      /** 退休的那个号（连同它以前的历史）—— 它推过的包仍要跳过 */
      formerDevices: readonly string[]
      /** 如实说一句，不静默（D-409） */
      message: string
    }

/** 历史编号留多少个就够了 —— 换机是罕见事件，留 10 个远超实际需要 */
export const MAX_FORMER_DEVICES = 10

export function planRebind(f: RebindFacts): RebindAction {
  const hw = f.hardwareId.trim()

  /**
   * ★ 读不到本机标识（取不到、平台不支持）→ **什么都不做**。
   *   「说不清」不是「换机了」。在没有证据的时候换号，等于每次开库都换一个号，
   *   那比原来的问题更糟。
   */
  if (hw === '') return { kind: 'none' }

  const known = f.knownHardwareId.trim()

  // 第一次记 —— 老库升上来，或者全新库还没同步过
  if (known === '') return { kind: 'remember', hardwareId: hw }

  // 还是原来那台
  if (known === hw) return { kind: 'none' }

  /**
   * 换机了。但如果还没铸过号（从没同步过），那就没什么好退休的 ——
   * 只更新标识即可，下次同步会正常铸一个新号。
   */
  const old = f.device.trim()
  if (old === '') return { kind: 'remember', hardwareId: hw }

  /** 旧号排在最前（最近退休的最可能还有包在云端），去重后截断 */
  const formers = [old, ...f.formerDevices.filter((d) => d.trim() !== '' && d !== old)].slice(
    0,
    MAX_FORMER_DEVICES
  )

  return {
    kind: 'rebind',
    hardwareId: hw,
    formerDevices: formers,
    message:
      '这份数据是从另一台设备恢复过来的，已经给这台机器换了一个新的设备编号。' +
      '两台设备用同一个编号的话，它们会各自把对方的更新当成自己的跳过去 —— ' +
      '那样两边都显示同步成功，实际上谁也收不到谁的。数据一条都没动。'
  }
}
