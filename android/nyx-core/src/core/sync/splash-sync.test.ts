import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SyncEngine } from './engine.ts'
import type { AssetPort, EnginePorts } from './ports.ts'
import type { RemoteStore } from './store.ts'
import type { SyncProblem } from './problems.ts'
import { checkSplashName } from '../splash-name.ts'

/**
 * 启动页图片的字节同步 · `nyx/splash/` 那条流（使用者 2026-09-09
 * 「win 和 android 可以有不同的启动页，**共享的是图片资源**」）
 *
 * ── 为什么钉在 core 的内存 store 上，而不是真 WebDAV ──────────
 *
 * 「判据摆在最便宜的那一层」：这条流的全部判断都在 `syncSplash` 里 ——
 * 传哪些、收哪些、名字不合规怎么办、一次最多几张。这些都不需要网络。
 * 真桶那一层要验的是「PROPFIND / PUT 那一层是真的」，`sync.test.ts` 已经验过，
 * 再验一遍只是把 4 秒变成 60 秒。
 *
 * ★ 顺带说清楚一件事：`syncAudio` 至今**一条端到端用例都没有**（我数过）。
 *   这一套是全仓第一套资源流用例；音频那条要不要补，记在交付里给总控。
 */

/** 内存 store —— 只实现 `syncSplash` 用得到的四样（照 compact.test.ts 的语义） */
class MemStore implements RemoteStore {
  files = new Map<string, string>()
  /** 读的时候动手脚 —— 「坏包跳过」那一条用 */
  tamper: ((path: string, body: string) => string) | null = null

  async list(prefix: string): Promise<string[]> {
    const head = `${prefix}/`
    return [...this.files.keys()]
      .filter((k) => k.startsWith(head))
      .map((k) => k.slice(head.length))
      .filter((n) => !n.includes('/'))
  }
  async get(path: string): Promise<string | null> {
    const v = this.files.get(path)
    if (v === undefined) return null
    return this.tamper ? this.tamper(path, v) : v
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

/** 内存资源端口 —— 本地那一半 */
function memPort(seed: Record<string, string> = {}): AssetPort & { files: Map<string, string> } {
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
    },
    /** 服从一次删除（使用者 2026-09-14）。幂等：本来就不在也算成 */
    async delete(name) {
      files.delete(name)
    }
  }
}

/** 64 位小写 hex（sha256） + 扩展名 —— 合法资源名的形状 */
const hex = (c: string): string => c.repeat(64)
const okName = (c: string, ext = '.webp'): string => {
  const n = hex(c) + ext
  /**
   * ★★ 夹具自检（2026-09-15 真踩过）：`okName('g')` 这种**不是十六进制**的字符
   *   会造出一个不合法的名字，而不合法的名字会被整条流**整条跳过** ——
   *   于是「没报问题」「桶里没变」这类断言全部**假绿**：验的不是产品行为，
   *   是「这个名字根本没进来」。当时靠另一条「推上去了吗」的正向断言才露馅。
   * ★ 所以这里当场抛：夹具错了要红在夹具上，不许变成一条安静的绿。
   */
  if (!checkSplashName(n).ok) {
    throw new Error(`夹具的名字不合法（${c} 不是十六进制字符）—— 它会被整条流跳过，断言会假绿`)
  }
  return n
}

/** 直接调私有方法：这一条流不需要跑整趟同步，跑整趟只会把噪音带进来 */
async function runSplash(
  port: AssetPort | undefined,
  store: MemStore
): Promise<{ moved: number; problems: SyncProblem[] }> {
  const eng = new SyncEngine({ splash: port } as unknown as EnginePorts)
  const problems: SyncProblem[] = []
  const moved = await (
    eng as unknown as {
      syncSplash(s: RemoteStore, p: SyncProblem[]): Promise<number>
    }
  ).syncSplash(store, problems)
  return { moved, problems }
}

/**
 * 名字那一半（使用者 2026-09-13）。跑法和上面一样 —— 直接调私有方法，
 * 因为「谁赢」这件事一点网络都不需要。
 */
async function runNames(
  port: AssetPort | undefined,
  labels: Record<string, { label: string; at: number }>,
  store: MemStore,
  seen = 0,
  /** ★ I-178 · 本机设备号。判据要靠它认出「这份 meta 是我自己写的」 */
  me = 'THIS-DEVICE'
): Promise<{
  problems: SyncProblem[]
  after: Record<string, { label: string; at: number }>
  writes: number
}> {
  let kept = { ...labels }
  /** ★ 回写了几次 —— 「没变就不回写」那一条铉的就是它 */
  let writes = 0
  const eng = new SyncEngine({
    splash: port,
    splashLabels: {
      async read() {
        return kept
      },
      async write(m: Record<string, { label: string; at: number }>) {
        writes += 1
        kept = m
      }
    },
    db: { async get() { return String(seen) } }
  } as unknown as EnginePorts)
  /**
   * `maxRemoteSeen` 走引擎自己的 get()，这里直接把它替掉，别为了一个数去搭半个引擎。
   * ★★ I-178 之后这个替身**必须认 key**：`deviceId()` 问的也是它，
   *   一律回 `String(seen)` 的话本机设备号会变成水位那个数字 ——
   *   于是「本机写的 meta」这一态永远试不出来，用例绿得毫无意义。
   */
  ;(eng as unknown as { get(k: string, d: string): Promise<string> }).get = async (k: string) =>
    k === 'device' ? me : String(seen)
  const problems: SyncProblem[] = []
  await (
    eng as unknown as {
      syncSplashNames(s: RemoteStore, p: SyncProblem[]): Promise<void>
    }
  ).syncSplashNames(store, problems)
  return { problems, after: kept, writes }
}

describe('★★ 启动页图片的名字 · 两端同步（使用者 2026-09-13）', () => {
  it('★★★ 名字一个都没变 → **一次都不回写**', async () => {
    /**
     * ★★ 为什么要铉这一条（Nyx-UI-Android 2026-09-13 提的）：
     *   对面拿 `settings` 那一行的 `updated_at` **当「这个名字什么时候改的」的证据**。
     *   每趟同步白写一次就把它刷新掉 —— 于是「最后一次修改为准」
     *   判到的是**同步的时间**，不是他改名的时间。
     *   那种错不会报，只会让某一次改名莫名其妙地输掉。
     */
    const name = okName('a')
    const store = new MemStore()
    store.files.set(`nyx/splash/${name}.meta.json`, JSON.stringify({ label: '秋天', at: 5 }))
    const { writes, after } = await runNames(
      memPort({ [name]: 'AAAA' }),
      { [name]: { label: '秋天', at: 5 } },
      store
    )
    assert.equal(writes, 0, '★★ 名字没变却回写了 —— 他那一行的 updated_at 会被每趟同步刷掉')
    assert.deepEqual(after, { [name]: { label: '秋天', at: 5 } }, '名字本身不该变')
  })

  it('★★ 真变了 → 照常回写一次', async () => {
    // 反面：上面那条不能是「干脆永远不写」换来的绿
    const name = okName('a')
    const store = new MemStore()
    store.files.set(`nyx/splash/${name}.meta.json`, JSON.stringify({ label: '冬天', at: 9 }))
    const { writes, after } = await runNames(
      memPort({ [name]: 'AAAA' }),
      { [name]: { label: '秋天', at: 5 } },
      store
    )
    assert.equal(writes, 1, '远端更新了却没落库')
    assert.equal(after[name]?.label, '冬天')
  })

  it('★★★ 桶里的 .meta.json 不许被当成图片 —— 否则每趟都塞一条假问题', async () => {
    const name = okName('a')
    const store = new MemStore()
    store.files.set(`nyx/splash/${name}.json`, JSON.stringify({ name, b64: 'AAAA' }))
    store.files.set(`nyx/splash/${name}.meta.json`, JSON.stringify({ label: '秋天', at: 5 }))
    const { problems } = await runSplash(memPort({ [name]: 'AAAA' }), store)
    assert.deepEqual(
      problems,
      [],
      '★★★ 把 meta 当成「名字不合规的图」报了 —— 假问题会让真问题没人看'
    )
  })

  it('★★ 云端的名字更晚 → 覆盖本地', async () => {
    const name = okName('b')
    const store = new MemStore()
    store.files.set(`nyx/splash/${name}.meta.json`, JSON.stringify({ label: '云端改的', at: 900 }))
    const { after } = await runNames(memPort({ [name]: 'BBBB' }), { [name]: { label: '本地的', at: 100 } }, store)
    assert.deepEqual(after[name], { label: '云端改的', at: 900 })
  })

  it('★★ 本地的名字更晚 → 推上去，云端那份被换掉', async () => {
    const name = okName('c')
    const store = new MemStore()
    store.files.set(`nyx/splash/${name}.meta.json`, JSON.stringify({ label: '旧的', at: 100 }))
    await runNames(memPort({ [name]: 'CCCC' }), { [name]: { label: '新的', at: 900 } }, store)
    assert.match(store.files.get(`nyx/splash/${name}.meta.json`) ?? '', /新的/)
  })

  it('★ 两边一样 → 一个字节都不推（幂等，同步会跑很多趟）', async () => {
    const name = okName('d')
    const store = new MemStore()
    const same = JSON.stringify({ label: '一样的', at: 500 })
    store.files.set(`nyx/splash/${name}.meta.json`, same)
    await runNames(memPort({ [name]: 'DDDD' }), { [name]: { label: '一样的', at: 500 } }, store)
    assert.equal(store.files.get(`nyx/splash/${name}.meta.json`), same)
  })

  it('★★★ **别的设备**写的 meta 钟明显超前 → 记一条体检问题（不钳制、不改值），**且话说的是「晚」**', async () => {
    const name = okName('e')
    const seen = 1_700_000_000_000
    const store = new MemStore()
    /** ★ I-178：夹具必须写**别的**设备号 —— 不写就撞上「老 meta 跳过」那一态，这条会假绿 */
    store.files.set(
      `nyx/splash/${name}.meta.json`,
      JSON.stringify({ label: '未来的名字', at: seen + 48 * 3600 * 1000, device: 'OTHER-DEV' })
    )
    const { problems, after } = await runNames(memPort({ [name]: 'EEEE' }), {}, store, seen)
    assert.equal(problems.length, 1, '★★★ 钟快的那一端会永久赢，不报就没人会发现')
    assert.match(problems[0]!.message, /时钟/)
    assert.equal(after[name]?.label, '未来的名字', '★ 只报不钳 —— 钳了他的改名会莫名其妙失效')
    /**
     * ★★ **方向那个字**（X-1，使用者 2026-09-14 收敛对账）
     *
     * 判定是 `labelSkew = at − maxRemoteSeen`，**只在远端更晚时才 > 0** ——
     * 这一条用例摆的正是那种局面（`at = seen + 48h`）。
     * 而原来的文案写的是「还**早**了」：前半句说早、后半句「会一直偏向它」只在晚时成立，
     * 他照着前半句去查，会去查**慢**的那一端 —— 指错方向。
     *
     * ★ 所以这两句钉的不是措辞好不好，是**文案和判定同向**。
     *   反向对照：把那个字改回「早」，这两句当场红。
     */
    assert.match(problems[0]!.message, /还晚了/, '★★ 文案要和判定同向：只在远端更晚时才报')
    assert.doesNotMatch(problems[0]!.message, /还早了/, '★★ 说「早」会把他指向慢的那一端')
    assert.match(problems[0]!.message, /48 小时以上/, '★ 顺带钉住量：48 小时那个数要算对')
    /**
     * ★★ K-5 · 和 PG-4 同一课：**两种成因都要出现，一个都不许判定**。
     *   `maxRemoteSeen` 是别的设备最后一次**改数据**的时间戳，差得大既可能是钟快，
     *   也可能只是它这段时间没动过数据 —— 分不开就都说。
     * ★ 反向对照：把 message 改回「那一端的时钟可能不准」那一版 → 下面三条当场红。
     */
    assert.match(problems[0]!.message, /没改过数据/, '★★ 成因一：对端这段时间没动过数据')
    assert.match(problems[0]!.message, /时钟快了/, '★★ 成因二：对端的钟')
    assert.doesNotMatch(
      problems[0]!.message,
      /时钟可能不准/,
      '★★★ K-5：这个条件证不出对端的钟坏了，不许替他下这个断言'
    )
  })

  /**
   * ★★★ I-178（使用者 2026-09-14 看到「10 小时以上」）—— **本机在骂自己**。
   *
   * `maxRemoteSeen` 只被**别的设备**推的包抬，而 `store.list('nyx/splash')`
   * 会把**本机自己刚推上去的 meta** 一起列出来比。于是
   * 「本机刚改了名字 ＋ 对端半天没同步」= 拿自己的 `at` 去和一个不含自己的水位比，
   * 必然超前、必然报。实测 9.933 h > 6 h 容差。
   *
   * ★ 反向对照：把 `remoteMetaSkew` 里 `who === me` 那一行删掉 → 这一条当场红。
   */
  it('★★★ I-178 · **本机自己**写的 meta 再超前也不报 —— 自己不骂自己', async () => {
    const name = okName('f')
    const seen = 1_700_000_000_000
    const store = new MemStore()
    store.files.set(
      `nyx/splash/${name}.meta.json`,
      JSON.stringify({ label: '我刚改的', at: seen + 48 * 3600 * 1000, device: 'THIS-DEVICE' })
    )
    const { problems } = await runNames(memPort({ [name]: 'FFFF' }), {}, store, seen)
    assert.deepEqual(problems, [], '★★★ 本机改了个名字，软件回头骂他「另一端时钟不准」')
  })

  it('★★ 老 meta（没有设备号）→ **跳过不报**：没证据别骂人', async () => {
    /**
     * 这一态不是「顺手宽容」，是**必须**：修之前桶里所有 meta 都没有设备号，
     * 其中绝大多数正是本机自己写的。当「别的设备」处理的话，
     * 使用者那台机器升级完第一趟同步就会把老账全报一遍。
     * ★ 代价写在明处：老 meta 从此不说话，任意一端再改一次名就带上号了。
     */
    const name = okName('0')
    const seen = 1_700_000_000_000
    const store = new MemStore()
    store.files.set(
      `nyx/splash/${name}.meta.json`,
      JSON.stringify({ label: '老数据', at: seen + 48 * 3600 * 1000 })
    )
    const { problems } = await runNames(memPort({ [name]: 'GGGG' }), {}, store, seen)
    assert.deepEqual(problems, [], '★★ 没有设备号 = 认不出是谁写的 = 不报')
  })

  it('★★ 推上去的 meta 带**本机**设备号（不带的话下一趟又变成老 meta）', async () => {
    const name = okName('1')
    const store = new MemStore()
    await runNames(memPort({ [name]: 'HHHH' }), { [name]: { label: '我起的名', at: 900 } }, store)
    const body = store.files.get(`nyx/splash/${name}.meta.json`)
    assert.ok(body, '本地更新的那份没推上去')
    assert.equal(
      (JSON.parse(body) as { device?: string }).device,
      'THIS-DEVICE',
      '★★ 不盖设备号的话，本机写的 meta 下一趟读回来还是「认不出是谁」'
    )
  })

  it('★ 从对端拉回来的名字**不会**被本机重新签名（没赢就不推）', async () => {
    /**
     * `device` 记的是「谁把这份放进桶里」。本机只在自己那份**真的赢了**时才推，
     * 所以对端写的 meta 不会被本机盖成自己的号。这条钉的是那个「我替你签名」的坑。
     */
    const name = okName('2')
    const store = new MemStore()
    const theirs = JSON.stringify({ label: '对端起的', at: 900, device: 'OTHER-DEV' })
    store.files.set(`nyx/splash/${name}.meta.json`, theirs)
    await runNames(memPort({ [name]: 'IIII' }), { [name]: { label: '对端起的', at: 900 } }, store)
    assert.equal(store.files.get(`nyx/splash/${name}.meta.json`), theirs, '★ 没赢却把桶里那份重写了')
  })

  it('★ 没给名字那个口子 → 整条不跑，不抛', async () => {
    const store = new MemStore()
    await assert.doesNotReject(() => runSplash(memPort({}), store))
  })
})

describe('启动页图片同步 · nyx/splash', () => {
  it('★ 本地有、云端没有 → 传上去（名字原样，正文是 base64）', async () => {
    const port = memPort({ [okName('a')]: 'AAAA' })
    const store = new MemStore()
    const { moved } = await runSplash(port, store)
    assert.equal(moved, 1)
    const body = store.files.get(`nyx/splash/${okName('a')}.json`)
    assert.ok(body, '桶里没有那张图')
    assert.deepEqual(JSON.parse(body), { name: okName('a'), b64: 'AAAA' })
  })

  it('★ 云端有、本地没有 → 收下来', async () => {
    const port = memPort()
    const store = new MemStore()
    store.files.set(
      `nyx/splash/${okName('b')}.json`,
      JSON.stringify({ name: okName('b'), b64: 'BBBB' })
    )
    const { moved } = await runSplash(port, store)
    assert.equal(moved, 1)
    assert.equal(port.files.get(okName('b')), 'BBBB')
  })

  it('★ 两边都有 → 一个字节都不传（内容哈希命名，天生幂等）', async () => {
    const port = memPort({ [okName('c')]: 'CCCC' })
    const store = new MemStore()
    store.files.set(
      `nyx/splash/${okName('c')}.json`,
      JSON.stringify({ name: okName('c'), b64: 'CCCC' })
    )
    const { moved } = await runSplash(port, store)
    assert.equal(moved, 0, '同一张图又传了一遍 —— 幂等没成立')
  })

  /**
   * ★★ F-08 那一条：**名字是远端给的，落盘之前先验**。
   * 桶里放一个 `../../evil.exe`，不许写进本地资源目录；而且要**说出来**，
   * 不是安静跳过 —— 安静跳过等于「同步好了」，可他少了一张图。
   */
  it('★★ 云端名字不合规 → 不下载，而且记一笔（F-08）', async () => {
    const port = memPort()
    const store = new MemStore()
    store.files.set('nyx/splash/..%2F..%2Fevil.exe.json', JSON.stringify({ b64: 'XX' }))
    store.files.set('nyx/splash/not-a-hash.png.json', JSON.stringify({ b64: 'YY' }))
    const { moved, problems } = await runSplash(port, store)
    assert.equal(moved, 0, '不合规的名字被写进本地了')
    assert.equal(port.files.size, 0, '本地资源目录被写了东西')
    assert.equal(problems.length, 2, `两个坏名字该记两笔，实际 ${problems.length}`)
    for (const p of problems) {
      assert.match(p.what, /^nyx\/splash\//)
      assert.match(p.message, /没有下载/)
    }
  })

  it('★ 本地那些不合规的文件不往上传（别人的垃圾不该被我推上云）', async () => {
    const port = memPort({ 'readme.txt': 'ZZ', [okName('d')]: 'DDDD' })
    const store = new MemStore()
    const { moved } = await runSplash(port, store)
    assert.equal(moved, 1)
    assert.equal(store.files.size, 1)
    assert.ok(store.files.has(`nyx/splash/${okName('d')}.json`))
  })

  it('坏包跳过，不把整趟拖垮', async () => {
    const port = memPort()
    const store = new MemStore()
    store.files.set(`nyx/splash/${okName('e')}.json`, '{ 这不是 JSON')
    store.files.set(
      `nyx/splash/${okName('f')}.json`,
      JSON.stringify({ name: okName('f'), b64: 'FFFF' })
    )
    const { moved } = await runSplash(port, store)
    assert.equal(moved, 1, '坏包应该只坏它自己')
    assert.equal(port.files.get(okName('f')), 'FFFF')
  })

  it('★ 一次最多传 20 张 —— 图比音频大，剩下的下次接着传', async () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 25; i++) many[i.toString(16).padStart(64, '0') + '.png'] = 'x'
    const port = memPort(many)
    const store = new MemStore()
    const { moved } = await runSplash(port, store)
    assert.equal(moved, 20, `一次该传 20 张，实际 ${moved}`)
    assert.equal(store.files.size, 20)
  })

  /**
   * ★★ 没接端口的那一端**整条流不跑** —— Android 的产品取舍还没定
   * （2026-09-09 对面会话：「我使用者没交办过这件事」）。
   * 不给端口 ≠ 报错，也 ≠ 假装传过了：就是 0。
   */
  it('★★ 没给 splash 端口 → 整条不跑，返回 0，不抛', async () => {
    const store = new MemStore()
    const { moved, problems } = await runSplash(undefined, store)
    assert.equal(moved, 0)
    assert.equal(problems.length, 0)
    assert.equal(store.files.size, 0, '没端口却往桶里写了东西')
  })
})

/**
 * 跑一趟完整的启动页同步（图 + 名字 + 墓碑）。
 * ★ 和上面那个 `runSplash` 不同：这里**必须把名字端口也接上** ——
 *   墓碑就住在名字那一份里，不接的话这条路整段不跑。
 */
async function runTomb(
  store: MemStore,
  port: AssetPort & { files: Map<string, string> },
  labels: Record<string, { label: string; at: number; gone?: boolean }> = {}
): Promise<{ moved: number; problems: SyncProblem[]; after: typeof labels }> {
  let kept = { ...labels }
  const eng = new SyncEngine({
    splash: port,
    splashLabels: {
      async read() {
        return kept
      },
      async write(m: typeof labels) {
        kept = m
      }
    }
  } as unknown as EnginePorts)
  ;(eng as unknown as { get(k: string, d: string): Promise<string> }).get = async () => '0'
  const problems: SyncProblem[] = []
  const moved = await (
    eng as unknown as { syncSplash(s: RemoteStore, p: SyncProblem[]): Promise<number> }
  ).syncSplash(store, problems)
  return { moved, problems, after: kept }
}

/**
 * ══ 真删除 · 墓碑（使用者 2026-09-14 裁「选 a：连桶一起删」）═══════════
 *
 * ── 这一组为什么值得写满 ★★★ ────────────────────────────────
 * 这条路上**每一种失败都是无声的**：
 *   · 碑没立上 → 删了又回来，而屏上什么都不说
 *   · 碑立上了但桶里对象没删 → 换台机器同步下来它又在
 *   · 碑压不过对面 → 他删的东西被对面「它还活着」翻回来
 *   · 碑翻不过来 → 他重新传同一张图，文件在本地却永远传不上去
 * 没有一种会报错。所以判据只能靠用例钉。
 *
 * ── 三条不变量 ──────────────────────────────────────────────
 *   ① 有碑 → 本机删、桶里删、不推、不拉
 *   ② 碑与「它还活着」相遇 → 按 `at` 定；**平局时活的赢**（宁可留着让他再删一次）
 *   ③ 「取不到」≠ `false` —— 老 meta 没有 `gone` 那一栏，不许被当成「声明它活着」
 */
describe('★★★ 启动页图 · 真删除与墓碑（2026-09-14）', () => {
  const name = okName('a')

  it('★★★ ① 桶里有碑 → 本机那份删掉，而且桶里那个对象也删掉', async () => {
    const store = new MemStore()
    const port = memPort({ [name]: 'AAAA' })
    store.files.set(`nyx/splash/${name}.json`, JSON.stringify({ name, b64: 'AAAA' }))
    store.files.set(
      `nyx/splash/${name}.meta.json`,
      JSON.stringify({ label: '秋天', at: 900, gone: true })
    )
    await runTomb(store, port)
    assert.equal(port.files.has(name), false, '★★ 本机那份还在 —— 碑没被服从')
    assert.equal(
      store.files.has(`nyx/splash/${name}.json`),
      false,
      '★★ 桶里那个对象还在 —— 换台机器同步下来它又回来了'
    )
  })

  it('★★ ② 有碑 → 它不会被推上桶（正常路径：① 那一步已经把本地那份删了）', async () => {
    const store = new MemStore()
    const port = memPort({ [name]: 'AAAA' })
    store.files.set(
      `nyx/splash/${name}.meta.json`,
      JSON.stringify({ label: '秋天', at: 900, gone: true })
    )
    await runTomb(store, port)
    assert.equal(
      store.files.has(`nyx/splash/${name}.json`),
      false,
      '★★ 带着碑的图被推上桶了'
    )
  })

  it('★★★ ②b 本地那份**删不掉**时，他仍然不许被推上去（真正的「不许复活」）', async () => {
    /**
     * ★★★ 这一条是负向对照逼出来的。
     *
     *   上面② 那一条看着像在钉「推那一步的守卫」，**它不是** ——
     *   正常路径上① 已经把本地文件删了，推循环根本走不到那个守卫。
     *   把守卫拆掉跑一遍，21 条照样全绿 —— 那就是一条假绿。
     *
     *   守卫真正起作用的是这一种：**本地文件删不掉**
     *   （被占用 / 权限 —— `AssetPort.delete` 的契约就是「删不掉不报」）。
     *   那时候如果还推，就是一台没删干净的机器把对面刚删的图又塞回桶里。
     */
    const store = new MemStore()
    const port = memPort({ [name]: 'AAAA' })
    /** 删不掉的那种盘：delete 什么都不做，也不报 */
    port.delete = async () => {}
    store.files.set(
      `nyx/splash/${name}.meta.json`,
      JSON.stringify({ label: '秋天', at: 900, gone: true })
    )
    await runTomb(store, port)
    assert.equal(port.files.has(name), true, '前提坏了：这一条要的就是「删不掉」')
    assert.equal(
      store.files.has(`nyx/splash/${name}.json`),
      false,
      '★★★ 一台还没删干净的机器把对面刚删的图又塞回桶里了'
    )
  })

  it('★★★ ③ 有碑就不许拉下来 —— 刚删完又下回来是这一整条要治的毛病', async () => {
    const store = new MemStore()
    const port = memPort()
    store.files.set(`nyx/splash/${name}.json`, JSON.stringify({ name, b64: 'AAAA' }))
    store.files.set(
      `nyx/splash/${name}.meta.json`,
      JSON.stringify({ label: '秋天', at: 900, gone: true })
    )
    await runTomb(store, port)
    assert.equal(port.files.has(name), false, '★★★ 带着碑的图被拉下来了')
  })

  it('★★★ ④ 本地说「它回来了」（更新的 at）→ 压过桶里的碑，图重新上去', async () => {
    const store = new MemStore()
    const port = memPort({ [name]: 'AAAA' })
    store.files.set(
      `nyx/splash/${name}.meta.json`,
      JSON.stringify({ label: '秋天', at: 900, gone: true })
    )
    // 本地：他又把同一张图加回来了，时间更新
    await runTomb(store, port, { [name]: { label: '秋天', at: 1200, gone: false } })
    assert.equal(port.files.has(name), true, '★★ 他加回来的那张被删掉了')
    assert.equal(
      store.files.has(`nyx/splash/${name}.json`),
      true,
      '★★★ 他重新传的那张永远推不上桶 —— 而屏上什么都不会说'
    )
  })

  it('★★★ ⑤ 老 meta（**没有 gone 那一栏**）压不过新碑 ——「取不到」不等于 false', async () => {
    const store = new MemStore()
    const port = memPort({ [name]: 'AAAA' })
    // 桶里是新碑
    store.files.set(
      `nyx/splash/${name}.meta.json`,
      JSON.stringify({ label: '秋天', at: 900, gone: true })
    )
    // 本地是一条更老的、没表过态的名字
    await runTomb(store, port, { [name]: { label: '秋天', at: 100 } })
    assert.equal(port.files.has(name), false, '★★★ 一条老名字把新碑翻掉了')
  })
})
