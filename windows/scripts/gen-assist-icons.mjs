/**
 * Assist 小图标 —— **两张**（使用者 2026-09-14 第四条）
 *
 * 他这一轮把 09-13 那个方案**整个推翻了**，原话：
 * > 现在我不需要之前提出的四种状态、四个不同图标的方案。
 * > Windows 桌面的 Assist 小图标，希望**完全移植 Android Assist 使用的桌面小图标**：
 * > Windows 和 Android 使用同一个 Assist 小图标……不需要四个状态图标。
 * > 只需要两种状态：开启 / 关闭。
 *
 * ★ 旧方案（眼睛 / 取景框 × 开 / 关 = 四张）**真删了**，不是注释掉
 *   （D-457：撤销过的东西再加回来之前，先找出当初为什么撤）。
 *   当初撤的理由就写在这儿：模式（Glance / Frame）现在**只在设置里选**，
 *   桌面那枚只管开 / 关 —— 图标再分方式，就是在说一件它不再负责的事。
 *
 * ══ 「同一个图标」具体是哪一枚 ═══════════════════════════════
 * Android 的 Assist 磁贴用的是 `android/app/src/main/res/drawable/ic_assist_tile.xml`，
 * 它头上第一行就写着：
 *   「Nyx 衍射星 · DS v5 §4.2 —— 与 Sprite.svelte 的 #nyx-star 同一份几何。」
 * 而 `#nyx-star` 就在本仓 `core/icons.ts` 里（D-410：图标几何只有一份）。
 * 所以这里**不重画**，直接拿那两条 path：核（fill）· 四芒（stroke）。
 * ★ 核与四芒**不相连** —— 那个间隙是这个符号的全部识别点（§4.2 规则②），不许填上。
 *
 * ══ 两种状态怎么画（这一步是我替他做的翻译，写在这里）════════
 * Android 那枚是**单色 drawable**：开 / 关由磁贴自己的底色说，图本身不变。
 * Windows 的通知区**没有那块底** —— 只有一枚 16 像素的图。
 * 所以开 / 关必须落在图里，而「怎么落」不用我发明：
 * DS §4.3 对这枚星本来就定了两档（`icons.ts` 那段注释原话）：
 *   **ON = 核实心 + 四芒亮起。OFF = 只有核、空心。**
 * 两张图用的就是这两档，加上颜色（主色 / 灰）再说一遍。
 * ★ 所以这**不是两个图标**，是同一枚图标的两档 —— 和他说的
 *   「同一个 Assist 小图标」一致，也和应用内、手机上同一套语法。
 *
 * ══ 颜色取的是令牌的值，不是我挑的 ═══════════════════════════
 *   开 = `--color-primary`（aqua-500 #38A8B4）· 关 = `--color-text-3` 那一档的灰（#5A757B）
 *   两个都从 `core/design/color-tokens.css` 抄来，改令牌时这里要跟着改
 *   （和 `main/index.ts` 那个窗口首帧底色同一条纪律）。
 *
 * 用法：node scripts/gen-assist-icons.mjs
 *      （不在构建链里。产物提交进仓库 —— 托盘图标要在装机后立刻可用，
 *        不能依赖使用者机器上有没有跑过生成脚本。）
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mainWindow } from '../tests/win.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * ★ 落在 `resources/assist/` 而不是 `assets/`：`resources/` 是按 extraResources
 *   发出去的那一片（和启动页插画、两个助手脚本同一处）——
 *   托盘图标要在装机后立刻可用，不能依赖他机器上跑过生成脚本。
 */
const OUT = join(ROOT, 'resources', 'assist')
mkdirSync(OUT, { recursive: true })

/** 抄自 core/design/color-tokens.css —— 改令牌要同改这里 */
const ON = '#38A8B4'
const OFF = '#5A757B'

/**
 * 衍射星。**几何逐字抄自 `core/icons.ts` 的 `#nyx-core` / `#nyx-star`**
 * （Android `ic_assist_tile.xml` 画的也是这两条）。viewBox 同样是 24，不重算坐标。
 */
const CORE = 'M12 6.4 Q13.2 10.8 17.6 12 Q13.2 13.2 12 17.6 Q10.8 13.2 6.4 12 Q10.8 10.8 12 6.4 Z'
const RAYS = 'M12 2 V4.8 M12 19.2 V22 M2 12 H4.8 M19.2 12 H22'

/**
 * ON  —— 核实心 + 四芒亮起（DS §4.3）
 * OFF —— 只有核、空心；**四芒不画**，这才是两档之间真正的差别
 */
function svg(live) {
  const c = live ? ON : OFF
  const core = live
    ? `<path d="${CORE}" fill="${c}"/>`
    : `<path d="${CORE}" fill="none" stroke="${c}" stroke-width="1.7"/>`
  const rays = live
    ? `<path d="${RAYS}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
    ${core}${rays}
  </svg>`
}

/** ★ 光栅化走的是和 gen-brand-icons 同一条路：起一个 Nyx、拿它那个页当画布 */
const app = await electron.launch({
  args: ['.'],
  cwd: ROOT,
  env: { ...process.env, NYX_DATA_ROOT: join(ROOT, '.assisttmp') }
})
/**
 * ★ 拿主窗走 `tests/win.ts` 那一份判据（B-9，2026-09-14）——
 *   以前这里是 `app.firstWindow()`，它认的是「谁先开」，跟「谁是主窗」无关；
 *   悬浮球开着的库上它拿到的是那颗 46px 的球（I-157 / I-179）。
 */
const page = await mainWindow(app)
await page.waitForLoadState('domcontentloaded')

const names = []
for (const live of [true, false]) {
  const name = `assist-${live ? 'on' : 'off'}.png`
  await page.setContent(`<body style="margin:0;background:transparent">${svg(live)}</body>`)
  const buf = await page.locator('svg').screenshot({ omitBackground: true })
  writeFileSync(join(OUT, name), buf)
  names.push(name)
}
await app.close()
console.log('✓ 生成 ' + names.length + ' 张：' + names.join(' · '))
console.log('  ' + OUT)
