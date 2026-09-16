/**
 * ══ Assist 引擎（D-404①）═══════════════════════════════════════
 *
 * 这是 Nyx 判据的**第三次装配**，跑在无障碍服务自己的无头 WebView 里。
 *
 *   Windows        core + Electron 端口
 *   Nyx App        core + Capacitor 端口（src/db/*）
 *   Assist 引擎    core + **原生端口**（本文件）  ← 新增的这一份
 *
 * ★★★ 为什么要有它（返工的根因，2026-08-30 审计）：
 *   在这之前，气泡的每一次查词/保存都是一个 RPC，打给 **App 主进程的
 *   WebView**。而那个 WebView 只活在 MainActivity 里 —— 叫醒它的唯一办法
 *   就是 `startActivity(MainActivity)`。于是「选中一个词」→ Nyx 被拉到前台。
 *   这不是某一处跳转写错了，是**大脑不在气泡这边**。
 *   所以不是删掉那次 startActivity，而是把大脑搬过来。
 *
 * ★ 搬的是**装配**，不是判据：查词/词典/写库仍然是 src/db 里那一份
 *   （D-238/D-365）。这里只提供四个端口：
 *     Db          → nyxHost.sql（原生 SQLite，同一个库文件）
 *     词典字节     → nyxHost.dictRead（ContentResolver 真随机读）
 *     API key     → nyxHost.secret（插件自己那张加密表）
 *     fetch       → nyxHost.httpStart（原生 HTTP，显式 UTF-8，绕开 CORS）
 *
 * ★ 引擎不碰界面：结果一律 JSON 交回原生，由气泡渲染。
 */
import { setKeyProvider } from '../db/ai.ts'
import { assistCapture, assistStatus } from '../db/capture.ts'
import { setDictIoProvider } from '../db/dict.ts'
import { nativeDictIo } from '../db/dict-io.ts'
import { dictSoundBytes, parseEntryLink, prewarmPronounce } from '../db/dict.ts'
import { assistLookup, type LookupKind } from '../db/lookup.ts'
import { noteLookup } from '../db/ledger.ts'
import { identityOf, runAuto, uuidV4 } from '../db/sync-runner.ts'
import { dictionaryStep, runVoice, systemStep, ttsPrefs } from '../db/voice.ts'
import type { Db, Row } from '../db/types.ts'
import { AiError, explainVoice, type EnginePorts, type VoiceKind } from '../core-link.ts'

interface NativeHost {
  ready(): void
  result(seq: number, ok: boolean, json: string): void
  log(msg: string): void
  /** T-6.6 · 引擎自己那几行探针 —— 与服务写同一个文件、同一个开关（`Probe`） */
  probe(msg: string): void
  /** kind: exec|run|get|all|begin|commit|rollback → JSON {ok,rows?,err?} */
  sql(kind: string, sql: string, params: string): string
  dictSize(uri: string): number
  /** base64（同步 —— DictionaryIO 契约就是同步的） */
  dictRead(uri: string, at: number, len: number): string
  secret(name: string): string | null
  httpStart(id: number, url: string, method: string, headers: string, body: string): void
  /** ── F-003 后台同步要的文件面（2026-09-01）—— 口径 = Capacitor Directory.Data ── */
  filesDir(): string
  dirList(rel: string): string
  fileRead(rel: string): string | null
  /** 成功返回 null，失败返回一句人话 */
  fileWrite(rel: string, b64: string): string | null
  fileDelete(rel: string): void
}

const host = (globalThis as unknown as { nyxHost: NativeHost }).nyxHost

// ── 端口① · Db（原生 SQLite）──────────────────────────────────
// 同步调用，但接口是异步的（D-275 那条：判据一份，adapter 只管搬运）。

function sql(kind: string, text: string, params: readonly unknown[] = []): Row[] {
  const r = JSON.parse(host.sql(kind, text, JSON.stringify(params ?? []))) as {
    ok: boolean
    rows?: Row[]
    err?: string
  }
  if (!r.ok) throw new Error(r.err ?? 'SQL 失败')
  return r.rows ?? []
}

const db: Db = {
  exec: (s) => Promise.resolve(void sql('exec', s)),
  run: (s, p) => Promise.resolve(void sql('run', s, p)),
  get: (s, p) => Promise.resolve(sql('get', s, p)[0]),
  all: (s, p) => Promise.resolve(sql('all', s, p)),
  begin: () => Promise.resolve(void sql('begin', '')),
  commit: () => Promise.resolve(void sql('commit', '')),
  rollback: () => Promise.resolve(void sql('rollback', ''))
}

// ── 端口② · 词典字节（真随机读）───────────────────────────────
//
// ★ T-5.10：这一份 io 搬进 `db/dict-io.ts` 了 —— App 的 WebView 现在也有
//   同一条通道（`nyxDictHost`，原生那半同样是 `DictFiles.java` 那一份）。
//   两个 WebView 装的是同一个 `DictionaryIO`，不是「写得像」。

setDictIoProvider((uri) => nativeDictIo(host, uri))

// ── 端口③ · API key（插件那张加密表，同一处）──────────────────

setKeyProvider((name) => Promise.resolve(host.secret(name)))

// ── 端口④ · fetch（原生 HTTP）────────────────────────────────
// core/ai 用全局 fetch。引擎页面的 origin 是 http://nyx.assist/，
// 直连服务商必然撞 CORS —— 所以 fetch 换成原生的一条，顺带把编码钉死 UTF-8。

const pending = new Map<number, (r: { status: number; text: string; err: string | null }) => void>()
let httpSeq = 0

;(globalThis as unknown as { fetch: unknown }).fetch = (
  input: unknown,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<Response> => {
  const url = String(input)
  const id = ++httpSeq
  return new Promise<Response>((resolve, reject) => {
    pending.set(id, (r) => {
      if (r.err) {
        reject(new TypeError(r.err))
        return
      }
      resolve(new Response(r.text, { status: r.status }))
    })
    try {
      host.httpStart(
        id,
        url,
        init?.method ?? 'GET',
        JSON.stringify(init?.headers ?? {}),
        init?.body ?? ''
      )
    } catch (e) {
      pending.delete(id)
      reject(new TypeError(String(e)))
    }
  })
}

// ── 端口⑤ · 同步（F-003 · 2026-09-01；单执行者 T-2.1 · 2026-09-04）──
//
// ★★★ 这里**只有端口**，没有引擎。
//   `new SyncEngine` 全仓只有一处 —— `db/sync-runner.ts`。这个页面与 App 的
//   WebView 是两个 JS 上下文，各带一套端口进去，跑的是同一份执行者与同一道互斥。
//   （原来这里每调一次 `syncOnce` 就现造一个引擎，于是 core 里那道
//    「同一时刻只许跑一趟」的队列对后台完全无效 —— 审计 R-007。）
//
//     db       → 上面那个 nyxHost.sql（**同一个库文件**）
//     identity → `sync-runner.ts::identityOf`（★ 与 App 那侧同一份实现）
//     backup   → VACUUM INTO（纯 SQL）+ nyxHost.filesDir()
//     audio    → nyxHost.dirList / fileRead / fileWrite（Directory.Data 同一个目录）
//     secrets  → nyxHost.secret（同一张 Keystore 加密表）
//
// ★ 为什么不 import `db/sync-ports.ts`：那一份在模块顶层 import 了
//   `@capacitor/filesystem` 与 `capacitor-secure-storage`，而这个页面**没有
//   Capacitor 桥**。`sync-runner.ts` / `db/sha256.ts` 都不带这类依赖，两处共用。

const AUDIO = 'audio'

function nativePorts(target: Db): EnginePorts {
  return {
    db: target,
    identity: () => identityOf(target),
    /**
     * 动库之前整库备一次。★ 引擎保证在**事务外**调它
     * （SQLite 禁止事务内 VACUUM —— 正好互证）。只滚一份，和 App 那侧同名同位。
     */
    backup: async (reason: string) => {
      const name = `nyx-backup-${reason}.db`
      host.fileDelete(name)
      const path = `${host.filesDir()}/${name}`
      await target.run(`vacuum into '${path.replace(/'/g, "''")}'`)
    },
    audio: {
      list: () =>
        Promise.resolve(
          (JSON.parse(host.dirList(AUDIO)) as string[]).filter((n) => n.endsWith('.mp3'))
        ),
      read: (name: string) => Promise.resolve(host.fileRead(`${AUDIO}/${name}`)),
      write: (name: string, b64: string) => {
        // 名字已过 core/audio-name.ts 白名单（引擎在调它之前验）
        const err = host.fileWrite(`${AUDIO}/${name}`, b64)
        return err === null ? Promise.resolve() : Promise.reject(new Error(err))
      }
    },
    secrets: {
      getSyncSecret: () => Promise.resolve(host.secret('sync.secret') ?? ''),
      /** ★ 后台不改配置 —— 配置只在设置页改。真被调到说明写错了，宁可炸 */
      setSyncSecret: () => Promise.reject(new Error('后台同步不许改同步配置')),
      hasSyncSecret: () => Promise.resolve((host.secret('sync.secret') ?? '') !== '')
    },
    clock: { now: () => Date.now() },
    uuid: uuidV4
  }
}

/**
 * 后台那一趟。★ 「没配 / 自动关着 / 另一处正在同步」三种都是**安静跳过** ——
 * 判据在 `runAuto` 里，与前台那两条路同一份（以前这里自己读 `settings`，
 * 默认值还和 core 的 `auto()` 不一样）。
 */
async function syncOnce(): Promise<{
  applied: number
  pushed: number
  note: string
  skipped?: string
}> {
  const r = await runAuto(db, nativePorts, '后台自动同步', { gateAuto: true })
  return r.ran
    ? { applied: r.applied, pushed: r.pushed, note: r.note }
    : { applied: 0, pushed: 0, note: r.note, skipped: r.why ?? 'skip' }
}

// ── 引擎接口（原生调用）───────────────────────────────────────

interface LookupArgs {
  kind: LookupKind
  term: string
  sentence: string | null
}
interface SaveArgs {
  term: string
  quote: string | null
  pkg: string | null
  /**
   * ★ 裁决 ⑩（2026-09-01）：**新收下的一律默认认读 A，不记忆上一次**。
   *   所以原生**不传**这个字段 —— 默认在下面那一行，和 App 那侧
   *   （`Assist.svelte` 的 `layer = 'A'`）同一条。原生原来是自己读
   *   `settings.assist.lastLayer` 决定默认层的，与裁决 ⑩ 正相反（T-6.1 / R-004）。
   *   将来气泡长出翻层按钮，才由它显式传 'B'。
   */
  layer?: 'A' | 'B'
}
interface StatusArgs {
  term: string
}

async function run(op: string, args: unknown): Promise<unknown> {
  if (op === 'lookup') {
    const a = args as LookupArgs
    /**
     * D-362 · 选词即一次查询动作：quick 记一笔（full/dict 是同一次的追加面，不重记）。
     *
     * ★★ I-144（真机 2026-09-07）· **按形态记，别把整段当成一个词。**
     *
     * 这里原来一律 `ledgerOp(db, 'lookup', 'term', null, a.term)` —— 不看形态。
     * 真机上宿主把**整段正文**报成了选区（61 ms 内第二次 `lookup`，159 / 281 字符），
     * 于是那一整段以 `target='term'`、`title=<整段>` 进了流水，
     * 并且出现在 Lookup 首页的「最近查过」里。
     *
     * 形态判据用既有的 `shapeOf`（`db/lookup.ts` 那一份，`assistLookup` 自己也在用）：
     *   词 / 词组  → 照旧 `target='term'`，`title` 就是那个词
     *   整句 / 整段 → `target` 记形态，**`title` 留空**
     *
     * ★ 为什么整句整段**不存原文**：一是「最近查过」承诺的是词（`title` 空它自然不列）；
     *   二是那 281 字符是第三方 App 屏幕上的正文 —— 流水要的是「他做了一次查询」
     *   这个事实，不是把别人的帖子抄进库里（D-335 那条不后台读屏的同一个态度）。
     *   「一共查过几次」按 `op` 数，不受影响。
     * ★ T-4.14 · 同一行还记下**从哪查 · 哪一面**（detail 三字段，形状同样在
     *   `ledger.ts::noteLookup` 一份）：气泡这条路永远是 source=assist；
     *   face 只会是 quick —— full / dict 是同一次的追加面，本来就不重记。
     */
    if (a.kind === 'quick') {
      await noteLookup(db, a.term, { source: 'assist', face: 'quick' }).catch(() => {})
    }
    const r = await assistLookup(db, a.kind, a.term, a.sentence)
    return { sections: r.sections, note: r.note ?? null, miss: r.miss ?? false }
  }
  if (op === 'tts') {
    /**
     * 发音按钮（指令第九则 · 十~十三 · D-406④）—— **Assist 引擎执行器**。
     *
     * ★★ 顺序由 `core/voice/resolve.ts` 排、预算由 `core/voice/run.ts` 执行，
     *   装配（两把开关 + 写死的先后）在 `db/voice.ts` —— 与 App 执行器**同一份**。
     *   这一段只回答「这一步在引擎里具体怎么做」。
     *
     * ★ D-466 起只有两档：词典音 → 系统音。引擎这一侧不再有网络那条路，
     *   所以它的字节通道（`httpStartBase64`）连同 Java 那一半一起拆了。
     *
     * ★ `system` 那一步返回的不是字节，是**一句「请你现读」**：
     *   系统 TTS 是 Java 的 `TextToSpeech`，引擎里没有。它是最后一根稻草
     *   （`budgetMs === null`），所以交回原生正好是序列的终点。
     */
    const a = args as { text: string; flip?: boolean; kind?: VoiceKind }
    const p = await ttsPrefs(db)
    const { plan, result } = await runVoice(
      db,
      a.text,
      {
        // 引擎一直有原生真随机读（D-404 那条通道）—— 与 App 报的可能不同，
        // 这是**有意的**：能不能跑是事实，不为了两端一致伪造
        dictionary: true,
        system: true
      },
      {
        dictionary: dictionaryStep(db, p, a.flip),
        system: systemStep(p)
      },
      { ...(a.kind ? { kind: a.kind } : {}), origin: 'assist', flip: a.flip ?? false }
    )
    const { pronWhy, pronStats } = await import('../db/dict.ts')
    /**
     * 形状与 T-7.5 之前保持一致（audioB64 / accent+rate），只多带账。
     * ★ T-6.5 多带一样 `pronStats`：词典那一步扫了几本、其中几本是**现开的**
     *   （缓存只驻 `MDX_CACHE_MAX` 本，多了就每次逐出重开 = 索引重建）。
     *   原生侧把它与 `tried` 一起写进 probe.txt —— 那两个数就是审计要的答案。
     *   **纯计数，不参与任何判断**：拿掉它，这一段的行为一模一样。
     */
    const base = {
      source: result.source,
      tried: result.tried,
      /**
       * ★ T-7.9 · 运行账本一起交回原生（`NyxAssistService` 写进 probe.txt）。
       *   比 `tried` 多的是**被跳过的那几步与原因** —— 「为什么没用云端」
       *   的答案往往在这里，而以前整条链上没有地方答得出来。
       */
      trace: result.trace,
      why: explainVoice(result) || pronWhy,
      pronStats
    }
    if (result.value?.kind === 'audio') {
      return { ...base, audioB64: result.value.b64, from: result.value.from ?? null }
    }
    if (result.value?.kind === 'system') {
      return { ...base, accent: result.value.accent, rate: result.value.rate }
    }
    // 一步都没排上（他把来源全关了，或这台机器上都用不了）—— 如实说，不假装读
    return { ...base, why: plan.attempts.length === 0 ? plan.why : base.why }
  }
  if (op === 'dictFollow') {
    // 方框链跨词条跳（entry://词#锚）。语法判据 = parseEntryLink **一份**——
    // 原生那边只认协议前缀，不许把这套语法在 Java 里再写一遍（三·「最贵的事故形态」）
    const a = args as { href: string }
    const link = parseEntryLink(String(a.href ?? ''))
    if (!link || !link.word) throw new Error('这不是词典条目的跳转链接')
    const r = await assistLookup(db, 'dict', link.word, null)
    return {
      word: link.word,
      anchor: link.anchor,
      sections: r.sections,
      note: r.note ?? null,
      miss: r.miss ?? false
    }
  }
  if (op === 'dictSound') {
    // 词条里点的 sound:// 链接（例句/词头都可能）—— 键逐字来自链接（D-406⑧ 同一课：
    // 不猜文件名），到各书数字卷里按需读那一块。miss 如实带 why 回去。
    const a = args as { path: string }
    const b = await dictSoundBytes(db, String(a.path ?? ''))
    if (b) return { audioB64: b }
    const { pronWhy } = await import('../db/dict.ts')
    return { miss: true, why: pronWhy }
  }
  if (op === 'status') {
    /**
     * L0 ·「Nyx 里有没有它、挂在哪一讲」—— **判据一份**：`capture.ts::assistStatus`。
     *
     * ★ T-6.1（R-004）：这条以前是原生自己写的一句 SELECT，和这一份漂了 ——
     *   它漏了 `il.deleted_at is null`。V36 起「把一条知识点从这一讲移出去」
     *   是**软删**（`core/sql/item-lectures.ts` 的整个理由），行还在，
     *   于是气泡照旧报着**已经移出去的那一讲**的名字。
     *   现在原生只负责把词交出来、把答复画出来。
     */
    const a = args as StatusArgs
    return await assistStatus(db, String(a.term ?? ''))
  }
  if (op === 'save') {
    const a = args as SaveArgs
    // ★ T-5.9② · `'assist'` = 这一条是气泡收的，落点走 Assist 那一侧的默认位置
    const r = await assistCapture(db, a.term, a.layer ?? 'A', a.pkg, 'assist', null, a.quote)
    return { path: r.pathLabel, dup: r.duplicateOf !== null, id: r.id }
  }
  if (op === 'analysis') {
    /**
     * ★ T-5.13 · 后台把没做完的那一批**接着跑一段**（`AnalysisWorker` 调它）。
     *
     * 跑的是同一个执行器（`db/analysis-runner.ts`）与同一份判据 ——
     * 原生那侧只管「什么时候醒、给多少预算、跑完怎么收」，一行业务逻辑都没有。
     * 没有未完批次就安静返回 `idle`：Worker 会被无条件排上，
     * 「这次没什么可做」不是错，不该 retry。
     */
    const a = args as { budgetMs?: number }
    const { resumeBatch } = await import('../db/analysis-runner.ts')
    const r = await resumeBatch(db, a.budgetMs)
    return {
      ran: r.ran,
      why: r.why ?? null,
      left: r.state?.queue.length ?? 0,
      done: r.state?.done ?? 0,
      failed: r.state?.failed.length ?? 0,
      status: r.state?.status ?? null
    }
  }
  if (op === 'sync') {
    // F-003 · 后台周期同步（WorkManager → SyncWorker → 这里）
    return await syncOnce()
  }
  throw new Error('引擎不认识这个请求：' + op)
}

/**
 * ★★ T-6.6 第二段 · **默认词典的索引什么时候预热。**
 *
 * 要开的书只有一本（`prewarmPronounce` 自己挑），但开它是**同步**的
 * （`nyxHost.dictRead`）—— 那几秒里引擎这条 JS 线程什么都答不了。
 * 所以问题不是「开不开」，是**插在哪个缝里**。三个候选，我选了第三个：
 *
 * ① `warm()` / `ready()` 那一刻 —— **不行**。那正是他刚拨亮星、马上要选第一个词
 *    的时刻：这几秒会直接压在**第一次取词的回应**上，气泡迟迟不出来。明令不许。
 * ② 第一条 `status` 答完 —— **不行**。选区落定后原生连着发两条：`status`
 *    （本地一句 SELECT，很快）与 `lookup quick`（走 AI，**在这条 JS 线程上 await**）。
 *    插在两者之间，挡住的就是 `httpDone` —— 他看着的「正在理解…」原地卡住。
 * ③ **第一条 `lookup` 答完** ← 用的是这条。气泡已经有内容、人在读它，这才是真空闲。
 *    ★ 就算他此刻马上去点喇叭：那一趟等的也不过是这同一本书的冷开，与没有预热时
 *      一样多，**不会更差**；他但凡晚一点点点，就全省下了。
 *
 * ★ 只排一次：引擎的 JS 上下文与那个无头 WebView 同生共死（服务 `onDestroy` 才拆），
 *   索引开过就一直在，而且被 `pinDictionary` 钉住不逐出。
 * ★ 延时 0 = 「当前这批任务跑完就轮到你」，不是猜一个毫秒数。
 * ★ 预热失败只写一行探针 —— 它不在任何人的关键路径上，绝不许影响别的事。
 */
let prewarmQueued = false
function schedulePrewarm(op: string): void {
  if (prewarmQueued || op !== 'lookup') return
  prewarmQueued = true
  setTimeout(() => {
    void prewarmPronounce(db)
      .then((r) => {
        /**
         * ★ 两种情况印成**不同的词**，别让人对着 `opened=false` 猜：
         *     opened=true  这一趟真的建了索引（那几秒就是它省下来的）
         *     cached=true  它本来就在缓存里（之前查过词典页或发过音）——
         *                  这一趟只做了「钉住」，见 `prewarmPronounce` 头注
         */
        host.probe(
          r === null
            ? 'dict prewarm skip=没有一本带音频卷的书'
            : `dict prewarm ${r.book} ${r.opened ? 'opened=true' : 'cached=true'} ${r.ms}ms` +
              (r.err ? ' err=' + r.err : '')
        )
      })
      .catch((e: unknown) => host.probe('dict prewarm failed ' + String(e)))
  }, 0)
}

const engine = {
  call(seq: number, op: string, argsJson: string): void {
    void (async () => {
      try {
        const out = await run(op, JSON.parse(argsJson || '{}'))
        host.result(seq, true, JSON.stringify(out))
      } catch (e) {
        // AiError 带结构化失败态（D-205 四种）—— 标题给人看，详情留给「怎么办」
        const err =
          e instanceof AiError
            ? { title: e.failure.title, detail: e.failure.detail, kind: e.failure.kind }
            : { title: (e as Error)?.message ?? String(e), detail: '', kind: 'server' }
        host.result(seq, false, JSON.stringify(err))
      }
      // ★ 摆在 result 之后：答复先出去，预热只用它之后的空闲（理由见上）
      schedulePrewarm(op)
    })()
  },
  httpDone(id: number, status: number, text: string, err: string): void {
    const f = pending.get(id)
    if (!f) return
    pending.delete(id)
    f({ status, text, err: err || null })
  },
}

;(globalThis as unknown as { nyxEngine: typeof engine }).nyxEngine = engine
host.ready()
