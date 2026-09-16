import { screen } from 'electron'

/**
 * ══ Nyx 说 DIP，UI Automation 说物理像素 ★★（2026-09-14 实测）═══════
 *
 * 使用者报的：「按快捷键后查到的词并不是鼠标当前位置下面的词。」
 * 追下去不是取词逻辑错，是**两边根本不在同一个坐标系里**。
 *
 * ── 量到的 ────────────────────────────────────────────────────
 * 他这台机器 **150% 缩放**（物理 2560×1600 / DIP 1707×1067，`scaleFactor 1.5`）。
 * 拿同一个窗口问两边：桌面那颗悬浮球我们建的是 **46 DIP**，
 * UIA 的 `BoundingRectangle` 报的是 **69** —— 69 = 46 × 1.5。**UIA 给的是物理像素。**
 *
 * ── 于是错在哪 ────────────────────────────────────────────────
 *   · 往外送：`screen.getCursorScreenPoint()` 是 DIP，直接交给 `RangeFromPoint`，
 *     UIA 当物理像素用 → 实际问的是屏幕上**左上方 2/3 处**那个点。
 *     所以越往右下角偏得越厉害，而在左上角附近几乎是对的 ——
 *     这正是「有时候对、有时候差得离谱」的来历。
 *   · 收回来：助手报的 `rect` 是物理像素，被当 DIP 拿去摆卡片 →
 *     卡片也落在偏左上的地方。（这条是 2026-09-14 白天刚加的锚点，
 *     一起错的，只是他先注意到取词那一头。）
 *
 * ── 为什么单独一份 ────────────────────────────────────────────
 * ★ 换算只许发生在**进程边界**这一处：Nyx 里面一律 DIP，助手那边一律物理像素。
 *   哪一层顺手换一下，就会有第二处忘了换，而错开的坐标**不报错**，
 *   只是查到旁边那个词 —— 这种错只能靠人眼发现，正是这一次的教训。
 * ★ 不自己乘 `scaleFactor`：多屏各有各的缩放，Electron 的这四个 API
 *   会按点所在的那块屏换算，自己乘就是在造第二份判据。
 *   （这四个 API 是 **Windows 专有**的，本仓只出 Windows 包，D-224。）
 */

/** DIP 点 → 物理像素点。**送给 UIA 助手之前**过这一道。 */
export const toPhysicalPoint = (p: { x: number; y: number }): { x: number; y: number } =>
  screen.dipToScreenPoint(p)

/**
 * 物理像素矩形 → DIP 矩形。**助手报上来之后**过这一道。
 * ★ 认不出来就交回 `undefined` —— 调用方本来就要处理「没有位置」这一档
 *   （退回鼠标位置），给一个换算错的框比没有框更糟。
 */
export function toDipRect(
  r: { x: number; y: number; w: number; h: number } | undefined
): { x: number; y: number; w: number; h: number } | undefined {
  if (!r) return undefined
  const d = screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h })
  return { x: d.x, y: d.y, w: d.width, h: d.height }
}
