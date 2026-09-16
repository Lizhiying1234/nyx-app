/**
 * 启动页 · 删掉「正在用的那张」之后会怎样（2026-09-14）
 *
 * ══ 为什么临时长出这一段 ═══════════════════════════════════════
 *
 * 使用者裁了「资源删除改成真删除」（选 a）之后，Android 那边的会话顺手查了
 * 一个我们俩都没想清楚的问题：**删掉的正好是在用的那张，屏上会剩下什么。**
 * 它那边发现「在用」是两个记号说的，悬空时两处打架。我来对自己这一侧 ——
 * 对出了同一个形状，而且这边还多一个更硬的：
 *
 *   在 Windows 上删 → 旧代码把 `splash.active` 清成出厂 → 图加回来选择**不复原**
 *   从手机上删、碑同步过来 → 那一路根本不碰库 → 图加回来选择**复原**
 *
 * **同一个动作，在两端按会得到两种结果。** 那才是真正的毛病。
 *
 * 现在两条路都不碰库：库里那一条记的是「**他本来要哪一张**」，
 * 屏上画哪一张由 `core/splash-name.ts::shownChoice` 回答（不写库，有用例）。
 *
 * ★ 这一段验的是**数据层**：删了之后库里那条还在不在、碑立没立、
 *   那一帧退没退回出厂、图回来之后他的选择是不是自己就回来了。
 *   屏上那枚徽章由 core 那套用例钉（判据摆在最便宜的那一层）。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import {
  activeChoice,
  deleteUserSplash,
  labels,
  setActiveChoice,
  splashArt
} from '../../src/main/splash.ts'
import { isGone } from '../../src/core/splash-names.ts'
import type { NyxPaths } from '../../src/main/paths.ts'
import { check, assert, freshDir } from './harness.ts'

console.log('\n启动页 · 删掉在用的那张\n')

/** 仓里那份真的出厂插画 —— 退回那一档要真读得出来，不然这一段验的是空气 */
const RES = join(process.cwd(), 'resources')

/** 名字必须是「64 位小写十六进制 + 扩展名」，不是随便一个文件名 */
const NAME = 'c'.repeat(64) + '.webp'

/**
 * `deleteUserSplash` / `splashArt` 只用到 `data` 与 `resources` 两栏。
 * ★ 不去拼一整份 `NyxPaths`：多出来的那十几栏一个都不参与判断，
 *   拼出来只会让下一个人以为它们有意义。
 */
function fakePaths(dir: string): NyxPaths {
  return { data: dir, resources: RES } as NyxPaths
}

/**
 * 造一张「他传过的图」。
 *
 * ★★ **至少 64 字节**：`readSplash` 把更短的一律当读不出来（`bytes.length < 64`）。
 *   第一版这里只写了 20 字节，于是 `splashArt` 从头到尾给的都是**出厂插画** ——
 *   而出厂插画本身也是 `.webp`，所以那条「拿到的是 data:image/webp」**照样绿**。
 *   假绿就长这样：断言是真的，只是它断的不是我以为的那个东西。
 */
function putSplashFile(dir: string): string {
  const d = join(dir, 'resources', 'splash')
  mkdirSync(d, { recursive: true })
  const f = join(d, NAME)
  writeFileSync(f, Buffer.from('RIFF' + 'nyx-fake-splash-bytes-'.repeat(8), 'ascii'))
  return f
}

check('★★★ 删掉在用的那张：文件没了、碑立了，但「他选的是哪张」还记着', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const paths = fakePaths(dir)
  const f = putSplashFile(dir)

  setActiveChoice(r.db, { kind: 'user', name: NAME })
  /**
   * ★★ 判据是「和**出厂那张**不一样」，不是「是一张 webp」——
   *   出厂插画自己就是 webp，拿扩展名当判据的话，退回出厂之后它照样绿。
   */
  const his = splashArt(paths, r.db)
  assert(his !== null && his !== splashArt(paths, null), '先得真拿到他那张，不是退回来的出厂插画')

  deleteUserSplash(paths, r.db, NAME, 1_700_000_000_000)

  assert(!existsSync(f), '文件该没了')
  assert(isGone(labels(r.db)[NAME]), '碑该立了 —— 不立的话下一趟同步会把它从桶里拉回来')

  const cur = activeChoice(r.db)
  assert(
    cur.kind === 'user' && cur.name === NAME,
    `★★ 库里那条被清了（现在是 ${JSON.stringify(cur)}）—— ` +
      '它记的是「他本来要哪一张」。清掉的话，同一张图加回来时他得重新挑一次；' +
      '而同步过来的那条删除路径根本不碰库，只在这儿清就是两端行为分叉'
  )
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★★ 那一帧退回出厂插画 —— 屏上不会空，也不会画他已经删掉的那张', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const paths = fakePaths(dir)
  putSplashFile(dir)

  setActiveChoice(r.db, { kind: 'user', name: NAME })
  const his = splashArt(paths, r.db)
  deleteUserSplash(paths, r.db, NAME, 1_700_000_000_000)
  const after = splashArt(paths, r.db)

  assert(after !== null, '★ 退回来的那一帧不许是 null —— 那是「选了图标」才给的答案')
  assert(after !== his, '★ 还在给他那张已经删掉的图')
  assert(after === splashArt(paths, null), '★ 退的必须正好是出厂那张（无库时给的就是它）')
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★★ 同一张图再加回来 → 他的选择自己就回来了，不用重新挑一次', () => {
  /**
   * 这正是「不清库」换来的东西，也是 Android 那边坚持不清的理由。
   * 跨端那一趟里它长这样：手机删 → 碑同步过来 → 他又把同一张加回来
   * （`gone:false` 压过旧碑）→ 电脑上启动页**自己就变回**他原来选的那张。
   */
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const paths = fakePaths(dir)
  putSplashFile(dir)

  setActiveChoice(r.db, { kind: 'user', name: NAME })
  const his = splashArt(paths, r.db)
  deleteUserSplash(paths, r.db, NAME, 1_700_000_000_000)
  assert(splashArt(paths, r.db) !== his, '删完先得真的不是他那张')

  putSplashFile(dir) /* 图回来了 */
  assert(
    splashArt(paths, r.db) === his,
    '★★ 图回来了，启动页却没跟着回来 —— 那就说明「他选的是哪一张」在删除时被抹掉了'
  )
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})
