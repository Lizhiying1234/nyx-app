#!/usr/bin/env node
// 构建后剪掉 .woff 备胎 —— 只在 `npm run build` 末尾跑。
//
// 为什么存在：@fontsource 的 CJK 包在 @font-face 里同时给了 woff2 与 woff
// 两个 src。Android WebView 永远支持 woff2，woff 那一份**一次都不会被取**，
// 却要在 APK 里白占一大块。
// ★ 2026-08-31 实测（DS v5 · noto-serif-sc 400+600）：删掉 225 个 .woff = 省 8.2 MB（16.0 → 7.0）。
//   2026-09-08 换成字体 D′（noto-sans-sc 400+600）之后的数见交付单。
// ★ 教训记档：同日我差点在 vite.config.ts 里另写一个 generateBundle 插件做同一件事
//   —— 因为只跑了 `npx vite build`（跳过本脚本）就以为没人管。**跑完整的
//   `npm run build` 再下结论。** 同一件事有两份判据是这个仓库最贵的事故形态。
//
// ★ CSS 里指向 woff 的 url() 留着不管 —— 按 CSS 字体匹配规则，
//   浏览器取第一个支持的 format（woff2）就停，悬空的备胎不会被请求。
// ★ 只删 www/assets（构建产物），不碰 node_modules。
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'www', 'assets')
let n = 0
let bytes = 0
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.woff')) continue
  const p = join(dir, f)
  bytes += statSync(p).size
  rmSync(p)
  n++
}
console.log(`prune-woff: 删除 ${n} 个 .woff 备胎，省 ${(bytes / 1048576).toFixed(1)} MB`)
