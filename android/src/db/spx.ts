/**
 * 词典里的 `.spx` 发音 —— **Ogg 拆包 + Speex 解码**（使用者 2026-09-13）
 *
 * ══ 为什么需要它 ════════════════════════════════════════════
 * 使用者：「这个词典应该是有语音资源的，用其他软件能听出来，用 Nyx 听不出来」。
 * 属实，而且原因不是资源缺失，是**格式**：
 *   LDOCE5 的 18.4 万条发音全是 **Speex**（`.spx`），
 *   而 Chromium 早就删掉了 Speex 解码、Android 的 MediaCodec 也从来没有。
 *   别的词典软件放得响，是因为它们**自带解码器**。
 * 所以这里自带一个（`@caitun/speex`：MIT · 零依赖 · 5 KB 封装 + 161 KB libspeex WASM）。
 * ★ 那个包只解**裸帧**，而 `.spx` 是 Ogg 封装的 —— 这个文件补的就是中间那一层。
 *
 * ══ 真机上那本词典里的文件长什么样（量过，不是查文档）══════════
 *   OggS … Speex 1.2rc1 · rate 22050 · mode 1（宽带）· 单声道
 *   frame_size 320 · vbr 1 · **frames_per_packet 1**
 * 最后那个数很要紧：那个包的 API 一次只解一帧，
 * 每包多于一帧就对不上 —— 这本正好是 1。**别把它当成普遍成立**：
 * 遇到 >1 的文件这里会如实说「这一档还没支持」，不会悄悄只播前 1/N。
 *
 * ══ 为什么解完拼成 WAV，而不是走 WebAudio ════════════════════
 * `tts.ts` 里「一个喇叭、新的一声掐掉上一声」是靠共用一个 `Audio` 对象做到的。
 * 再开一条 AudioContext 管线就会两处各响各的。拼成 WAV 之后，
 * 它和词典里的 mp3 走**完全同一条路**（`playAudioB64`），纪律一行都不用改。
 *
 * ══ 判据住在哪 ══════════════════════════════════════════════
 * ★ 这一份现在住在 Android。Windows 那边是 Electron/Chromium，
 *   **同一个 Speex 问题也在**，所以它将来大概率该收编进 core。
 *   今天不抄过去、也不预先搬家 —— 等两端都要用了再由总控决定（同 `cleanSplashName`）。
 * ★ 解不了一律**返回 null 并带一句人话**，绝不抛：
 *   点一下没反应是这条路上最坏的结果（使用者 2026-09-13 正是这么撞上的）。
 */

/** Ogg 页头最短长度（OggS + 版本 + 类型 + granule + serial + seq + crc + 段数） */
const OGG_MIN_PAGE = 27

/** Speex 标识头（第一个包）里那几个字段的偏移 —— 按 Ogg Speex 规范，全部小端 uint32 */
const H_MAGIC_LEN = 8
const H_RATE = 36
const H_MODE = 40
const H_CHANNELS = 48
const H_FRAME_SIZE = 56
const H_FRAMES_PER_PACKET = 64
const H_MIN_LEN = 68

export interface SpxHeader {
  /** 播放采样率（**不一定**等于模式的标称率 —— 这本就是 22050 配宽带） */
  rate: number
  /** 0 = 窄带 · 1 = 宽带 · 2 = 超宽带 */
  mode: number
  channels: number
  frameSize: number
  framesPerPacket: number
}

/**
 * 把一个 Ogg 文件切成**包**。
 * 段表里长度 255 的段表示「还没完」，<255 的那一段收尾 —— 这是 Ogg 的规矩。
 * ★ 认不出来（不是 OggS / 截断）→ 空数组，调用方按「不是 Ogg」处理。
 */
export function oggPackets(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let pending: Uint8Array[] = []
  let at = 0
  while (at + OGG_MIN_PAGE <= bytes.length) {
    if (
      bytes[at] !== 0x4f || // O
      bytes[at + 1] !== 0x67 || // g
      bytes[at + 2] !== 0x67 || // g
      bytes[at + 3] !== 0x53 // S
    ) {
      return out.length > 0 ? out : []
    }
    const segs = bytes[at + 26]!
    const tableAt = at + OGG_MIN_PAGE
    if (tableAt + segs > bytes.length) return out
    let body = tableAt + segs
    for (let i = 0; i < segs; i++) {
      const len = bytes[tableAt + i]!
      if (body + len > bytes.length) return out
      pending.push(bytes.subarray(body, body + len))
      body += len
      if (len < 255) {
        out.push(concat(pending))
        pending = []
      }
    }
    at = body
  }
  return out
}

/** 读 Speex 标识头。不是 Speex → null。 */
export function spxHeader(pkt: Uint8Array): SpxHeader | null {
  if (pkt.length < H_MIN_LEN) return null
  const magic = String.fromCharCode(...pkt.subarray(0, H_MAGIC_LEN))
  if (magic !== 'Speex   ') return null
  const v = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength)
  return {
    rate: v.getUint32(H_RATE, true),
    mode: v.getUint32(H_MODE, true),
    channels: v.getUint32(H_CHANNELS, true),
    frameSize: v.getUint32(H_FRAME_SIZE, true),
    framesPerPacket: v.getUint32(H_FRAMES_PER_PACKET, true)
  }
}

/**
 * 建解码器要用**模式的标称率**，不是文件头里那个播放率。
 * 这本词典就是 `rate 22050 · mode 1（宽带）` —— 拿 22050 去建，
 * 选中的模式可能就不是宽带了，解出来是噪音。
 * 播放仍然按文件头那个 `rate` 走（见 `decodeSpxToWav`）。
 */
const MODE_RATE = [8000, 16000, 32000]

export interface SpxWav {
  /** 可以直接喂 `playAudioB64(b64, 'audio/wav')` */
  b64: string
  rate: number
}

/**
 * `.spx` 字节 → WAV（base64）。
 * 解不了返回 `{ why }`，**绝不抛** —— 这条路上抛一次就是「点了没反应」。
 */
export async function decodeSpxToWav(bytes: Uint8Array): Promise<SpxWav | { why: string }> {
  const packets = oggPackets(bytes)
  if (packets.length < 3) return { why: '这段发音不是 Ogg Speex（拆不出包）' }
  const head = spxHeader(packets[0]!)
  if (!head) return { why: '这段发音的头不是 Speex' }
  if (head.channels !== 1) {
    return { why: `这段发音是 ${head.channels} 声道，目前只支持单声道` }
  }
  if (head.framesPerPacket !== 1) {
    // 说清楚而不是只播前 1/N —— 播一半比不播更难发现
    return { why: `这段发音每包 ${head.framesPerPacket} 帧，这一档还没支持` }
  }
  const nominal = MODE_RATE[head.mode]
  if (nominal === undefined) return { why: `这段发音的模式（${head.mode}）不认得` }

  try {
    // ★ 懒加载：161 KB 的 WASM 不该躺在启动路径上
    const { SpeexDecoder } = await import('@caitun/speex')
    const wasmUrl = (await import('@caitun/speex/wasm/speex-wasm.wasm?url')).default
    const dec = await SpeexDecoder.create({
      sampleRate: nominal,
      locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p)
    })
    try {
      const chunks: Float32Array[] = []
      // packets[0] 是标识头、packets[1] 是注释头，音频从第三个包起
      for (let i = 2; i < packets.length; i++) {
        const pkt = packets[i]!
        if (pkt.length === 0) continue
        chunks.push(dec.decode(pkt))
      }
      if (chunks.length === 0) return { why: '这段发音里没有音频包' }
      return { b64: wavB64(chunks, head.rate), rate: head.rate }
    } finally {
      dec.close()
    }
  } catch (e) {
    return { why: `这段发音解不开：${(e as Error)?.message ?? e}` }
  }
}

/** 词典那条通道递回来的是 base64，解码要的是字节 */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Float32 段 → 16 位单声道 WAV 的 base64。头是 44 字节的老规矩。 */
function wavB64(chunks: Float32Array[], rate: number): string {
  let n = 0
  for (const c of chunks) n += c.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  tag(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM 块长
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // 单声道
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true) // 字节率
  v.setUint16(32, 2, true) // 块对齐
  v.setUint16(34, 16, true) // 位深
  tag(36, 'data')
  v.setUint32(40, n * 2, true)
  let at = 44
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]!))
      v.setInt16(at, Math.round(s * 32767), true)
      at += 2
    }
  }
  // 一次 btoa 整段会在长音频上炸栈，分块拼
  const u8 = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/**
 * ③ 档验收通道（同 `globalThis.nyxTts` / `nyxDb` 的纪律：不看界面，看数）。
 *
 * 真机上「响没响」我没法量，但「解没解开、解出多长」可以 ——
 * 喂一段 base64 进来，它报回包数、头、以及 WAV 的字节数与秒数。
 * ★ 只读不写，删掉它 `decodeSpxToWav` 的行为一模一样。
 */
;(globalThis as Record<string, unknown>)['nyxSpx'] = {
  async probe(b64: string): Promise<unknown> {
    const bytes = b64ToBytes(b64)
    const packets = oggPackets(bytes)
    const head = packets.length > 0 ? spxHeader(packets[0]!) : null
    const r = await decodeSpxToWav(bytes)
    if ('why' in r) return { packets: packets.length, head, ok: false, why: r.why }
    const wavBytes = Math.floor((r.b64.length * 3) / 4)
    return {
      packets: packets.length,
      head,
      ok: true,
      wavBytes,
      seconds: Number(((wavBytes - 44) / 2 / r.rate).toFixed(2))
    }
  }
}
