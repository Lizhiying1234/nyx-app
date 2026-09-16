/**
 * ══ PN · 资产端口：每一个名字都先过判据（F-5 · B-3 · 2026-09-14）★★ ═══════
 *
 * ── 它挡的是哪一种事故 ───────────────────────────────────────
 * 端口拿到的 `name` **不是本机产物**：它来自云端的清单与碑，跑过网络、进过 JSON。
 * 而拼路径那一步对 `../` 不会拦一下 —— 一个构造出来的名字就能让 Nyx
 * 把**本机任意文件**读出来当成资源传上桶，或者把正文写到目录外面去。
 *
 * ── 为什么不能只断言「回了 null」★★★ ─────────────────────────
 * 这是本轮对账里 Windows 那条教训的 Android 版（收敛结论 ④）：
 *   他们新写的端口用例里，坏名字是 `../evil.webp` 而靶子叫 `keep.webp` ——
 *   **两个名字根本不指同一个文件**，越界删除删的是个不存在的东西，
 *   `force:true` 之下无声无息，**拆掉守卫那条照样绿**。
 * 所以这一组：
 *   ① 先**当场证明**坏名字和靶子指的是同一个文件（`audio/../secret.mp3` → `secret.mp3`）
 *   ② 再断言端口拿不到它
 * 拆掉 `read` 那一行守卫的话，端口会把 `U0VDUkVU`（base64 的 `SECRET`）吐出来 ——
 * 那一刻断言拿到的是**真的正文**，不是「拿不到所以是 null」。
 *
 * ── 为什么用内存版 io ───────────────────────────────────────
 * 真那份走 Capacitor `Filesystem`，Node 里起不来。端口 2026-09-14 提成了工厂
 * （`audioPort(io)`），就是为了这条对照能真的跑起来 ——
 * 否则「守卫拆了会怎样」永远只能靠读代码想象。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripSource } from '../tools/lib/strip-comments.mjs'
import { posix } from 'node:path'
import { AUDIO_DIR, audioPort, type AssetIo } from '../src/db/sync-ports.ts'

/** 内存文件系统：键是**规范化之后**的路径 —— 「目录外」在这儿是真的目录外 */
function memIo(seed: Record<string, string> = {}): AssetIo & {
  files: Map<string, string>
  asked: string[]
} {
  const files = new Map(Object.entries(seed))
  const asked: string[] = []
  return {
    files,
    asked,
    ensureDir: async () => {},
    readdir: async (dir: string) =>
      [...files.keys()].filter((k) => k.startsWith(dir + '/')).map((k) => k.slice(dir.length + 1)),
    read: async (path: string) => {
      asked.push(path)
      return files.get(posix.normalize(path)) ?? null
    },
    write: async (path: string, b64: string) => {
      asked.push(path)
      files.set(posix.normalize(path), b64)
    }
  }
}

/** base64 的 `SECRET` —— 拆掉守卫时端口吐出来的就是这个 */
const SECRET = 'U0VDUkVU'
/** 目录**外面**那个文件 */
const OUTSIDE = 'secret.mp3'
/** 坏名字：`audio/../secret.mp3` 规范化之后正好是上面那个文件 */
const BAD = '../' + OUTSIDE
/** 本机命名规则真能产生的名字：40 位小写十六进制 + .mp3 */
const GOOD = 'a'.repeat(40) + '.mp3'

describe('PN · 音频端口：名字先过判据（F-5）', () => {
  it('★★★ 坏名字与靶子指的是同一个文件 —— 这一条先立，不然下面两条是哑的', () => {
    assert.equal(
      posix.normalize(AUDIO_DIR + '/' + BAD),
      OUTSIDE,
      '★ 坏名字拼出来没落到靶子上 —— 那下面那条拆了守卫也照样绿（收敛结论 ④）'
    )
  })

  it('★★ read：目录外那个文件读不出来（拆掉守卫这条会吐出 SECRET）', async () => {
    const io = memIo({ [OUTSIDE]: SECRET })
    const got = await audioPort(io).read(BAD)
    assert.equal(
      got,
      null,
      '★★ 端口把 audio/ 外面的文件读出来了 —— 它会被当成资源传上桶'
    )
    assert.deepEqual(io.asked, [], '★ 名字不合规就不该去碰文件系统（判据在碰之前）')
  })

  it('★★ write：写不到目录外面去（拆掉守卫这条会把靶子覆盖掉）', async () => {
    const io = memIo({ [OUTSIDE]: SECRET })
    await audioPort(io).write(BAD, 'QUFB')
    assert.equal(
      io.files.get(OUTSIDE),
      SECRET,
      '★★ 端口把 audio/ 外面那个文件覆盖了'
    )
    assert.deepEqual(io.asked, [], '★ 名字不合规就不该去碰文件系统')
  })

  it('★ 正向：合规的名字照常读写（守卫不是「一律返回 null」）', async () => {
    const io = memIo()
    await audioPort(io).write(GOOD, 'QUFB')
    assert.equal(io.files.get(AUDIO_DIR + '/' + GOOD), 'QUFB', '★ 合规的名字没写进去')
    assert.equal(await audioPort(io).read(GOOD), 'QUFB', '★ 合规的名字读不回来')
    assert.deepEqual(await audioPort(io).list(), [GOOD], '★ list 列不出刚写进去的那一个')
  })

  it('★ 端口里那两道守卫是**它自己**的，不是靠调用方记得先验', () => {
    /**
     * ★ F-5 那句话：上一版写的是「名字已过白名单（引擎在调它之前验）」——
     *   那是把一道安全闸寄存在「调用方会记得先验」上。
     *   这一条盯的就是那句话不许回来。
     */
    /**
     * ★★★ 先剥注释再扫（ZA-1 · 2026-09-15）。
     *   探针量过：把 `write` 那道真守卫拿掉、在原地留一条提到 `checkAudioName`
     *   的注释 —— **这条数出现次数的断言照样绿**（注释顶替了一道真守卫）。
     *   当时红的是另一条行为用例，不是它；也就是说这条断言**自己是哑的**。
     * ★ 剥注释那份判据只有一处（`tools/lib/strip-comments.mjs`），
     *   它认字符串、不剥字面量 —— 剥了会把 `'checkAudioName'` 这种活的判死。
     */
    const src = stripSource(
      readFileSync(new URL('../src/db/sync-ports.ts', import.meta.url), 'utf8'),
      'sync-ports.ts'
    )
    const port = /export function audioPort[^]*?^}/m.exec(src)?.[0] ?? ''
    assert.ok(port.length > 0, '★ audioPort 没了')
    assert.equal(
      (port.match(/checkAudioName/g) ?? []).length,
      2,
      '★★ read / write 里那两道守卫不是两条了 —— 少一条就是「同一道闸只守住一端」'
    )
    // ★ 而且要**在碰文件系统之前**问：顺序反了等于没问
    for (const m of ['read', 'write']) {
      const at = port.indexOf('async ' + m + '(name')
      assert.ok(at >= 0, `★ audioPort.${m} 没了`)
      const body = port.slice(at, port.indexOf('},', at))
      const guard = body.indexOf('checkAudioName')
      const touch = body.indexOf('io.')
      assert.ok(guard >= 0, `★★ audioPort.${m} 没问名字判据`)
      assert.ok(
        touch < 0 || guard < touch,
        `★★ audioPort.${m} 先碰了文件系统才问名字 —— 顺序反了等于没问`
      )
    }
  })
})

describe('PN · 启动页端口：五个方法各自守名字（本端早就这样，钉住别掉）', () => {
  /**
   * ★ 这一端的 splash 端口是转给 `db/splash-files.ts` 的，五个出口
   * （list / read / write / delete / url）**每一个第一行都是 `checkSplashName`**。
   * 它们真的碰 Capacitor，Node 里跑不起来 —— 所以这条只能读源码。
   * ☞ 闸的名字不许比断言大（H-3 乙）：这条**只**证明「每个出口都问了判据」，
   *   不证明文件系统层面拦住了。行为那一半在上面那组（音频端口，io 可换）。
   */
  const src = readFileSync(new URL('../src/db/splash-files.ts', import.meta.url), 'utf8')
  for (const fn of [
    'listSplashFiles',
    'readSplashFile',
    'writeSplashFile',
    'splashFileUrl',
    'deleteSplashFile'
  ]) {
    it(`★ ${fn} 自己问过 checkSplashName`, () => {
      const body = new RegExp('function ' + fn + '[^]*?^}', 'm').exec(src)?.[0] ?? ''
      assert.ok(body.length > 0, `★ ${fn} 没了`)
      assert.match(body, /checkSplashName/, `★★ ${fn} 不问名字判据了 —— 一个 ../ 就能出目录`)
    })
  }
})
