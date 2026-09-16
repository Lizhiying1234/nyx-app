import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SyncEngine } from './engine.ts'
import type { AudioPort, EnginePorts } from './ports.ts'
import type { RemoteStore } from './store.ts'
import type { SyncProblem } from './problems.ts'

/**
 * TTS 音频的字节同步 · `nyx/audio/` 那条流（D-244「音频**进同步**、不进备份」）
 *
 * ── 为什么现在才有 ★ ────────────────────────────────────────
 *
 * **它以前一条端到端用例都没有。** 2026-09-09 我为启动页那条流写用例时数出来的：
 * `syncAudio` 从 Step 1D 起就在跑，F-08 那道白名单闸也在，
 * 但**没有任何一条用例证明它真的在挡** —— 拆掉它，全仓照样绿。
 * 那正是「跑对套」那条记的东西：**没人钉的闸不算闸。**
 *
 * 这一套是照 `splash-sync.test.ts` 抄的（那条流本来就是照 `syncAudio` 抄的），
 * 判据换成 `checkAudioName`、上限换成 50 / 100。
 * 内存 store、不起 Electron —— 判据摆在最便宜的那一层。
 *
 * ★ 两条流**逐行同形**是有意的：谁哪天改了其中一条，另一条的用例会显出差别。
 */

/** 内存 store —— 只实现这条流用得到的（照 compact.test.ts 的 list 语义） */
class MemStore implements RemoteStore {
  files = new Map<string, string>()
  async list(prefix: string): Promise<string[]> {
    const head = `${prefix}/`
    return [...this.files.keys()]
      .filter((k) => k.startsWith(head))
      .map((k) => k.slice(head.length))
      .filter((n) => !n.includes('/'))
  }
  async get(path: string): Promise<string | null> {
    return this.files.get(path) ?? null
  }
  async put(path: string, body: string): Promise<void> {
    this.files.set(path, body)
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path)
  }
  /** 真实现用它探「连得上吗」—— 内存替身永远连得上 */
  async check(): Promise<void> {}
}

function memPort(seed: Record<string, string> = {}): AudioPort & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    async list() {
      return [...files.keys()]
    },
    async read(name) {
      return files.get(name) ?? null
    },
    async write(name, b64) {
      files.set(name, b64)
    }
  }
}

/** 音频名 = sha1 十六进制（40 位）+ `.mp3` */
const okName = (c: string): string => c.repeat(40) + '.mp3'

async function runAudio(
  port: AudioPort,
  store: MemStore
): Promise<{ moved: number; problems: SyncProblem[] }> {
  const eng = new SyncEngine({ audio: port } as unknown as EnginePorts)
  const problems: SyncProblem[] = []
  const moved = await (
    eng as unknown as { syncAudio(s: RemoteStore, p: SyncProblem[]): Promise<number> }
  ).syncAudio(store, problems)
  return { moved, problems }
}

describe('TTS 音频同步 · nyx/audio（D-244）', () => {
  it('★ 本地有、云端没有 → 传上去', async () => {
    const port = memPort({ [okName('a')]: 'AAAA' })
    const store = new MemStore()
    const { moved } = await runAudio(port, store)
    assert.equal(moved, 1)
    const body = store.files.get(`nyx/audio/${okName('a')}.json`)
    assert.ok(body, '桶里没有那个音频')
    assert.deepEqual(JSON.parse(body), { name: okName('a'), b64: 'AAAA' })
  })

  it('★ 云端有、本地没有 → 收下来', async () => {
    const port = memPort()
    const store = new MemStore()
    store.files.set(
      `nyx/audio/${okName('b')}.json`,
      JSON.stringify({ name: okName('b'), b64: 'BBBB' })
    )
    const { moved } = await runAudio(port, store)
    assert.equal(moved, 1)
    assert.equal(port.files.get(okName('b')), 'BBBB')
  })

  it('★ 两边都有 → 一个字节都不传（内容哈希命名，天生幂等）', async () => {
    const port = memPort({ [okName('c')]: 'CCCC' })
    const store = new MemStore()
    store.files.set(
      `nyx/audio/${okName('c')}.json`,
      JSON.stringify({ name: okName('c'), b64: 'CCCC' })
    )
    const { moved } = await runAudio(port, store)
    assert.equal(moved, 0, '同一个音频又传了一遍 —— 幂等没成立')
  })

  /**
   * ★★★ F-08（Step 1D · D-279）· **名字是远端给的，落盘之前先验**。
   *
   * 这条闸从 2026-08-17 就在，**而在今天之前没有任何用例钉着它** ——
   * 拆掉它，全仓照样绿。这一条就是补上那个洞。
   * 桶里放一个 `..%2F..%2Fevil.exe`：不许写进本地音频目录，而且要**说出来**。
   */
  it('★★★ 云端名字不合规 → 不下载，而且记一笔（F-08 —— 这条闸以前没人钉）', async () => {
    const port = memPort()
    const store = new MemStore()
    store.files.set('nyx/audio/..%2F..%2Fevil.exe.json', JSON.stringify({ b64: 'XX' }))
    store.files.set('nyx/audio/not-a-hash.mp3.json', JSON.stringify({ b64: 'YY' }))
    const { moved, problems } = await runAudio(port, store)
    assert.equal(moved, 0, '不合规的名字被写进本地了')
    assert.equal(port.files.size, 0, '本地音频目录被写了东西')
    assert.equal(problems.length, 2, `两个坏名字该记两笔，实际 ${problems.length}`)
    for (const p of problems) {
      assert.match(p.what, /^nyx\/audio\//)
      assert.match(p.message, /没有下载/)
    }
  })

  it('★ 本地那些不是 .mp3 的不往上传', async () => {
    const port = memPort({ 'notes.txt': 'ZZ', [okName('d')]: 'DDDD' })
    const store = new MemStore()
    const { moved } = await runAudio(port, store)
    assert.equal(moved, 1)
    assert.equal(store.files.size, 1)
    assert.ok(store.files.has(`nyx/audio/${okName('d')}.json`))
  })

  it('坏包跳过，不把整趟拖垮', async () => {
    const port = memPort()
    const store = new MemStore()
    store.files.set(`nyx/audio/${okName('e')}.json`, '{ 这不是 JSON')
    store.files.set(
      `nyx/audio/${okName('f')}.json`,
      JSON.stringify({ name: okName('f'), b64: 'FFFF' })
    )
    const { moved } = await runAudio(port, store)
    assert.equal(moved, 1, '坏包应该只坏它自己')
    assert.equal(port.files.get(okName('f')), 'FFFF')
  })

  it('★ 一次最多传 50 个 —— 剩下的下次接着传', async () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 60; i++) many[i.toString(16).padStart(40, '0') + '.mp3'] = 'x'
    const port = memPort(many)
    const store = new MemStore()
    const { moved } = await runAudio(port, store)
    assert.equal(moved, 50, `一次该传 50 个，实际 ${moved}`)
  })
})
