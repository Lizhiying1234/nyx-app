/**
 * 拖动排序（D-361：拖动 = 排序，同类 + 同父，不跨级）。
 *
 * ══ 手感契约 ═══════════════════════════════════════════════
 * · 长按 450ms 抬起一行（D-379 P4：按住拖 = 排序）；抬起后页面不再滚动
 * · ★ 拖不动的目标**在拖的过程中就看得出来**：同组行保持原样，
 *   非同组（别的层级 / 别的父级）全部压暗 —— 判据在视觉上，不在失败提示里
 * · 插入位置 = 目标行上/下半的一条 2px 墨线
 * · 松手落位 → 上层拿到同组新顺序（判据 reorder 在 manage-nodes，跨父拒收兜底）
 *
 * 用法：`use:dragRow={{ group, id, siblings: () => ids }}`，
 * Atlas 在 `setDropHandler` 里收 `(group, newIds)`。
 */

export interface DragActive {
  group: string
  id: number
  /** 悬在谁上面（同组 sibling id）；null = 无效位置 */
  overId: number | null
  /** 插到它前面还是后面 */
  before: boolean
}

class DragState {
  active = $state<DragActive | null>(null)
}
export const drag = new DragState()

let dropHandler: ((group: string, newIds: number[]) => void) | null = null
export function setDropHandler(fn: typeof dropHandler): void {
  dropHandler = fn
}

interface Opts {
  group: string
  id: number
  /** 当前渲染顺序里的同组 id 列表（松手时按它算新序） */
  siblings: () => number[]
}

export function dragRow(node: HTMLElement, opts: Opts): { destroy(): void; update(o: Opts): void } {
  let o = opts
  let timer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0
  let dragging = false
  let pid = -1

  node.setAttribute('data-dgroup', o.group)
  node.setAttribute('data-did', String(o.id))

  const blockScroll = (e: TouchEvent): void => {
    if (dragging) e.preventDefault()
  }

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const findTarget = (x: number, y: number): { id: number; before: boolean } | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-dgroup]') as HTMLElement | null
    if (!el || el.getAttribute('data-dgroup') !== o.group) return null
    const tid = Number(el.getAttribute('data-did'))
    if (!Number.isFinite(tid)) return null
    const r = el.getBoundingClientRect()
    return { id: tid, before: y < r.top + r.height / 2 }
  }

  const move = (e: PointerEvent): void => {
    if (!dragging) {
      if (Math.abs(e.clientX - startX) > 12 || Math.abs(e.clientY - startY) > 12) clear()
      return
    }
    const t = findTarget(e.clientX, e.clientY)
    drag.active = { group: o.group, id: o.id, overId: t?.id ?? null, before: t?.before ?? false }
  }

  const finish = (commit: boolean): void => {
    clear()
    if (!dragging) return
    dragging = false
    document.removeEventListener('touchmove', blockScroll)
    const a = drag.active
    drag.active = null
    if (!commit || !a || a.overId === null || a.overId === a.id) return
    const ids = o.siblings().filter((x) => x !== a.id)
    const at = ids.indexOf(a.overId)
    if (at < 0) return
    ids.splice(a.before ? at : at + 1, 0, a.id)
    dropHandler?.(o.group, ids)
  }

  const down = (e: PointerEvent): void => {
    startX = e.clientX
    startY = e.clientY
    pid = e.pointerId
    clear()
    timer = setTimeout(() => {
      dragging = true
      try {
        node.setPointerCapture(pid)
      } catch {
        /* 指针已释放就算了 —— 拖这一次作罢 */
      }
      document.addEventListener('touchmove', blockScroll, { passive: false })
      drag.active = { group: o.group, id: o.id, overId: null, before: false }
    }, 450)
  }
  const up = (): void => finish(true)
  const cancel = (): void => finish(false)
  const click = (e: MouseEvent): void => {
    // 拖完的抬手会补一记 click —— 吞掉，别当成「进入讲次」
    if (drag.active || dragging) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  node.addEventListener('pointerdown', down)
  node.addEventListener('pointermove', move)
  node.addEventListener('pointerup', up)
  node.addEventListener('pointercancel', cancel)
  node.addEventListener('click', click, true)
  return {
    update(next: Opts) {
      o = next
      node.setAttribute('data-dgroup', o.group)
      node.setAttribute('data-did', String(o.id))
    },
    destroy() {
      clear()
      document.removeEventListener('touchmove', blockScroll)
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('click', click, true)
    }
  }
}
