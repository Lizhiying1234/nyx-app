/**
 * 钉住一条**使用者的裁决**：启动页只出现一张图（2026-09-09）
 *
 * ── 为什么需要一道闸 ────────────────────────────────────────
 * 这一条**和写着的设计冲突**，所以它比一般的取舍更容易被改回去。
 * DS §12.0b 白纸黑字写的是「Android 有图 → 系统帧（图标）+ 应用帧（插画）」，
 * 理由也写得很有道理（两帧长得一样 = 白多等一次）。真机上那句话的结果是：
 * 先闪一只水獭，再闪一张插画 —— 两张图接连出现。
 *
 * 使用者原话（2026-09-09）：
 *   「为什么先是小熊，然后是闪过了出厂插画，我记得我说过，启动页只能保留一个」
 *   「既然和 DS §12.0b 有冲突，那么以我的裁决为准，我才是独裁人，我就要 1 个」
 *
 * 下一个会话很可能这样把它改回去：读到 DS §12.0b，看见 `nyx_splash_none`
 * 觉得「怎么把图标弄没了」，顺手指回 `@mipmap/ic_launcher_foreground` ——
 * **而且那看起来像是在修东西**。所以裁决钉在这里：要改，先来改这道闸。
 *
 * ── 这道闸保证三件事 ────────────────────────────────────────
 *   ① 系统那一帧不画图（指着那张全透明的 drawable，且那张真的透明）
 *   ② 应用那一帧**永远画**（不再有「图标那一档就不画」的分支）
 *   ③ 有下限也有上限：没有下限，唯一那一帧会一闪而过 = 等于没有启动页
 *
 * ── 它**不**保证什么 ────────────────────────────────────────
 * 不保证真机上系统那一帧真的什么都不画（ROM 可能不认透明图标）——
 * 那只有装机能证明，已在 2026-09-09 那一轮当场看过。这里守的是判据不被悄悄改掉。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const STYLES = r('android/app/src/main/res/values/styles.xml')
const NONE = r('android/app/src/main/res/drawable/nyx_splash_none.xml')
const SPLASH = r('src/ui/lib/Splash.svelte')
const INDEX = r('index.html')
const MAIN = r('src/ui/main.ts')
const FONTS = r('src/ui/styles/fonts.css')
const SETTINGS = r('src/ui/views/Settings.svelte')

/** 注释里提这件事是应该的（那正是记录裁决的地方），扫之前剥掉 */
function stripComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

describe('SPLASH · 启动页只出现一张图（使用者 2026-09-09 裁，与 DS §12.0b 冲突以他为准）', () => {
  it('① 系统那一帧不画图 —— 两套属性都指着那张全透明的 drawable', () => {
    const body = stripComments(STYLES)
    for (const attr of ['windowSplashScreenAnimatedIcon', 'android:windowSplashScreenAnimatedIcon']) {
      const m = new RegExp(`name="${attr}">([^<]+)<`).exec(body)
      assert.ok(m, `★ ${attr} 不见了 —— 不写这个属性系统会退回用带瓷砖的启动器图标，那是多一张图`)
      assert.equal(
        m[1],
        '@drawable/nyx_splash_none',
        `★ ${attr} 指到了 ${m[1]} —— 系统那一帧又开始画图了，启动就会变回两张`
      )
    }
    // 底色仍要和应用内那一帧同一个令牌，否则接缝处会闪一下
    assert.match(body, /name="windowSplashScreenBackground">@color\/nyx_bg</)
  })

  it('① 负向：那张 drawable 真的是透明的（指着一张不透明的等于没改）', () => {
    assert.match(NONE, /@android:color\/transparent/, '★ nyx_splash_none 不透明了')
  })

  it('② 应用那一帧画在 index.html 里 —— 第一帧就有图，不等 JS 包', () => {
    const body = stripComments(INDEX)
    assert.match(body, /id="nyx-splash"/, '★ 启动帧不在 index.html 里了')
    assert.match(
      body,
      /<template[^>]*id="nyx-splash-src"/,
      '★ 两张候选不在 template 里了 —— 那会让两张都发请求（template 内容不发）'
    )
    assert.match(body, /data-nyx="shipped"[^>]*src="[^"]*splash-illustration/, '★ 插画那一档没了')
    assert.match(body, /data-nyx="icon"[^>]*src="[^"]*splash-icon/, '★ 图标那一档没了')
    assert.match(body, /'nyx\.splash\.choice'/, '★ 不再按他选的那张挑图了')
    assert.match(body, /=== 'icon'/, '★ 图标那一档的分支没了')
    // ★ 「我的图」那一档（2026-09-13）：图从电脑同步过来，地址走另一份镜像
    assert.match(body, /'nyx\.splash\.url'/, '★ 「我的图」的地址镜像没了 —— 启动那一帧画不出同步来的图')
    assert.match(body, /indexOf\('user:'\)/, '★ user: 那一档的分支没了')
    assert.match(body, /8000\)/, '★ 兜底定时器没了：JS 包起不来时这一帧会永远挡着人')
  })

  it('★★ ② 负向：启动帧不许退回 Svelte 组件里画（那正是那 1 秒空白的来源）', () => {
    const body = stripComments(SPLASH)
    assert.ok(
      !/<div class="splash"|<img/.test(body),
      '★ Splash.svelte 又开始画标记了 —— 它要等 JS 包解析完才出现，空白就回来了'
    )
    assert.match(
      body,
      /getElementById\('nyx-splash'\)/,
      '★ 没人收走 index.html 那一帧了 —— 它会一直盖在应用上'
    )
  })

  it('★ index.html 里一个 HEX 都不许有（令牌只有一份）', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(INDEX)?.[1] ?? ''
    assert.ok(style.length > 0, '★ 启动帧的样式没了')
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(style), '★ 启动帧的样式里写了 HEX —— 颜色只许引令牌')
    assert.match(style, /var\(--color-bg\)/, '★ 底色不引令牌了，接不上系统那一帧')
  })

  it('③ 有下限也有上限 —— 没有下限，唯一那一帧会一闪而过', () => {
    const body = stripComments(SPLASH)
    assert.match(body, /minDone = true\), 500\)/, '★ 500ms 下限没了：库开得快时启动页会看不见')
    assert.match(body, /capDone = true\), 800\)/, '★ 800ms 上限被动了：这条没随本轮改，不该动')
    assert.match(body, /minDone && \(ready \|\| capDone\)/, '★ 走的条件被改了：下限必须是「与」')
  })

  it('④ 第一档不再叫「系统默认」—— 它已经和系统那一帧无关了（D-412 说真话）', () => {
    const body = stripComments(SETTINGS)
    const m = /const SPLASH_BUILTIN[\s\S]*?\n  \]/.exec(body)
    assert.ok(m, '★ 找不到内置候选清单（2026-09-13 起同步来的图是动态加的，内置那两档仍写死）')
    assert.match(m[0], /kind: 'icon' \}[^\n]*name: '默认图标'[^\n]*fixed: true/,
      '★ 第一档要么改回了「系统默认」（说假话），要么可以改名了（使用者说它不能改）')
    assert.match(m[0], /kind: 'shipped' \}[^\n]*name: '出厂插画'[^\n]*fixed: false/,
      '★ 出厂插画不能改名了 —— 使用者说除了内置那一档其余都能改')
  })
})

describe('SPLASH-NOW · 屏上数得出的「使用中」恰好一枚（连悬空那种）', () => {
  /**
   * ★★★ 「连桶一起删」之后冒出来的一个边角（2026-09-14 · 同侪问「会不会留个空壳」）。
   *
   * 先说**不成立的那一半**：候选清单是从**本机真实存在的文件**派生的
   * （`splashFiles.map(...)`），所以图一删，那一档自动从清单里消失，**没有空壳**。
   *
   * **成立的那一半**在另一处：`settings` 里的 `splash.choice` 还写着 `user:<那张>`。
   * 屏上「在用」是**两个记号**说的（文件头：「两种记号不共用，屏上数得出恰好一枚」）：
   *   · 底下那句「这台手机在用：X」—— `find(...) ?? 出厂插画`，**找不到会退回**
   *   · 卡上的「使用中」徽章 —— 改之前比的是**原始** id，悬空时**一枚都不亮**
   * 于是悬空状态下屏上数得出 **0 枚**，而底下那句说着「在用：出厂插画」—— 两处打架。
   *
   * ★ 修法是让两处看**同一个** `splashShownNowId`（悬空退回 `shipped`），
   *   而**库里那条故意不清**：它记着他本来要哪一张，图加回来时选择自动复原。
   */
  const src = readFileSync(new URL('../src/ui/views/Settings.svelte', import.meta.url), 'utf8')

  it('★ 两个记号必须看同一个值', () => {
    const badge = /\{#if\s+splashShownNowId === cand\.id\}/.test(src)
    const line = /SPLASH_CANDS\.find\(\(x\) => x\.id === splashShownNowId\)/.test(src)
    assert.ok(badge, '★ 卡上的「使用中」徽章还在比原始 id —— 悬空时一枚都不亮')
    assert.ok(line, '★ 底下那句还在比原始 id')
  })

  it('★★ 悬空要退回出厂插画，不是退回"没有"（判据引 core，本地不许再写一份）', () => {
    /**
     * ★★ B-1（2026-09-14）：这条原来盯的是本地那个三目的**字面**
     *   （`SPLASH_CANDS.some(...) ? splashNowId : 'shipped'`）。
     *   那份判据已经删了，改引 core `shownChoice` —— Windows `73d57b5` 起用的同一个函数。
     *   所以这条闸现在钉两件事：**用的是 core 那份** ＋ **本地没有第二份**。
     */
    const flat = src.replace(/\r?\n/g, ' ')
    assert.match(
      flat,
      /splashShownNowId = \$derived\(\s*encodeSplashChoice\(\s*shownChoice\(/,
      '★ 悬空退法不走 core 的 shownChoice 了 —— 要么一枚都不亮，要么又长出了第二份判据'
    )
    assert.match(
      flat,
      /shownChoice\(\s*splashChoice \?\? \{ kind: 'shipped' \},\s*SPLASH_CANDS\.map\(\(x\) => x\.c\)\s*\)/,
      '★ 递给 core 的两个参数不对：要「他选的那张」＋「现在真拿得出来的那几档」'
    )
    assert.ok(
      !/\?\s*splashNowId\s*:\s*'shipped'/.test(stripComments(src)),
      '★★ 本地又写回了一份退法 —— 同一条回退链两端各一份正是 D-238 要挡的'
    )
  })

  it('★★★ 库里那条不许被清掉（它记着他本来要哪一张）', () => {
    // ★ 负向的一半：最容易的"修法"是发现悬空就把 `splash.choice` 改写成 shipped。
    //   那会**抹掉他的选择** —— 图加回来（gone:false 压过旧碑）时他得重新挑一次。
    //   所以这一端只在**显示**上退回，不写库。
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(
      !/splashShownNowId[\s\S]{0,200}setSplashChoice/.test(body),
      '★ 有人在悬空分支里写库了 —— 那会抹掉他原来的选择'
    )
  })

  it('★★★ 悬空时还得说出「你选的那张不在了」—— 只说"在用出厂插画"是半个真话', () => {
    /**
     * ★ 这一条是同侪（Windows）指出来的：我第一版把两个记号统一成"在用出厂插画"，
     *   那句**是真的**，但它把「你选的那张没了」这件事**藏起来了** ——
     *   他只会觉得启动页莫名其妙换了（D-412：文案要说真话，不是只说不假的话）。
     *   他们那边底下那行原本就写着「(那张不在了)」，比我第一版诚实。
     * ★★ 后半句（"加回来会自动用回它"）同样不能省：库里那条选择**故意留着**，
     *   不说的话他会以为得重新挑一次 —— 那正好抵消了留着它的全部价值。
     */
    assert.match(src, /splashShownNowId !== splashNowId/, '★ 悬空这个分支没了，那半句永远不会出现')
    assert.ok(src.includes('你之前选的那张已经不在了'), '★ 没告诉他他选的那张没了')
    assert.ok(src.includes('会自动用回它'), '★★ 没告诉他选择留着 —— 他会以为要重新挑')

    /**
     * ★★ B-2（2026-09-14 收敛结论）：这句要**单独一行**，而且**不上警告色**。
     *
     * 单独一行的理由两端同一条（Windows `SplashRes.svelte::splgone` 也是单独一行）：
     * 上面那句回答「现在是哪一张」，这句回答「为什么不是你选的那张」——
     * 挤一行两个都答不清。它原来就是接在「这台手机在用：X」同一段里的。
     * 不上警告色的理由：这不是出错。他在另一台机器上删了一张图，这台照办而已。
     */
    const gone = /\{#if splashShownNowId !== splashNowId\}\s*<div class="([^"]*)">/.exec(src)
    assert.ok(gone, '★★ 那句又被塞回别人的段落里了 —— 它得自己占一个块')
    assert.equal(
      gone![1],
      'm blk zh',
      '★★ 这句的档位被改了：它是和旁边同一档的说明文字（`.m`），不许上警告色'
    )
    const between = /这台手机在用[^]*?你之前选的那张已经不在了/.exec(
      src.replace(/<!--[^]*?-->/g, '')
    )
    assert.ok(
      between?.[0].includes('</div>'),
      '★ 两句又挤回同一段了 —— 中间没有段落边界，「是哪一张」和「为什么不是你选的那张」又混成一句'
    )
  })
})
