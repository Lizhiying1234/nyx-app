import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const r = (p: string) => resolve(__dirname, p)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': r('src/shared'), '@core': r('src/core') } },
    build: {
      rollupOptions: {
        input: {
          index: r('src/main/index.ts'),
          // 数据安全的验收要跑在 Electron 主进程里 —— better-sqlite3 是按
          // Electron 的 ABI 编译的，系统 node 加载不了。见 tests/db-safety.ts。
          'db-safety': r('tests/db-safety.ts'),
          // 编一套假数据用来验报告。写进临时目录，用完整个删掉。
          'seed-demo': r('tests/seed-demo.ts'),
          // D2 的行为等价对拍。同样要 Electron —— Dicts 要 better-sqlite3。
          'dict-behavior': r('tests/dict-behavior.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': r('src/shared') } },
    build: { rollupOptions: { input: { index: r('src/preload/index.ts') } } }
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [svelte()],
    // 界面层可以用 core 里的**纯逻辑**（D-238）——
    // 它不碰数据库、不碰 AI，两端共用的判据放在那里才不会各写一份。
    resolve: { alias: { '@shared': r('src/shared'), '@core': r('src/core') } },
    build: { rollupOptions: { input: { index: r('src/renderer/index.html') } } }
  }
})
