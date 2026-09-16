/**
 * RIPEMD-128 · MDict 索引段解混淆要用（I-031 → D-401 词典批搬入 core）
 *
 * 与 `main/dict/ripemd128.ts` 同一份算法，只把 Buffer 换成 Uint8Array/DataView
 * （纯数学，零 I/O —— 两端共用；main 侧现在是 re-export 门面）。
 *
 * **为什么要自己写**：Node 的 crypto 没有 ripemd128（连 ripemd160 在新版 OpenSSL 里
 * 也被移出默认集了），而 MDict 的 `Encrypted=2` 恰恰用它派生固定密钥。
 * 算法是公开标准（Dobbertin/Bosselaers/Preneel, 1996），照着写就行，不用引依赖。
 *
 * MDict 有两种「加密」——
 *   `Encrypted & 1` = **需要使用者的注册码**，付费词典的授权，本项目不碰
 *   `Encrypted & 2` = 索引段用一个**写死的公开算法**混淆，没有任何用户密钥
 * 后者是格式的一部分（每个 MDict 阅读器都实现了它），不是访问控制。
 */

const RL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2
]
const RR = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14
]
const SL = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12
]
const SR = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8
]

const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc]
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000]

const rol = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0

function f(j: number, x: number, y: number, z: number): number {
  if (j < 16) return (x ^ y ^ z) >>> 0
  if (j < 32) return ((x & y) | (~x & z)) >>> 0
  if (j < 48) return ((x | ~y) ^ z) >>> 0
  return ((x & z) | (y & ~z)) >>> 0
}

export function ripemd128(input: Uint8Array): Uint8Array {
  // 补位：0x80，然后补 0 到 56 mod 64，最后 8 字节是比特长度（小端）
  const bitLen = BigInt(input.length) * 8n
  const padLen = ((((55 - input.length) % 64) + 64) % 64) + 1
  const msg = new Uint8Array(input.length + padLen + 8)
  msg.set(input, 0)
  msg[input.length] = 0x80
  const mv = new DataView(msg.buffer)
  mv.setUint32(msg.length - 8, Number(bitLen & 0xffffffffn), true)
  mv.setUint32(msg.length - 4, Number((bitLen >> 32n) & 0xffffffffn), true)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476

  const X = new Array<number>(16)
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = mv.getUint32(off + i * 4, true)

    let al = h0, bl = h1, cl = h2, dl = h3
    let ar = h0, br = h1, cr = h2, dr = h3

    for (let j = 0; j < 64; j++) {
      const round = j >> 4
      let t = (al + f(j, bl, cl, dl) + X[RL[j]!]! + KL[round]!) >>> 0
      t = rol(t, SL[j]!)
      al = dl
      dl = cl
      cl = bl
      bl = t

      // 右线用**倒过来的**轮函数
      t = (ar + f(63 - j, br, cr, dr) + X[RR[j]!]! + KR[round]!) >>> 0
      t = rol(t, SR[j]!)
      ar = dr
      dr = cr
      cr = br
      br = t
    }

    const t = (h1 + cl + dr) >>> 0
    h1 = (h2 + dl + ar) >>> 0
    h2 = (h3 + al + br) >>> 0
    h3 = (h0 + bl + cr) >>> 0
    h0 = t
  }

  const out = new Uint8Array(16)
  const ov = new DataView(out.buffer)
  ov.setUint32(0, h0, true)
  ov.setUint32(4, h1, true)
  ov.setUint32(8, h2, true)
  ov.setUint32(12, h3, true)
  return out
}

/**
 * MDict `Encrypted & 2` 的索引解混淆。
 * 密钥由**块自己的校验和**派生，全过程没有任何用户输入 —— 它是格式，不是锁。
 */
export function mdxDecryptKeyInfo(block: Uint8Array): Uint8Array {
  // 前 8 字节是「压缩类型 + 校验和」，混淆只作用在后面的数据上
  const seed = new Uint8Array(8)
  seed.set(block.subarray(4, 8), 0)
  seed.set([0x95, 0x36, 0x00, 0x00], 4)
  const key = ripemd128(seed)
  const data = new Uint8Array(block.subarray(8)) // 复制 —— 不改原块
  let prev = 0x36
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!
    let t = ((b >> 4) | (b << 4)) & 0xff
    t = t ^ prev ^ (i & 0xff) ^ key[i % key.length]!
    prev = b
    data[i] = t
  }
  const out = new Uint8Array(block.length)
  out.set(block.subarray(0, 8), 0)
  out.set(data, 8)
  return out
}
