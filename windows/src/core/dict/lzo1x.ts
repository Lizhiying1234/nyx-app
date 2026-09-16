/**
 * LZO1X 解压 · D5.1a（2026-08-20）
 *
 * ══ 为什么要自己写 ★★ ══════════════════════════════════════
 *
 * 他那 22 本里有两本是老版 MDict（1.2），词块用 LZO1X 压缩：
 *
 *   21世纪英汉汉英双向词典.mdx        v1.2 · UTF-8 · 21.4 万词目
 *   朗文英文当代大词典（插图版).mdx    v1.2 · GBK  · 4.8 万词目
 *   朗文插图版的 .mdd（67 MB）        v1.2 · 1219 张插图
 *
 * 在这之前它们的设置页上写着「这本是老版 MDict（1.2 版，LZO 压缩），当前读不了」。
 * 解它只要一个解压器 —— 而 LZO1X 的解压端**只有一百来行**，
 * 加一个依赖反而更贵（授权、供应链、Android 端还要再找一份）。
 *
 * ══ 放在 core 的理由 ═══════════════════════════════════════
 *
 * 它是纯函数：进去一段字节，出来一段字节，零 I/O、零平台依赖。
 * Android 端照搬同一份（D-238），而且能被单元测试逐个分支钉死。
 *
 * ══ 格式（按 minilzo 的 `lzo1x_decompress`）═════════════════
 *
 * 流由「指令字节」驱动，每条指令要么是**一串原文**，要么是
 * **往回引用一段已经解出来的内容**（距离 + 长度）。四种匹配指令按
 * 首字节的取值分档（≥64 / ≥32 / ≥16 / <16），长度为 0 时用
 * 「连续的 0x00 各加 255」的方式续长。结尾是固定的 `0x11 0x00 0x00`。
 *
 * ★ 往回引用**允许重叠**（距离 1、长度 100 是合法的，效果是重复填充），
 *   所以只能逐字节拷，不能用 `copyWithin` 那种整段搬。这一条错了的话，
 *   短距离重复的内容会解成一片乱码 —— 而且只在**某些**词条上出现。
 */

/** 解不开时抛它 —— 上层按它给诊断，不把 V8 的报错扔给使用者 */
export class LzoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LzoError'
  }
}

/**
 * 解开一段 LZO1X 数据。
 *
 * @param src      压缩后的字节（**不含** MDict 那 8 字节块头）
 * @param expected 解压后应该有多少字节。MDict 的每个块头里都写着，
 *                 传进来可以一次分配到位，也能当一道校验。
 */
export function lzo1xDecompress(src: Uint8Array, expected?: number): Uint8Array {
  if (src.length === 0) return new Uint8Array(0)

  /** 输出缓冲。不知道大小就先按 4 倍猜，不够再翻倍 */
  let out = new Uint8Array(expected ?? Math.max(64, src.length * 4))
  let op = 0
  let ip = 0

  const need = (n: number): void => {
    if (op + n <= out.length) return
    if (expected !== undefined) {
      throw new LzoError(`解出来的比声明的长（声明 ${expected} 字节）`)
    }
    let size = out.length * 2
    while (size < op + n) size *= 2
    const bigger = new Uint8Array(size)
    bigger.set(out.subarray(0, op))
    out = bigger
  }

  const byteAt = (i: number): number => {
    if (i >= src.length) throw new LzoError('数据在中途就没了（截断或不是 LZO）')
    return src[i]!
  }

  /** 原样搬 n 个字节 */
  const literals = (n: number): void => {
    need(n)
    for (let i = 0; i < n; i++) out[op++] = byteAt(ip++)
  }

  /**
   * 往回引用：从 `from` 开始拷 n 个字节。
   * ★ **逐字节**拷 —— 重叠是合法的，而且很常见（距离 1 = 重复同一个字节）。
   */
  const copyBack = (from: number, n: number): void => {
    if (from < 0) throw new LzoError('往回引用越过了开头（数据坏了）')
    need(n)
    for (let i = 0; i < n; i++) out[op++] = out[from + i]!
  }

  /** 长度为 0 时的续长：连着的 0x00 每个加 255 */
  const extend = (base: number): number => {
    let t = 0
    while (byteAt(ip) === 0) {
      t += 255
      ip++
      if (t > 1 << 26) throw new LzoError('长度续得没完没了（数据坏了）')
    }
    return t + base + byteAt(ip++)
  }

  let t = 0
  /** 下一步该干什么 —— C 版里那几个 goto 标签 */
  let state: 'top' | 'firstLiteralRun' | 'match' | 'matchNext' = 'top'

  // ── 开头的特例：首字节 > 17 表示「先来一串原文」 ──────────
  if (byteAt(0) > 17) {
    t = byteAt(ip++) - 17
    if (t < 4) {
      state = 'matchNext'
    } else {
      literals(t)
      state = 'firstLiteralRun'
    }
  }

  for (;;) {
    if (state === 'top') {
      t = byteAt(ip++)
      if (t >= 16) {
        state = 'match'
      } else {
        // 一串原文。长度 0 要续长
        if (t === 0) t = extend(15)
        literals(t + 3)
        state = 'firstLiteralRun'
      }
    }

    if (state === 'firstLiteralRun') {
      t = byteAt(ip++)
      if (t >= 16) {
        state = 'match'
      } else {
        // M1：距离在 0x0801..0x1000，固定拷 3 个字节
        const from = op - 1 - 0x0800 - (t >> 2) - (byteAt(ip++) << 2)
        copyBack(from, 3)
        afterMatch()
        continue
      }
    }

    if (state === 'match') {
      if (t >= 64) {
        // M2：短距离、短长度，最常见
        const from = op - 1 - ((t >> 2) & 7) - (byteAt(ip++) << 3)
        copyBack(from, (t >> 5) - 1 + 2)
      } else if (t >= 32) {
        // M3：长度可续
        let len = t & 31
        if (len === 0) len = extend(31)
        const lo = byteAt(ip)
        const hi = byteAt(ip + 1)
        ip += 2
        const from = op - 1 - ((lo >> 2) + (hi << 6))
        copyBack(from, len + 2)
      } else if (t >= 16) {
        // M4：远距离；也是结尾标记 `0x11 0x00 0x00` 走的这一档
        let len = t & 7
        const far = (t & 8) << 11
        if (len === 0) len = extend(7)
        const lo = byteAt(ip)
        const hi = byteAt(ip + 1)
        ip += 2
        const back = (lo >> 2) + (hi << 6)
        if (far === 0 && back === 0) {
          // ★ 结尾。C 版里那句 `if (m_pos == op) goto eof_found`
          return out.subarray(0, op)
        }
        const from = op - far - back - 0x4000
        copyBack(from, len + 2)
      } else {
        // M1 的另一种写法：固定拷 2 个字节
        const from = op - 1 - (t >> 2) - (byteAt(ip++) << 2)
        copyBack(from, 2)
      }
      afterMatch()
      continue
    }

    if (state === 'matchNext') {
      literals(t)
      t = byteAt(ip++)
      state = 'match'
      continue
    }
  }

  /**
   * 每条匹配指令之后：低两位说「顺带还有几个原文字节」。
   * 0 = 没有，回去读下一条指令；1~3 = 先搬这几个字节，再接着读匹配指令。
   */
  function afterMatch(): void {
    const tail = byteAt(ip - 2) & 3
    if (tail === 0) {
      state = 'top'
      return
    }
    t = tail
    state = 'matchNext'
  }
}
