import { defineConfig } from 'vite'

/**
 * Assist 引擎的单独产物（D-404①）。
 *
 * 为什么不跟主应用一起打：它不进 WebView 的页面，而是被**无障碍服务**
 * 读成一段字符串塞进自己的无头 WebView。所以要的是
 *   · 一个自包含的 IIFE（没有 import，file/data 源下不受模块 CORS 影响）
 *   · 落在 android assets 里（服务用 AssetManager 读，不经 cap copy）
 *
 * ★ 判据仍然只有一份：这里打包的是 src/db/* 与 core 的**同一批文件**，
 *   只是端口换成原生（见 src/engine/main.ts 的文件头）。
 */
export default defineConfig({
  build: {
    outDir: 'android/app/src/main/assets',
    emptyOutDir: false,
    target: 'es2020',
    lib: {
      entry: 'src/engine/main.ts',
      formats: ['iife'],
      name: 'NyxAssistEngineBundle',
      fileName: () => 'assist-engine.js'
    },
    // 引擎没有静态资源，也不需要 sourcemap 进 APK
    sourcemap: false,
    reportCompressedSize: false
  }
})
