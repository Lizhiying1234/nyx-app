import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

/**
 * `npm run demo` —— 灌一套半年的假数据，然后用它打开软件。
 *
 * **它不碰你的真实数据。** 全部写进 `.demo/`，看完直接删掉那个文件夹就干净了：
 *
 *     rmdir /s /q .demo        （或者在资源管理器里删）
 *
 * 用途：报告这类「攒够数据才有东西看」的东西，没数据就没法验，
 * 也没法让你看出它做得对不对。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const demo = join(root, '.demo')
const env = { ...process.env, NYX_DATA_ROOT: demo }

if (process.argv.includes('--fresh') && existsSync(demo)) {
  rmSync(demo, { recursive: true, force: true })
  console.log('清掉了旧的 .demo')
}

const fresh = !existsSync(join(demo, 'data', 'nyx.db'))
if (fresh) {
  console.log('正在编数据…')
  const r = spawnSync(electron, [join(root, 'out', 'main', 'seed-demo.js')], {
    cwd: root,
    env,
    stdio: 'inherit'
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

console.log(`\n数据在：${demo}\n看完删掉这个文件夹就干净了。\n`)
spawnSync(electron, ['.'], { cwd: root, env, stdio: 'inherit' })
