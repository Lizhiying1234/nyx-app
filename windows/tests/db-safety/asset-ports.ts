/**
 * 资产端口 · **名字先过判据**（F-08，2026-09-14 双端对账补上）
 *
 * ══ 为什么这一段是新长出来的 ══════════════════════════════════
 *
 * 端口上这五个方法（`audio.read/write` · `splash.read/write/delete`）拿到的 `name`
 * **都不是本机产物** —— 它们来自云端的清单与碑，跑过网络、进过 JSON。
 * 而 `join()` 对 `../` 不会拦一下。
 *
 * 上一版这里写的是「名字已过白名单（引擎在调它之前验）」。那句话当时是真的，
 * 但它把一道安全闸**寄存在「调用方会记得先验」上**。2026-09-14 双端对账就撞到了
 * 它的反例：`splash.delete` 是后来加的，Android 那端加了白名单、Windows 这端没加 ——
 * **同一道闸只守住一端，等于没守。**
 *
 * ══ 为什么端口要提成工厂函数（这一段存在的前提）════════════════
 *
 * 补完守卫之后我问了一句「谁看着它」，答案是**没人** —— 那五个方法原来是
 * `new SyncEngine({...})` 里的内联对象字面量，从外面根本拿不到。
 * 所以把它们提成了 `audioPort()` / `splashPort()` 两个导出工厂：
 * **不是为了好看，是为了让这一段能存在。**
 * （这个仓已经栽过一次「绿的闸不等于这条路有人看着」。）
 *
 * ══ 这一段钉什么 ═══════════════════════════════════════════════
 *   ① 不合规的名字**一个字节都别碰**（不读、不写、不删）
 *   ② 而且**不抛** —— 这一路由同步引擎叫，抛了会把整趟同步带停
 *   ③ 合规的名字**照常能用**（不然就成了"锁死"而不是"守住"）
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { audioPort, splashPort } from '../../src/main/sync/index.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'

console.log('\n资产端口 · 名字先过判据（F-08）\n')

/** 合规的名字：音频是 40 位、启动页是 64 位小写十六进制 */
const OK_MP3 = 'a'.repeat(40) + '.mp3'
const OK_WEBP = 'b'.repeat(64) + '.webp'

/**
 * 不合规的那几种。★ 每一种都对应一条真能想到的攻击 / 事故：
 *   `../` 往上跳 · 反斜杠（Windows 的分隔符）· 绝对路径 · 形状不对
 */
/** ★ 同上：第一个名字精确指向下面那个 `SECRET` 靶子 */
const BAD = [
  '../evil.mp3',
  '../../etc/passwd.mp3',
  'sub/evil.mp3',
  'sub' + String.fromCharCode(92) + 'evil.mp3',
  'C:/windows/evil.mp3',
  'evil.mp3',
  ''
]

/**
 * ★★ 这几个名字**必须精确指向下面那个靶子**（`keep.webp`）。
 *
 * 第一版我写的是 `'../evil.webp'`，而靶子叫 `keep.webp` —— **名字对不上**。
 * 于是越界删除删的是一个本来就不存在的文件，`force: true` 之下无声无息，
 * 靶子当然还在 —— **拆掉守卫这一条照样绿**。负向对照当场抱住了它：
 * `PATCH_EXIT=0 / TEST_EXIT=0`。
 *
 * ★ 教训写在这里：**越界的坐标要落在真有东西的地方**，
 *   否则这条用例只能证明「删不存在的文件不会出事」。
 */
const BAD_SPLASH = [
  '../keep.webp',
  '..' + String.fromCharCode(92) + 'keep.webp',
  '../../x.webp',
  'sub/evil.webp',
  'C:/windows/evil.webp',
  'evil.webp',
  ''
]

checkAsync('★★★ 音频端口：不合规的名字，读不出来也写不进去，而且不抛', async () => {
  const { dir } = freshDir()
  const audioDir = join(dir, 'audio')
  mkdirSync(audioDir, { recursive: true })
  const port = audioPort(audioDir)

  /** 放一个“外面”的文件当靶子 —— 越界读成功的话就会读到它 */
  const outside = join(dir, 'evil.mp3')
  writeFileSync(outside, 'SECRET')

  for (const name of BAD) {
    const got = await port.read(name)
    assert(got === null, `★★ 读出来了：${JSON.stringify(name)} → ${String(got).slice(0, 20)}`)
    await port.write(name, Buffer.from('X').toString('base64'))
  }

  /** 靶子没被改写、目录外面也没多出东西 */
  assert(readFileSync(outside, 'utf8') === 'SECRET', '★★ 目录外面那个文件被写了')

  /** ★ 合规的名字必须照常能用 —— 不然这就成了「锁死」不是「守住」 */
  await port.write(OK_MP3, Buffer.from('HELLO').toString('base64'))
  const back = await port.read(OK_MP3)
  assert(
    back === Buffer.from('HELLO').toString('base64'),
    `合规的名字被误伤了：${String(back)}`
  )
  rmSync(dir, { recursive: true, force: true })
})

checkAsync('★★★ 启动页端口：不合规的名字，读 / 写 / 删一律不碰，而且不抛', async () => {
  const { dir } = freshDir()
  const splashDir = join(dir, 'resources', 'splash')
  mkdirSync(splashDir, { recursive: true })
  const port = splashPort(splashDir)

  const outside = join(dir, 'resources', 'keep.webp')
  writeFileSync(outside, 'KEEP')

  for (const name of BAD_SPLASH) {
    assert((await port.read(name)) === null, `★★ 读出来了：${JSON.stringify(name)}`)
    await port.write(name, Buffer.from('X').toString('base64'))
    await port.delete(name)
  }

  /**
   * ★★ 这一条是整段里最要紧的：`../keep.webp` 这种名字**删除必须没发生**。
   *   删除和读写不一样 —— 读写错了还能重来，删错了他的图就没了。
   */
  assert(existsSync(outside), '★★★ 目录外面那个文件被删了 —— 越界删除')
  assert(readFileSync(outside, 'utf8') === 'KEEP', '★★ 目录外面那个文件被写了')

  /** 合规的名字：写得进、读得出、删得掉 */
  await port.write(OK_WEBP, Buffer.from('PIC').toString('base64'))
  assert((await port.read(OK_WEBP)) === Buffer.from('PIC').toString('base64'), '合规的写/读被误伤')
  await port.delete(OK_WEBP)
  assert(!existsSync(join(splashDir, OK_WEBP)), '合规的删除没生效')
  rmSync(dir, { recursive: true, force: true })
})

check('★★ 两个端口都不抛 —— 这一路由同步引擎叫，抛了会把整趟同步带停', () => {
  /**
   * 上面两条用的是 `await`，抛了会直接把用例带红，所以「不抛」其实已经被钉住了。
   * 这一条单独写出来是**为了让下一个人看见这个约定**：
   * 端口里任何一处改成 `throw`，上面两条当场红，而红的原因不会自己说出
   * 「因为它不许抛」—— 所以这句话得有个地方写着。
   */
  assert(true, '这一条只是把约定写在这儿')
})
