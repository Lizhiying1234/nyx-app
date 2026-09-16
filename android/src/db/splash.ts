/**
 * 启动页用哪一张 —— **设备本地**（`settings` 表，不进 `SYNC_TABLES`）
 *
 * ══ 为什么是设备本地 ════════════════════════════════════════
 * 使用者 2026-09-09：「win 和 android 可以有不同的启动页，**共享的是图片资源**」。
 * 所以分成两半，正好落在库里现成的分界上：
 *   图片本体   → 跟着同步走（两端看得见同一批候选）—— 那条流归 `nyx/splash/`
 *   选了哪张   → **各端自己的事**，不同步 —— 就是这个文件
 * 判据（字面只有三种形状 · 认不出来当没设过）在 core 的 `splash-name.ts`，
 * 这里一行判据都不写，只负责「往哪张表读写」。
 *
 * ══ 为什么还要往 localStorage 抄一份 ★★ ══════════════════════
 * 启动页那一帧要在**库打开之前**就决定画不画、画哪张 ——
 * 而这个值住在库里。手机上 WebView 先起、库后开，读不到就等于每次都先闪一下默认。
 * 所以写的时候同时往 `localStorage` 抄一份**镜像**：
 *   · `settings` 是记录（契约要求的位置，两端一致）
 *   · `localStorage` 是快取（同样是设备本地，语义一致，不是第二份判据）
 * 镜像没有 / 读不出来 → 按「没设过」走默认，**绝不抛**（启动页上抛一次就是白屏）。
 */
import {
  cleanLabel,
  decodeLabels,
  checkSplashName,
  decodeSplashChoice,
  encodeLabels,
  encodeSplashChoice,
  type SplashChoice,
  type SplashLabel
} from '../core-link.ts'
import type { Db } from './types.ts'

const KEY = 'splash.choice'
/** localStorage 那份镜像的键 —— 与库里同名，省得两处对不上时看不出来 */
const MIRROR = 'nyx.splash.choice'

/** 库里的那一份（记录）。认不出来 → null，调用方按「没设过」走默认。 */
export async function getSplashChoice(db: Db): Promise<SplashChoice | null> {
  try {
    const r = await db.get(`select value from settings where key = ?`, [KEY])
    return decodeSplashChoice(r?.value)
  } catch {
    return null
  }
}

export async function setSplashChoice(db: Db, c: SplashChoice): Promise<void> {
  const raw = encodeSplashChoice(c)
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [KEY, raw, Date.now()]
  )
  writeMirror(raw)
}

/**
 * 「我的图」那一档还要镜像一个**地址**（2026-09-13）。
 *
 * 启动那一帧要在**开库之前**就画出来，而 `user:<name>` 只是个文件名 ——
 * 把它换成 WebView 能加载的地址要 `Filesystem.getUri`，那是**异步**的，
 * 启动那一刻等不起。所以他选中的时候就把地址算好抄进镜像。
 *
 * ★ 这个文件**不 import 任何 Capacitor 插件**（同 `sha256.ts` 的纪律）——
 *   地址由调用方（Settings）用 `db/splash-files.ts::splashFileUrl` 算好传进来。
 *   无头 WebView 那条路上没有桥，import 到插件会炸。
 * ★ 传 null = 清掉（换回内置那两档时必须清，否则启动会去加载一张不该用的图）。
 */
const URL_MIRROR = 'nyx.splash.url'

export function writeSplashUrlMirror(url: string | null): void {
  try {
    if (url === null) localStorage.removeItem(URL_MIRROR)
    else localStorage.setItem(URL_MIRROR, url)
  } catch {
    /* 存不进去只是下次启动少一次快取 */
  }
}

function writeMirror(raw: string): void {
  try {
    localStorage.setItem(MIRROR, raw)
  } catch {
    /* 存不进去只是下次启动少一次快取，不该让「改设置」这件事失败 */
  }
}

/**
 * 库开好之后校一次镜像 —— 覆盖「在别处改了库、镜像还是旧的」这一种。
 * ★ 只在两边不一样时才写，避免每次开库都碰一次 localStorage。
 *
 * ★★ 2026-09-09 真机量出来的一件事，别当成 bug 修（`store.svelte.ts` 开库时调它）：
 *   `localStorage.setItem` 对 JS 是同步的，但 Chromium 落盘是**异步**的。
 *   「选完这一张 → 一秒内把进程强制停止 → 再冷启」这条路上，
 *   那次写可能还没落盘 —— 于是那一次启动画的还是**上一张**。
 *   下一次就对了，因为库里那一行才是记录，开库时这个函数把镜像补回去。
 *   ☞ 正常用不会碰到（按 home / 切后台都会让它落盘），我是拿 `am force-stop`
 *     连着测才撞出来的。屏上那句「下次打开就能看见」因此仍然成立。
 *   ☞ JS 这一侧没有「强制落盘」这种东西，所以不去修它；
 *     真要治只能把值也写进原生 SharedPreferences，为这条边角加一层不划算。
 */
export async function syncSplashMirror(db: Db): Promise<void> {
  const inDb = await getSplashChoice(db)
  const raw = inDb === null ? null : encodeSplashChoice(inDb)
  try {
    if (raw !== null && localStorage.getItem(MIRROR) !== raw) writeMirror(raw)
  } catch {
    /* 同上 */
  }
}

/* ══════════════════════════════════════════════════════════════
   这一张叫什么 —— 使用者 2026-09-09：「插画的名字可以改名
   （除了系统默认不能改，其他都可以改）」

   ★ 为什么也在 `settings`：改的是**这台机器上怎么称呼它**，和「用哪一张」同一档
     （设备本地、不同步）。名字不跟着图走 —— 同一张图两端可以叫不同的名字。
   ★ 为什么存成一张 JSON 表而不是一行一个键：候选是会长的（以后传自己的图），
     一张表读一次就够，省得每加一张图就多一次 `select`。
   ★ 判据（能不能叫这个名字）现在住在**这一端**：core 里还没有它。
     不是抄来的，是新的；等两端都要用了再收编进 core（已记进交付）。
   ══════════════════════════════════════════════════════════════ */

const NAMES_KEY = 'splash.names'

/**
 * 这台机器给候选起的名字表。
 *
 * ══ 判据一条都不在这儿 ★★ ══════════════════════════════════
 * 名字要两端同步、以最后一次修改为准（使用者 2026-09-13），所以
 * **怎么洗名字（`cleanLabel`）· 最长多少（`MAX_LABEL`）· 没起名时显示什么
 * （`defaultLabel`）· 谁赢（`pickLabel`）全在 core**。
 * 本仓此前有自己的一份（`cleanSplashName` / `SPLASH_NAME_MAX` / 自己算的默认名），
 * 2026-09-13 全删 —— 两份判据迟早不一样，而不一样的后果是：
 * 长名字在一端被截短、再同步回去**字就少了**；默认名不一致**看起来像同步坏了**。
 *
 * ══ 键的形状 ══════════════════════════════════════════════
 * 这张表的键是 `encodeSplashChoice(c)`：`icon` · `shipped` · `user:<sha256>.<ext>`。
 * 它**同时装两种东西**：内置两档的名字是**设备本地的叫法、不进桶**；
 * 只有 `user:` 那些才跟着同步走。前缀的剥 / 加在 `db/sync-ports.ts` 那一层做。
 */

/** 一条名字（core 的形状：`{ label, at }`）—— 转出去只是省得每处都从 core-link 引 */
export type SplashName = SplashLabel

/**
 * 读整张表。
 * ★ **旧形状迁移**：以前存的是 `id → 字符串`（没有时间）。碰到它时，
 *   拿 `settings` 那一行自己的 `updated_at` 当它的 `at` ——
 *   给 0 等于他以前起的名字一律输，给 `now` 等于一律赢，
 *   那一行的 `updated_at` 是手上最好的证据（这张表最后被写的真实时刻）。
 * ★ 洗数据本身交给 core 的 `decodeLabels`（它管上限、坏值、条数）。
 */
export async function getSplashNames(db: Db): Promise<Record<string, SplashName>> {
  try {
    const r = await db.get(`select value, updated_at from settings where key = ?`, [NAMES_KEY])
    const raw = r?.value
    if (typeof raw !== 'string' || raw === '') return {}
    const rowAt = Number(r?.updated_at ?? 0) || 0
    // 先把旧形状抬成新形状，再交给 core 洗 —— 洗的判据只有那一份
    let normalized: unknown
    try {
      normalized = JSON.parse(raw)
    } catch {
      return {}
    }
    if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) return {}
    const lifted: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(normalized as Record<string, unknown>)) {
      lifted[key] = typeof v === 'string' ? { label: v, at: rowAt } : v
    }
    const out = decodeLabels(JSON.stringify(lifted))
    // `at` 是 0（旧数据里连 updated_at 都没有）时也用那一行的时刻兜一下
    for (const key of Object.keys(out)) {
      if (out[key]!.at === 0 && rowAt > 0) out[key] = { label: out[key]!.label, at: rowAt }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 改一条名字。洗完是空的 → **把这一条删掉**（回到默认名），不是存一个空字符串。
 * ★ 只动这一条：**不刷新别人的 `at`** —— 那会让他没改过的名字凭空变新，
 *   同步时把对面真正更新的名字压掉。
 * 返回写完之后的整张表，省得调用方再读一次。
 */
export async function setSplashName(
  db: Db,
  id: string,
  name: string
): Promise<Record<string, SplashName>> {
  const names = await getSplashNames(db)
  const clean = cleanLabel(name)
  if (clean === '') delete names[id]
  else names[id] = { label: clean, at: Date.now() }
  await writeSplashNames(db, names)
  return names
}

/**
 * 本机那张名字表里，用户图的键多出来的那一截（`encodeSplashChoice` 的形状）。
 * 内置两档（`icon` / `shipped`）没有前缀。
 */
export const USER_PREFIX = 'user:'

/**
 * 本机键 → **桶里的键**（同步引擎认的那种：`<sha256>.<ext>`）。
 *
 * ★ 不剥这个前缀的后果：带前缀的键过不了引擎那道 `checkSplashName`，
 *   **一张名字都传不上去，而且不报错** —— 这类「差一个前缀」的问题
 *   不会红、不会抛，只会安静地什么都不做。
 * ★ 内置两档原样带过去：引擎的 `next` 会保留它们，而推那一步
 *   `checkSplashName('shipped')` 不过，于是它们**自己被跳过**，进不了桶。
 *   保住它们的是一道**指得着的闸**，不是一条要记住的规矩。
 */
export function toBucketKeys(
  mine: Readonly<Record<string, SplashName>>
): Record<string, SplashName> {
  const out: Record<string, SplashName> = {}
  for (const [k, v] of Object.entries(mine)) {
    out[k.startsWith(USER_PREFIX) ? k.slice(USER_PREFIX.length) : k] = v
  }
  return out
}

/** 桶里的键 → 本机键。是合规资源名的就是用户图，加回前缀；其余原样。 */
export function fromBucketKeys(
  map: Readonly<Record<string, SplashName>>
): Record<string, SplashName> {
  const out: Record<string, SplashName> = {}
  for (const [k, v] of Object.entries(map)) {
    out[checkSplashName(k).ok ? USER_PREFIX + k : k] = v
  }
  return out
}

/**
 * 整表写入 —— 同步引擎那条路用（`EnginePorts.splashLabels.write`）。
 * ★ 引擎给的是**全量**（合并之后的权威结果），所以这里就是覆盖。
 * ★ 序列化交给 core 的 `encodeLabels`：两端存进各自库里的形状一致，
 *   将来谁去读对面的备份都不用再猜。
 */
export async function writeSplashNames(
  db: Db,
  map: Record<string, SplashName>
): Promise<void> {
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [NAMES_KEY, encodeLabels(map), Date.now()]
  )
}

