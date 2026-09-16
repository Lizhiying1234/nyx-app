/**
 * SHA-256 —— ★★ **这个文件不许 import 任何 Capacitor 插件。**
 *
 * 为什么单独拆出来（2026-09-01 · F-003 后台同步）：
 * 同步引擎的结构指纹要用它，而引擎现在有**两处装配** ——
 * App 的 WebView（`sync-ports.ts`，Capacitor 端口）与
 * 无障碍服务的无头 WebView（`engine/main.ts`，原生端口）。
 * 后者跑在**没有 Capacitor 桥**的页面里，import 到插件就会炸。
 *
 * ★★★ 而两处算出的指纹必须**逐位相同** —— 不同的话每个包都被结构闸拒掉，
 * 同步彻底瘫痪，**而且「不丢数据」，所以不会有人立刻发现**。
 * 所以它只能有一份，且不带任何依赖。S-4 单测钉着两条路（subtle / 纯 JS）算出同一个值。
 */

/**
 * 纯 JS SHA-256 —— http origin（androidScheme http）下没有 `crypto.subtle`。
 * 标准 FIPS 180-4 常量与轮函数；有 subtle 时优先用它（两条路算出的指纹
 * 必须一致 —— S-4 单测钉着）。
 */
export function sha256Pure(bytes: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ])
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const l = bytes.length
  const bitLen = l * 8
  const padded = new Uint8Array((((l + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[l] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, bitLen >>> 0)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000))
  const w = new Uint32Array(64)
  const rr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15]!, 7) ^ rr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rr(w[i - 2]!, 17) ^ rr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H as unknown as number[]
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e!, 6) ^ rr(e!, 11) ^ rr(e!, 25)
      const ch = (e! & f!) ^ (~e! & g!)
      const t1 = (h! + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rr(a!, 2) ^ rr(a!, 13) ^ rr(a!, 22)
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d! + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0]! + a!) >>> 0; H[1] = (H[1]! + b!) >>> 0
    H[2] = (H[2]! + c!) >>> 0; H[3] = (H[3]! + d!) >>> 0
    H[4] = (H[4]! + e!) >>> 0; H[5] = (H[5]! + f!) >>> 0
    H[6] = (H[6]! + g!) >>> 0; H[7] = (H[7]! + h!) >>> 0
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]!)
  return out
}

export async function sha256hex16(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest =
    typeof crypto !== 'undefined' && crypto.subtle
      ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      : sha256Pure(bytes)
  return [...digest]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

