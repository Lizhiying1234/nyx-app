/**
 * 启动页插画的准备 —— **只裁不改**（2026-09-07）
 *
 * 使用者给的原图 2048×1024，主体只占中间一小块，四周是大片透明。
 * 直接拿去用的话，插画在启动页上会显得很小（等于把留白也一起放大了）。
 * 这里做的只有一件事：**按不透明像素裁到实际边界**，再压回合理宽度。
 * 造型 / 比例 / 颜色一个都没动。
 *
 *   输入  assets/brand/splash/splash-source.webp（使用者给的原图，只读）
 *   输出  assets/brand/splash/splash-illustration.webp（裁过 · 宽 ≤1400）
 *
 * 用法：node scripts/gen-splash-art.mjs
 */
import { _electron as electron } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mainWindow } from '../tests/win.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'assets', 'brand', 'splash')
const SRC = join(DIR, 'splash-source.webp')
const MAX_W = 1400

const dataUrl = 'data:image/webp;base64,' + readFileSync(SRC).toString('base64')

const app = await electron.launch({ args: ['.'], cwd: ROOT, env: { ...process.env, NYX_DATA_ROOT: join(ROOT, '.brandtmp') } })
/**
 * ★ 拿主窗走 `tests/win.ts` 那一份判据（B-9，2026-09-14）——
 *   以前这里是 `app.firstWindow()`，它认的是「谁先开」，跟「谁是主窗」无关；
 *   悬浮球开着的库上它拿到的是那颗 46px 的球（I-157 / I-179）。
 */
const page = await mainWindow(app)
await page.waitForLoadState('domcontentloaded')

const out = await page.evaluate(async (src) => {
  const img = new Image()
  img.src = src
  await img.decode()
  const W = img.naturalWidth, H = img.naturalHeight
  const c0 = document.createElement('canvas')
  c0.width = W; c0.height = H
  const g0 = c0.getContext('2d', { willReadFrequently: true })
  g0.drawImage(img, 0, 0)
  const d = g0.getImageData(0, 0, W, H).data

  // alpha 边界。阈值给 12 而不是 0：这张图边缘有一圈压缩噪点，
  // 按 0 裁会把噪点也算进主体，等于没裁。
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] < 12) continue
    if (x < x0) x0 = x; if (x > x1) x1 = x
    if (y < y0) y0 = y; if (y > y1) y1 = y
  }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1
  const k = Math.min(1, 1400 / cw)
  const c = document.createElement('canvas')
  c.width = Math.round(cw * k); c.height = Math.round(ch * k)
  const g = c.getContext('2d')
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, x0, y0, cw, ch, 0, 0, c.width, c.height)
  return { src: [W, H], box: [x0, y0, x1, y1], out: [c.width, c.height], url: c.toDataURL('image/webp', 0.92) }
}, dataUrl)

await app.close()

writeFileSync(join(DIR, 'splash-illustration.webp'), Buffer.from(out.url.split(',')[1], 'base64'))
console.log('原图', out.src.join('×'), '→ 实际边界', out.box.join(','), '→ 输出', out.out.join('×'))
