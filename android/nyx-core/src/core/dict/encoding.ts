/**
 * MDict 的字符编码 · D5.1b（2026-08-20）
 *
 * ══ 为什么要单独一个模块 ★★★ ═══════════════════════════════
 *
 * 因为**同一件事这个仓库里有两份互相矛盾的答案**：
 *
 *   `mdict.ts`（真正读词的那条路）   enc.includes('16') ? utf16le : utf8   → GBK 当成 UTF-8
 *   `mdict-header.ts`（体检那条路）  …includes('GBK') ? 'gbk' : …          → GBK 认出来了
 *
 * 于是设置页上写着「GBK」，读词的时候却按 UTF-8 解 —— 两句话都由软件自己说出口，
 * 互相打架，而且**谁都不会报错**。他手上那本 GBK（朗文插图版）正文 27.3 MB 里
 * 一个 >= 0x80 的字节都没有，所以这个矛盾在他机器上**永远看不见**，
 * 直到某天他放进来第二本 GBK 词典 —— 那天满屏乱码，而两条路都还是「正常」的。
 *
 * 判断编码是**纯逻辑**，不碰文件也不碰界面：按 D-238 放进 core，两端共用一份。
 *
 * ══ GBK 的框架和 UTF-8 一模一样（这条是承重的）★★ ═════════
 *
 * MDict 的词表是「记录偏移 + 词 + NUL」。GBK 双字节的取值范围是
 * 首字节 0x81–0xFE、次字节 0x40–0xFE（不含 0x7F）——**没有任何一个字节是 0x00**，
 * 也没有一个落在 ASCII 的控制区。所以：
 *
 *   · 结尾 NUL 还是**一个字节**（UTF-16 才是两个）
 *   · 索引里的长度字段还是**字节数**（UTF-16 那边要乘 2）
 *
 * 也就是说 GBK 只差**解码这一步**，一处框架都不用动。
 * 反过来说，UTF-16 差的正是框架那两处 —— 那是 D5.1c 的事，这次一个字都不碰。
 */

/** 解析器认得的三种编码。`gbk` 一档同时覆盖 GB2312 / GB18030（解码表向下兼容） */
export type MdictEncoding = 'utf8' | 'utf16le' | 'gbk'

/**
 * 头部 `Encoding="…"` → 用哪种编码解。**这是唯一一处判断**。
 *
 * @param declared 头部原文（没声明就是空串或 undefined）
 * @param opts.mdd 这是资源包 .mdd —— 它的头部里根本没有 `Encoding`，
 *                 键一律 UTF-16LE（实测朗文插图版那本 1.2 的 .mdd 就是）
 */
export function pickMdictEncoding(
  declared: string | null | undefined,
  opts: { mdd?: boolean } = {}
): MdictEncoding {
  if (opts.mdd) return 'utf16le'
  const s = (declared ?? '').toUpperCase().replace(/[\s_-]/g, '')
  // GB 系先判：GB18030 里没有 "16" 这两个字，但别指望下一个厂商也这么客气
  if (s.startsWith('GB')) return 'gbk'
  if (s.includes('16')) return 'utf16le'
  return 'utf8'
}

/** 词表里那个结尾 NUL 有几个字节。见文件头「框架」一节 */
export function keyTerminatorBytes(enc: MdictEncoding): 1 | 2 {
  return enc === 'utf16le' ? 2 : 1
}

/**
 * 索引里「首词 / 尾词」占几个字节。
 *
 * @param len 索引里写着的那个长度数（UTF-16 是字符数，其余是字节数）
 * @param pad 结尾符占几个「长度单位」—— 2.0 版有、1.2 版没有
 */
export function keyTextBytes(len: number, enc: MdictEncoding, pad: number): number {
  return enc === 'utf16le' ? (len + pad) * 2 : len + pad
}

/**
 * 一条正文到哪儿结束 · D5.1c
 *
 * MDict 的每条正文后面跟一个结尾 NUL。取正文的时候只知道「从哪个偏移开始」，
 * 结束位置要么是下一条的偏移，要么就靠这个 NUL。
 *
 * ★★★ UTF-16 里**每个 ASCII 字符自带一个 0x00**（`b` = `62 00`）——
 *   照 UTF-8 那样「找第一个 0 字节」，`brunt` 会在第 2 个字节就被切断，
 *   屏幕上只剩一个 `b`。而且**不报错**：它看起来就是「这本词典这条没什么内容」。
 *
 * ★ 只在**偶数位**上找双 NUL。这一条是承重的：
 *   `A` + `Ā` 编出来是 `41 00 00 01` —— 第 1、2 个字节确实是两个 0，
 *   但那是两个字符的腰，不是结尾。对齐一卡，它就不是结尾了。
 */
export function trimBodyTerminator(bytes: Uint8Array, enc: MdictEncoding): Uint8Array {
  if (keyTerminatorBytes(enc) === 1) {
    const i = bytes.indexOf(0)
    return i >= 0 ? bytes.subarray(0, i) : bytes
  }
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) return bytes.subarray(0, i)
  }
  return bytes
}

let gbk: TextDecoder | null | undefined

/**
 * 解 GBK。
 *
 * ★ 非法字节走 `TextDecoder` 的默认策略（换成 U+FFFD），**不抛** ——
 *   一本词典里有几个坏字节不该让整本读不了，他要的是尽量看到内容。
 * ★ 运行时要是根本不认得 GBK（小 ICU 的 Node），这里**明说**，
 *   不去 latin1 兜底 —— 兜底出来的是一屏乱码，而他会以为词典就长那样。
 */
export function decodeGbk(bytes: Uint8Array): string {
  if (gbk === undefined) {
    try {
      gbk = new TextDecoder('gbk')
    } catch {
      gbk = null
    }
  }
  if (!gbk) {
    throw new Error(
      '这个运行时不认得 GBK 编码（缺 ICU 数据），这本 GBK 词典读不了。\n' +
        '换一本 UTF-8 的，或者告诉我，我把 GBK 码表打进包里。'
    )
  }
  return gbk.decode(bytes)
}
