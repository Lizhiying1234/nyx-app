/**
 * 被截断的 JSON，能救回多少算多少 · I-115
 *
 * ── 事情是怎么暴露的 ──────────────────────────────────────
 *
 * 使用者的两份材料都分析失败，界面上是两行他看不懂的英文：
 *
 *     Expected ',' or ']' after array element in JSON at position 23050
 *     Expected ',' or '}' after property value in JSON at position 27975
 *
 * 这两句正是**回复在中途断掉**的形状（试过：`'[1,2'` 报前者，`'{"a":1'` 报后者）。
 * 模型输出到 `max_tokens` 就被切了，JSON 少了收尾的括号。
 *
 * 而当时的做法是：解析失败 → 整份材料判为失败 → **已经拿到的几十条一起丢掉**。
 * 他看到的是「这份材料没能分析成功」，而实际上 AI 已经干完了八成的活。
 *
 * ── 判据 ────────────────────────────────────────────────
 *
 * 截断的 JSON 有一个好性质：**断点之前的部分是完整且正确的**。
 * 所以只要找到「最后一个已经写完的值」在哪儿，把它之后的残缺片段切掉，
 * 再把还开着的括号补上，就能拿回前面全部内容。
 *
 * 这不是「猜模型想写什么」—— 一个字都不猜，只做两件事：
 * **切掉写了一半的，补上没关的括号。**
 *
 * 纯逻辑，不碰网络、不碰数据库（D-238）。
 */

export interface LooseParse<T> {
  value: T
  /** 是不是修过。false = 原样就能解析 */
  repaired: boolean
  /** 丢掉了多少个字符（都是写了一半的残片） */
  dropped: number
}

/** 一个可以下刀的位置 */
interface Cut {
  /** 切在哪儿（下标 + 1） */
  end: number
  /** 切在那儿时还开着的括号 */
  stack: string[]
}

interface Scan {
  /**
   * 最后一个**闭合的括号**。首选切点。
   *
   * 为什么首选它而不是「最后一个写完的值」：断点前面那个对象往往
   * 只写了一半 —— `{"term":"c"` 有词条却没有释义、没有出处。
   * 把它留下来会造出一条残缺的知识点，**比丢掉更糟**：
   * 他会在库里看到一个没有释义的词，而且不知道为什么。
   * 一个元素要么完整地进来，要么根本不进来。
   */
  lastClose: Cut
  /** 退而求其次：最后一个写完的值。整份回复里一个括号都没闭合时才用 */
  lastValue: Cut
}

/**
 * 从头扫一遍，记下两个可下刀的位置。
 * **字符串内部一律不算** —— 那里的 `}` 是内容，不是结构。
 */
function scan(s: string): Scan {
  const stack: string[] = []
  const st: Scan = {
    lastClose: { end: 0, stack: [] },
    lastValue: { end: 0, stack: [] }
  }
  let inStr = false
  let esc = false
  /** 正在读一个裸值（数字 / true / false / null） */
  let bare = false

  const markValue = (i: number): void => {
    st.lastValue = { end: i + 1, stack: [...stack] }
  }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!

    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') {
        inStr = false
        // 字符串写完了 —— 但如果它是个键名，后面还得跟值，不算写完一个值。
        // 用「下一个非空白字符是不是冒号」来分辨。
        const next = s.slice(i + 1).match(/^\s*(.)/)?.[1]
        if (next !== ':') markValue(i)
      }
      continue
    }

    if (bare && !/[\w.+-]/.test(c)) {
      bare = false
      markValue(i - 1)
    }

    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{' || c === '[') {
      stack.push(c)
      continue
    }
    if (c === '}' || c === ']') {
      stack.pop()
      st.lastClose = { end: i + 1, stack: [...stack] }
      markValue(i)
      continue
    }
    if (!bare && /[\w.+-]/.test(c)) bare = true
  }
  // 结尾正好是个裸值（`…,"n":12` 这种）
  if (bare) markValue(s.length - 1)
  return st
}

/**
 * 解析 JSON；断掉的话把能救的救回来。
 *
 * @throws 连一个完整的值都凑不出来时才抛 —— 那说明拿到的根本不是 JSON。
 */
export function parseLoose<T>(raw: string): LooseParse<T> {
  const body = raw.trim()
  try {
    return { value: JSON.parse(body) as T, repaired: false, dropped: 0 }
  } catch {
    /* 往下走修复 */
  }

  const st = scan(body)
  const at = st.lastClose.end > 0 ? st.lastClose : st.lastValue
  if (at.end === 0) {
    throw new SyntaxError('这段文字里没有一个写完整的 JSON 值')
  }

  // 切到那儿，去掉可能悬着的逗号，再把还开着的括号补上
  let cut = body.slice(0, at.end).replace(/,\s*$/, '')
  for (let i = at.stack.length - 1; i >= 0; i--) {
    cut += at.stack[i] === '{' ? '}' : ']'
  }

  return { value: JSON.parse(cut) as T, repaired: true, dropped: body.length - at.end }
}
