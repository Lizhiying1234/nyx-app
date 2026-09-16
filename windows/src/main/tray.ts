import { Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Assist 的桌面小图标（使用者 2026-09-13 提出 → **2026-09-14 重定**）
 *
 * ══ 他 09-14 把 09-13 那一版推翻了 ═══════════════════════════
 * 原话：
 * > 现在我不需要之前提出的四种状态、四个不同图标的方案。
 * > **完全移植 Android Assist 使用的桌面小图标**：Windows 和 Android 使用同一个
 * > Assist 小图标……不需要四个状态图标。
 * > 桌面上这个 Assist 小图标只负责：点击 → 开启 Assist，再次点击 → 关闭 Assist。
 * > 至于 Assist 当前到底使用 Glance 还是 Frame：**不通过桌面图标切换**，
 * > 用户在设置中进行模式选择。
 *
 * 所以这个文件这一轮**少了两样东西**，两样都是真删不是藏起来（D-457 要求先说清当初为什么撤）：
 *   ① 四张图（眼睛 / 取景框 × 开 / 关）→ 一枚衍射星的两档。
 *      撤的理由：模式现在只在设置里选，图标再分方式 = 在说一件它不再负责的事。
 *   ② 右键菜单里那两颗「切到 Glance / 切到 Frame」的 radio → 没了。
 *      撤的理由是他那句「**不通过桌面图标切换**」——
 *      留着等于给同一件事开第二个入口，而他刚刚点名把那个入口收回设置页。
 *
 * ★★ 同一天晚些时候他又说「**留 point 和 glance，原来的 frame 取消**」——
 *    于是「哪一种」这个维度**整个消失了**：这个文件里再没有 mode 的概念，
 *    只有开 / 关。上面②那条顺带变成了历史注脚。
 *
 * ══ 「桌面上」在 Windows 上落成什么（这一条没变）═══════════════
 * 桌面上那种 `.lnk` 快捷方式**改不了** —— 它是一个静态文件，没有任何办法
 * 让它跟着「现在开着没开着」变。能随状态变、又一直在眼前的，Windows 上
 * 只有**通知区域（托盘）那一枚**。★ 这是我替他做的一个翻译，不是他的原话，
 * 09-13 已经当面说过。
 *
 * ══ 点一下 = 开 / 关 ═════════════════════════════════════════
 * 2026-09-14 晚 Frame 取消之后，「开成哪一种」这个问题没了：方式只剩一种，
 * 开就是开。（它曾经读 `glance.lastMode()` —— 那个键现在退役只读。）
 */

export type TrayState = {
  /** 他想要开着吗 */
  on: boolean
  /** 真的在跑吗 —— 图标画的是**真状态**，不是我们想要的状态 */
  running: boolean
}

export interface TrayHooks {
  /** 点一下：开着就关掉，关着就开回上一次那一种 */
  toggle: () => void
  /** 打开主窗口 */
  open: () => void
  /** 退出 */
  quit: () => void
}

let tray: Tray | null = null

/** 两张图在哪 —— 开发时在仓里，打包后在 `<软件>/resources/assist/` */
function iconPath(resourcesDir: string, on: boolean): string {
  const name = `assist-${on ? 'on' : 'off'}.png`
  const packed = join(resourcesDir, 'assist', name)
  if (existsSync(packed)) return packed
  return join(process.cwd(), 'resources', 'assist', name)
}

/**
 * 图标之外还有一句话：托盘图标只有 16 像素，再怎么设计也只能说个大概。
 * 所以 tooltip 把状态**写成字**。图是给一眼扫的，字是给确认的。
 *
 * ★ 2026-09-14 晚 Frame 取消之后，「哪一种」这个维度整个没了 —— 只剩开 / 关。
 */
function label(on: boolean): string {
  return on ? 'Nyx Assist · 开着（点一下关）' : 'Nyx Assist · 没开（点一下开）'
}

/**
 * 建 / 更新那一枚。**幂等**：状态变了就调它，不用管之前有没有建过。
 *
 * ★ 图标文件不在就**不建托盘**，而不是建一枚空白的 ——
 *   一枚看不见的托盘图标比没有更糟：他会以为是自己眼花。
 */
export function syncTray(resourcesDir: string, state: TrayState, hooks: TrayHooks): void {
  const on = state.on && state.running
  const file = iconPath(resourcesDir, on)
  if (!existsSync(file)) {
    destroyTray()
    return
  }
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) {
    destroyTray()
    return
  }

  if (!tray || tray.isDestroyed()) {
    tray = new Tray(img)
    /**
     * ★★ 左键点一下 = **开 / 关 Assist**（使用者 2026-09-14）。
     *   09-13 这里是「打开主窗口」—— 那是 Windows 上托盘的通行做法，
     *   但他这一轮给了这枚图标一个明确职责，而那个职责不是当快捷方式用。
     *   「打开 Nyx」还在右键菜单里。
     */
    tray.on('click', () => hooks.toggle())
  } else {
    tray.setImage(img)
  }

  const text = label(on)
  tray.setToolTip(text)
  /** 验收读得到「这一枚现在代表什么」—— Electron 没有列出托盘的 API */
  ;(globalThis as unknown as { __nyxTray?: string }).__nyxTray = text
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: text, enabled: false },
      { type: 'separator' },
      /**
       * ★ 只有一颗开关，**没有模式选择** —— 见文件头②。
       *   文案跟着状态走，而不是「切换 Assist」这种要他自己推算结果的说法。
       */
      { label: on ? '关掉 Assist' : '开启 Assist', click: () => hooks.toggle() },
      { type: 'separator' },
      { label: '打开 Nyx', click: () => hooks.open() },
      { label: '退出 Nyx', click: () => hooks.quit() }
    ])
  )
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}
