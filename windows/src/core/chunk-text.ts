/**
 * 长材料切成几段分析 · I-115
 *
 * ── 为什么必须切 ──────────────────────────────────────────
 *
 * 他两份材料是 24379 和 28189 个字符。一次喂进去，模型要为**整篇**列出
 * 所有值得学的表达 —— 输出轻松超过 `max_tokens`，于是回复在半路被切断。
 *
 * 光把截断的部分救回来（`json-repair.ts`）是不够的：**重试还会断在同一处**，
 * 后半篇的表达他永远拿不到。所以要从源头改：**分几次分析，每次只喂一段。**
 *
 * 这和 D-063 修订是同一个道理 ——「每份材料独立分析，结果层面合并去重」，
 * 那条的理由是「五份材料合起来十几万字会撑爆上下文」。
 * 一份材料两万八千字，是同一件事的另一个刻度。
 *
 * ── 在哪儿切 ──────────────────────────────────────────────
 *
 * **只在空行处切**（段落边界）。不在句子中间切 ——
 * 切断一个句子会让那一段的最后一条和下一段的第一条都失去语境，
 * 而语境正是判断「这个表达值不值得学」的依据。
 *
 * 一个段落本身就超长时，退而求其次在句号后切；再不行才硬切。
 * 硬切**不是不可能**（有人贴进来的整篇没有一个换行），所以必须有这条兜底 ——
 * 少了它，那种材料会变成一个永远处理不了的死角。
 *
 * 纯逻辑（D-238）。
 */

/** 一段最多多少字符 · D-266。超过这个数的材料才切 */
export const CHUNK_LIMIT = 6000

/**
 * 会切成几段的**下界** · D-266。
 *
 * 注意是下界不是准数：段落是**不可再分的整块**，
 * 一段 1400 字的段落塞不进只剩 800 字空间的块里，那块就得提前收口。
 * 所以实际段数 = 这个下界，或者多 1～2 段 —— 由段落长短决定，不是算法差。
 * 2000 次随机材料实测：约三分之二命中下界，其余多 1～2 段；
 * 使用者手上那五份原文**全部命中下界**（讲稿的段落短，装得满）。
 */
export const chunkCount = (len: number): number => Math.max(1, Math.ceil(len / CHUNK_LIMIT))

/**
 * @param text  原文
 * @param limit 一段最多多少字符。默认 `CHUNK_LIMIT`
 */
export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
  const t = text.trim()
  if (!t) return []
  if (t.length <= limit) return [t]

  /**
   * 两趟。
   *
   * 第一趟**尽量装满**（目标就是上限），得到的段数就是这份材料能做到的最少段数 ——
   * 段落是不可再分的整块，所以最少段数未必等于 `⌈总长 ÷ 6000⌉`，
   * 可能多一两段，这是段落边界决定的，不是算法差。
   *
   * 第二趟按这个段数**均分**，让每段长度接近，不留几百字的尾巴 ——
   * 一段就是一次 AI 调用，为 300 字单花一次钱不划算。
   * 均分要是反而装出更多段（同样是边界挤的），就退回第一趟那份。
   *
   * ★ 第一版把这两趟写反了：段数多了却去**缩小**目标，越算越碎 ——
   * 2000 次随机材料里 612 次比规则多出段数。方向错的收敛比不收敛更糟。
   */
  const packed = pack(t, 1, limit) // target 会被 limit 兜住，等价于「尽量装满」
  const balanced = pack(t, packed.length, limit)
  return balanced.length <= packed.length ? balanced : packed
}

/** 按「切成 n 段」的目标打包，每段不超过 limit */
function pack(t: string, n: number, limit: number): string[] {
  // n=1 时 target 会等于全文长度 —— 用 limit 兜住，那一趟就是「尽量装满」
  const target = Math.min(limit, Math.ceil(t.length / n))

  // ① 先按空行切成段
  const paras = t.split(/\n\s*\n/).filter((p) => p.trim())
  const units: string[] = []
  for (const p of paras) {
    if (p.length <= target) {
      units.push(p)
      continue
    }
    // ② 段落自己就超长 —— 在句末切
    let rest = p
    while (rest.length > target) {
      // 变量别叫 window —— core/ 的纯度闸会把它当成浏览器全局对象拦下来（它抓到过一次）
      const head = rest.slice(0, target)
      // 从后往前找最后一个句末（`. ! ?` 后面跟空白）
      const at = Math.max(
        head.lastIndexOf('. '),
        head.lastIndexOf('! '),
        head.lastIndexOf('? '),
        head.lastIndexOf('。'),
        head.lastIndexOf('！'),
        head.lastIndexOf('？')
      )
      // ③ 连句号都没有（整篇一句话）—— 硬切。丑，但不能卡住
      const cut = at > target * 0.3 ? at + 1 : target
      units.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut)
    }
    if (rest.trim()) units.push(rest.trim())
  }

  /**
   * ④ 把相邻的小段并回去。两条判据，缺一不可：
   *   · **没到均分目标就继续装** —— 这条让段数落在 `⌈总长 ÷ 6000⌉`，
   *     也就让「会切成几段」变成一句能写下来的话
   *   · **但绝不越过硬上限** —— 上限才是「不会被截断」的保证，
   *     均分目标只是为了段数好看
   */
  const out: string[] = []
  let cur = ''
  for (const u of units) {
    if (!cur) {
      cur = u
      continue
    }
    const merged = cur.length + u.length + 2
    if (merged <= limit && cur.length < target) {
      cur += '\n\n' + u
    } else {
      out.push(cur)
      cur = u
    }
  }
  if (cur) out.push(cur)
  return out
}
