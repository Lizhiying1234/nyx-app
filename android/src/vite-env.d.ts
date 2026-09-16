/// <reference types="vite/client" />

/**
 * `?raw` 导入的类型声明。
 *
 * ── 为什么需要它 ★ ──────────────────────────────────────────
 *
 * `src/schema-link.ts` 用 `import sql from '…/schema/vNN.sql?raw'`
 * 把 Windows 那份 schema **原文内联**进产物（D-289：不在这个仓库放第二份）。
 * Vite 认得 `?raw`，**TypeScript 不认** —— 于是
 * `npm run check` 一直报「Cannot find module …v34.sql?raw」。
 *
 * ★★ 那道门因此**长期是红的**，而红久了就等于没有门 ——
 * 后来真正的类型错误（`preserve.ts` 那个）混在里面好几轮都没人处理。
 * 2026-08-26 做 v35 时才发现：**它不是我改坏的，是本来就坏着。**
 *
 * ★ 教训与「测量之前先测能不能测」同一族：
 *   **一道一直红的门，和没有门是一样的。**
 */
declare module '*?raw' {
  const content: string
  export default content
}

/** 构建指纹（vite define · Settings › About）：短 hash + 构建时刻 */
declare const __NYX_BUILD__: string
/** 这份 build 用的是哪一个 core（vite define · Settings › About）：submodule 锁定的 SHA · schema 版本 · 同步表面指纹（T-1.3） */
declare const __NYX_CORE__: string