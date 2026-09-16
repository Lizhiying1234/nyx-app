/**
 * ══ MH · 镜像交接：TS 写出来的，内联脚本读得回同一个值（G-3）★★★ ═══════
 *
 * ── 它治的是哪一种病 ────────────────────────────────────────
 * 启动那一帧在**开库之前**画，所以它读 `localStorage` 镜像，而且只能写成
 * `index.html` 里那段手写内联脚本（JS 包还没起来，import 不进去）。
 * 于是同一个格式有两个当事人：写的是 TS，读的是内联脚本 ——
 * **两处各写一遍，中间没有任何东西把它们钉在一起。**
 * 格式一改，活的那个手动改，另一个静静漂走（收敛结论 D-3 变种二）。
 *
 * ── 这一组怎么钉 ────────────────────────────────────────────
 * 用**同一份 fixture**（`tests/fixtures/mirror.ts`）走一整趟：
 *   ① 用**真的写入面**（`setSplashChoice` · `writeSplashUrlMirror` · `colors.writeMirror`）
 *      把样例写进一个假的 `localStorage`
 *   ② 把 `index.html` 里那段内联脚本**原文**取出来，在同一个假 `localStorage` 上真跑一遍
 *   ③ 断言它读出来的就是①写进去的那个值
 * 格式改一处（键名 / 编码 / 前缀），①②对不上，这一组当场红 —— **两边同红**。
 *
 * ★ 跑的是脚本**原文**，不是抄一份：抄一份就又是「两份判据」，而且抄的那份永远绿。
 * ★ 只有这一组能替内联脚本说话：`npm run check` 的 svelte-check 看不见 HTML 里的 JS。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { setSplashChoice, writeSplashUrlMirror } from '../src/db/splash.ts'
import { writeMirror as writeColorMirror } from '../src/db/colors.ts'
import { FIX_CHOICE, FIX_OVERRIDES, FIX_URL } from './fixtures/mirror.ts'
import { builtDb, cleanup } from './helpers.ts'

after(cleanup)

/** 假 localStorage —— 写那一侧和读那一侧共用这一个 */
function fakeStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    }
  } as Storage & { map: Map<string, string> }
}

/** `index.html` 里那段内联脚本的**原文**（不是抄的） */
function inlineScript(): string {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const m = /<script>([^]*?)<[/]script>/.exec(html)
  assert.ok(m, '★ index.html 里那段内联脚本没了 —— 启动帧的读者就是它')
  return m![1] as string
}

interface RunOut {
  /** 屏上那一帧最后放进去的东西：'shipped' / 'icon' / 一个地址 */
  shown: string | null
  /** 内联脚本打上去的令牌 */
  vars: Record<string, string>
}

/** 在假 DOM + 假 localStorage 上真跑一遍那段脚本 */
function runInline(store: Storage): RunOut {
  const vars: Record<string, string> = {}
  let shown: string | null = null
  const clone = (kind: string): Record<string, unknown> => ({
    kind,
    cloneNode: () => ({ kind })
  })
  const box = {
    parentNode: null as unknown,
    innerHTML: '',
    appendChild: (n: Record<string, unknown>) => {
      shown = typeof n['src'] === 'string' && n['src'] !== '' ? String(n['src']) : String(n['kind'])
    }
  }
  const tpl = {
    content: {
      querySelector: (sel: string) => {
        const m = /data-nyx="([a-z]+)"/.exec(sel)
        return m ? clone(m[1] as string) : null
      }
    }
  }
  const document = {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => {
          vars[k] = v
        }
      }
    },
    getElementById: (id: string) =>
      id === 'nyx-splash' ? box : id === 'nyx-splash-src' ? tpl : null,
    createElement: () => ({ className: '', alt: '', src: '', onerror: null })
  }
  const ctx = vm.createContext({
    localStorage: store,
    document,
    setTimeout: () => 0,
    console
  })
  vm.runInContext(inlineScript(), ctx, { filename: 'index.html:inline' })
  return { shown, vars }
}

describe('MH · 镜像交接（写的是 TS，读的是内联脚本）', () => {
  it('★★★ 「我的图」：TS 写进镜像的地址，内联脚本原样拿回来并画上去', async () => {
    const store = fakeStorage()
    ;(globalThis as Record<string, unknown>)['localStorage'] = store
    const f = builtDb()

    // ① 真的写入面（他在设置页点中那张图时走的就是这两句）
    await setSplashChoice(f.db, FIX_CHOICE)
    writeSplashUrlMirror(FIX_URL)

    // ② 内联脚本原文，同一个 localStorage
    const out = runInline(store)

    // ③ 读回来的必须是写进去的那一个
    assert.equal(
      out.shown,
      FIX_URL,
      '★★★ 内联脚本没把他选的那张画上去 —— 写的那一侧和读的那一侧对不上了（键名 / 编码 / user: 前缀）'
    )
  })

  it('★★ 内置那一档：选「默认图标」→ 内联脚本挑的就是 icon 那张', async () => {
    const store = fakeStorage()
    ;(globalThis as Record<string, unknown>)['localStorage'] = store
    const f = builtDb()
    await setSplashChoice(f.db, { kind: 'icon' })
    writeSplashUrlMirror(null)
    assert.equal(runInline(store).shown, 'icon', '★ 选了图标却没画图标')
  })

  it('★★ 配色：TS 写进镜像的覆盖，内联脚本原样打成 CSS 变量', () => {
    const store = fakeStorage()
    ;(globalThis as Record<string, unknown>)['localStorage'] = store

    writeColorMirror(FIX_OVERRIDES)
    const { vars } = runInline(store)

    for (const [k, v] of Object.entries(FIX_OVERRIDES)) {
      assert.equal(
        vars['--' + k],
        v,
        `★★ 内联脚本没读回 ${k} —— 启动时会先闪一下出厂色再跳（格式对不上了）`
      )
    }
  })

  it('★ 没写过镜像 → 走出厂那张，一个字都不许抛（第一次装 / 清过数据）', () => {
    const store = fakeStorage()
    ;(globalThis as Record<string, unknown>)['localStorage'] = store
    const out = runInline(store)
    assert.equal(out.shown, 'shipped', '★ 没设过的时候不该画别的')
    assert.deepEqual(out.vars, {}, '★ 没有覆盖就不该往根上打变量')
  })
})
