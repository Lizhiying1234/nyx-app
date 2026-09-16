/**
 * 长按 action（D-379 P4：长按 = 进入多选）。
 * 450ms 不动（位移 < 12px）判长按；触发后吞掉随后的合成 click，
 * 免得「长按选中 → 抬手那记 click 又把它取消」。
 */
export function longpress(node: HTMLElement, cb: () => void): { destroy(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let x = 0
  let y = 0
  let fired = false

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const down = (e: PointerEvent): void => {
    fired = false
    x = e.clientX
    y = e.clientY
    clear()
    timer = setTimeout(() => {
      fired = true
      cb()
    }, 450)
  }
  const move = (e: PointerEvent): void => {
    if (Math.abs(e.clientX - x) > 12 || Math.abs(e.clientY - y) > 12) clear()
  }
  const up = (): void => clear()
  const click = (e: MouseEvent): void => {
    if (fired) {
      e.preventDefault()
      e.stopPropagation()
      fired = false
    }
  }

  node.addEventListener('pointerdown', down)
  node.addEventListener('pointermove', move)
  node.addEventListener('pointerup', up)
  node.addEventListener('pointercancel', up)
  node.addEventListener('click', click, true)
  return {
    destroy() {
      clear()
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      node.removeEventListener('pointercancel', up)
      node.removeEventListener('click', click, true)
    }
  }
}
