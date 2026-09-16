/**
 * 名字表的**键形转换** + **判据只有 core 那一份**（2026-09-13）
 *
 * ── 为什么键形要一道自己的闸 ────────────────────────────────
 * 引擎认的键是**桶里那个资源名**：`<64 位小写十六进制>.<扩展名>`。
 * 本机那张表的键是 `encodeSplashChoice(c)` —— 用户图那些**多一个 `user:` 前缀**。
 *
 * ★★ 忘了剥的后果：带前缀的键过不了引擎那道 `checkSplashName`，
 *    **一张名字都传不上去，而且不报错** ——
 *    类型对、用例绿、界面照常、同步也报「成功」，只是什么都没发生。
 *
 * ── 还盯着：内置那两档不许被改形 ────────────────────────────
 * 「出厂插画」在手机上可以改名，那个名字是**这台机器自己的叫法，不进桶**。
 * 走的是「整表递过去、整表覆盖」那条路：引擎把它原样留在 `next` 里，
 * 推那一步因为 `checkSplashName('shipped')` 不过而跳过它。
 * 所以**它必须原样穿过这两个函数** —— 被加上前缀或被剥掉都会出事。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { deleteSplashFile } from '../src/db/splash-files.ts'
import { encodeLabels, decodeLabels } from '../src/core-link.ts'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromBucketKeys, toBucketKeys, USER_PREFIX } from '../src/db/splash.ts'
import type { SplashName } from '../src/db/splash.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) srcFiles(p, out)
    else if (/\.(ts|svelte)$/.test(e.name)) out.push(p)
  }
  return out
}

const SHA = 'a'.repeat(64)
const L = (label: string, at = 1): SplashName => ({ label, at })

describe('SPLASH 名字 · 本机键 ↔ 桶里的键', () => {
  it('① 出去剥前缀，回来加回去', () => {
    const mine = { [`${USER_PREFIX}${SHA}.webp`]: L('海边') }
    const bucket = toBucketKeys(mine)
    assert.deepEqual(bucket, { [`${SHA}.webp`]: L('海边') }, '★ 前缀没剥 —— 一张都传不上去')
    assert.deepEqual(fromBucketKeys(bucket), mine, '★ 回来没加回去 —— 本机认不出它属于哪张图')
  })

  it('★ ② 内置那两档原样穿过（它们不进桶，但不许被改形）', () => {
    const mine = { shipped: L('我的开机图'), icon: L('水獭') }
    assert.deepEqual(toBucketKeys(mine), mine, '★ 内置档被剥/加了前缀')
    assert.deepEqual(fromBucketKeys(mine), mine, '★ 内置档被加了 user: —— 那会让它被当成一张图推上桶')
  })

  it('③ 混着来也对，而且往返是恒等的', () => {
    const mine = {
      shipped: L('我的开机图', 7),
      [`${USER_PREFIX}${SHA}.png`]: L('山', 8),
      [`${USER_PREFIX}${'b'.repeat(64)}.jpg`]: L('海', 9)
    }
    assert.deepEqual(fromBucketKeys(toBucketKeys(mine)), mine, '★ 往返丢东西了')
  })

  it('★ ④ 桶里来的键**只有合规资源名**才加前缀', () => {
    // 引擎推之前也验一道，但这一层不能靠对面守规矩
    const out = fromBucketKeys({
      [`${SHA}.webp`]: L('真图'),
      shipped: L('内置'),
      'not-a-name': L('怪东西'),
      [`${'A'.repeat(64)}.webp`]: L('大写十六进制不算')
    })
    assert.equal(out[`${USER_PREFIX}${SHA}.webp`]?.label, '真图')
    assert.equal(out['shipped']?.label, '内置')
    assert.equal(out['not-a-name']?.label, '怪东西', '★ 不认得的键该原样留着，不该凭空变成一张图')
    assert.equal(out[`${'A'.repeat(64)}.webp`]?.label, '大写十六进制不算')
  })
})

describe('SPLASH 名字 · 判据只有 core 那一份（不许留备份）', () => {
  /**
   * 同侪（Windows）提醒的一条，原样记下来：
   *   「把你自己那份 defaultLabel 的实现删掉，别留着当『备份』——
   *     留着的那一份迟早会被下一个人改，然后两端默认名不一致，
   *     而那看起来就像同步坏了。」
   * 洗名字的上限同理：一端 16 一端 40 的话，长名字在这端被截短、
   * 再同步回去**字就少了**，而且没有任何地方会报。
   */
  const SRC = srcFiles(join(ROOT, 'src'))

  /**
   * 注释里提这些名字是**应该的** —— 那正是记账的地方
   *（「此前有自己那一份、2026-09-13 全删」「pickLabel 故意不引」都写在注释里）。
   * 所以扫之前先剥掉注释，只看真代码。写这道闸时当场踩了一次。
   */
  const codeOf = (f: string): string =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')

  it('① 不许有第二份「默认名」的算法', () => {
    const bad: string[] = []
    for (const f of SRC) {
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const t = line.trim()
          if (t.startsWith('*') || t.startsWith('//')) return
          if (/图 \$\{[^}]*slice\(/.test(line)) bad.push(`${f.slice(ROOT.length + 1)}:${i + 1}`)
        })
    }
    assert.deepEqual(bad, [], '★ 这里自己算了默认名 —— 引 core 的 defaultLabel')
  })

  it('② 不许有第二份「洗名字 / 名字上限」', () => {
    const bad = SRC.filter((f) => /cleanSplashName|SPLASH_NAME_MAX/.test(codeOf(f)))
      .map((f) => f.slice(ROOT.length + 1))
    assert.deepEqual(bad, [], '★ 本仓自己那份洗名字的实现回来了 —— 用 core 的 cleanLabel / MAX_LABEL')
  })

  it('★ ③ `pickLabel`（谁赢）不许在这一端出现', () => {
    const bad = SRC.filter((f) => /pickLabel/.test(codeOf(f)))
      .map((f) => f.slice(ROOT.length + 1))
    assert.deepEqual(
      bad,
      [],
      '★ 端口这边调了 pickLabel —— 那是引擎内部的判据，这边再判一次就是同一件事两份'
    )
  })
})

describe('SPLASH · 屏上说的和代码里接的必须一致', () => {
  // ★★ 真机上抓到的：名字同步接上了（`sync-ports.ts` 的 `splashLabels`），
  //   可启动页那一屏还写着「名字也一样，只在这台机器上」—— **屏上说的是假话**。
  //   使用者照着那句话理解，就会以为在电脑上改名不会传过来（D-412 诚实原则）。
  //   这一类没有任何东西会红：文案是字符串，接线是代码，两边各自都说得通。
  const root = new URL('../', import.meta.url)
  const ports = readFileSync(new URL('src/db/sync-ports.ts', root), 'utf8')
  const screen = readFileSync(new URL('src/ui/views/Settings.svelte', root), 'utf8')

  it('名字接了同步 → 屏上不许说它只在这台机器上', () => {
    const wired = ports.includes('splashLabels')
    assert.ok(wired, '★ 前提变了：splashLabels 不在端口里了，这条闸要重写')
    assert.ok(
      !screen.includes('名字也一样，只在这台机器上'),
      '★ 名字是同步的，屏上却说它不同步'
    )
    assert.ok(screen.includes('名字会同步'), '★ 得把「名字会同步」这件事说出来')
  })

  it('★ 选哪一张确实不同步 —— 这半句是真的，别一起改掉', () => {
    // ★ 负向的一半：`splash.active` 存在 settings（设备本地），确实不进同步。
    //   改文案时容易把两句一起改成「都同步」，那就从一个假话换成另一个假话。
    assert.ok(!ports.includes("'splash.active'"), '★ 选中项不该出现在同步端口里')
    assert.ok(screen.includes('不跟着同步走'), '★ 「选了哪一张不同步」这半句得留着')
  })
})

describe('SPLASH-DEL · 服从删除（使用者 2026-09-14 裁「选 a：连云端一起删」）', () => {
  /**
   * ★★ `AssetPort.delete` 是**必填**的，所以「没接」编译期就喊 —— 那一半不用闸。
   *   这几条钉的是编译器看不见的三件：**幂等 · 不抛 · 名字要过白名单**。
   *   它们错了全是安静的：抛出去会把**整趟同步带停**（而代价只是这一张图这轮没删掉）；
   *   不验名字的话，一个 `../` 就能顺着删到别处去 —— 这里是「拿外部名字拼本地路径」
   *   的地方之一，读写都验过，删也得验。
   */
  const OK = 'b142e4caf1d6c50d38b4408401892c79febfb8007988dee85d59150d3ab59089.webp'

  it('★ 文件本来就不在 = 成功（幂等），一个字都不抛', async () => {
    // 真机上没有这张图；同步能中途断能重跑，「删一个已经没有的」必须安全
    await assert.doesNotReject(() => deleteSplashFile(OK))
  })

  it('★★ 名字不合规 → 安静不做，更不许抛', async () => {
    for (const bad of ['../secrets.txt', 'x.webp', 'ABC.webp', OK + '.meta.json', '']) {
      await assert.doesNotReject(() => deleteSplashFile(bad), `★ ${bad} 让它抛了`)
    }
  })

  it('★★★ 端口把 delete 接上了，而且接的是服从那一半（不是界面按钮）', () => {
    const ports = readFileSync(new URL('../src/db/sync-ports.ts', import.meta.url), 'utf8')
    assert.match(ports, /delete:\s*deleteSplashFile/, '★ splash 端口没接 delete')
    const screen = readFileSync(new URL('../src/ui/views/Settings.svelte', import.meta.url), 'utf8')
    // ★ 文案与实现必须一致：墓碑做出来之后，「删不掉 / 资源没有墓碑」那句就成了假话
    assert.ok(!screen.includes('资源没有墓碑'), '★ 屏上还写着「资源没有墓碑」—— 墓碑已经有了')
    assert.ok(!screen.includes('同步过来的图<b>删不掉</b>'), '★ 屏上还写着「删不掉」')
    assert.ok(screen.includes('在电脑上删'), '★ 得告诉他去哪儿删')
  })
})

describe('SPLASH-TOMB · 墓碑要穿得过这一端的两层（键形 + 存取）', () => {
  /**
   * ★★★ 这一条钉的是**我自己写的那两层会不会把 gone 吃掉**。
   *
   * 序列化交给 core（`encodeLabels` / `decodeLabels`），但**键形转换是这一端自己的**
   * （桶里是资源名，本机表带 `user:` 前缀）。哪天有人把 `out[k] = v` 改成
   * `out[k] = { label: v.label, at: v.at }`（看着更"干净"），墓碑就没了 ——
   * 而症状是**删除静静地只在一端生效**：他在电脑上删了，手机这边永远不跟着删。
   * 类型不一定管得住（多一个可选字段，少传也编译得过）。
   *
   * ★ 三态也一起钉：**缺失 ≠ false**。压成 false 的话，任何一条老 meta 都能
   *   压过对面刚写的碑（`pickLabel` 比的是 `at`，但值一旦被填成 false 就等于表了态）。
   */
  const NAME = 'b142e4caf1d6c50d38b4408401892c79febfb8007988dee85d59150d3ab59089.webp'

  it('★ gone:true 穿过键形往返', () => {
    const back = toBucketKeys(fromBucketKeys({ [NAME]: { label: '我那张图', at: 1789400000000, gone: true } }))
    assert.equal(back[NAME]?.gone, true, '★ 键形转换把墓碑吃了')
    assert.equal(back[NAME]?.label, '我那张图', '★ 名字也得留着（图没了，名字跟着回来那次还要用）')
  })

  it('★ gone:true 穿过存取往返（encode → decode）', () => {
    const mine = fromBucketKeys({ [NAME]: { label: '我那张图', at: 1789400000000, gone: true } })
    const key = Object.keys(mine)[0]!
    const round = decodeLabels(encodeLabels(mine))
    assert.equal(round[key]?.gone, true, '★ 存一趟读回来墓碑没了')
  })

  it('★★ 三态：没表态的那条，gone 必须是 undefined，不许被压成 false', () => {
    const key = Object.keys(fromBucketKeys({ [NAME]: { label: 'x', at: 1 } }))[0]!
    const round = decodeLabels(encodeLabels({ [key]: { label: 'x', at: 1 } }))
    assert.equal(
      round[key]?.gone,
      undefined,
      '★★「取不到」被压成了 false —— 那样任何一条老 meta 都能压过对面刚写的碑'
    )
  })
})
