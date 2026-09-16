import type { Database } from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import {
  decodeSplashChoice,
  encodeSplashChoice,
  type SplashChoice
} from '../core/splash-name.ts'
import {
  cleanLabel,
  decodeLabels,
  encodeLabels,
  revive,
  tombstone,
  type SplashLabel
} from '../core/splash-names.ts'
import { removeSplash } from './resources.ts'
import type { NyxPaths } from './paths.ts'
import { readSplash } from './resources.ts'

/**
 * 启动页那一块画面 · B8（U-007 定稿 · DESIGN_SYSTEM §12）
 * ＋ 2026-09-09 使用者「Settings → 资源 → 启动页」：**从一张定死的图变成一个可选的资源**
 *
 * ══ 一条回退规则，判定写在这里 ══════════════════════════════
 * 使用者原话：「**没有图片的时候就用图标，有图片的时候就用图片**」。
 * 所以这一处只回答一个问题：**那张图能不能读出来**。
 *   能  → 返回它的字节（`data:` URI），界面画有图版
 *   不能 → 返回 `null`，界面画没图版（去底的兔子 168px）
 * 「文件不在」「读不动」「格式不认」三种情况在界面上是同一种：**回退**。
 * ★ **绝不许因此白屏或崩** —— 所以这里一句都不抛。
 *
 * ══ 现在多了一层：读哪一张 ═════════════════════════════════
 *
 * 老注释里写着「『读哪张图』是一个**可换的值**，不写死…那个页面将来只是把
 * 下面这个名字从常量改成他选的那一张」——就是今天这件事。
 *
 *   `settings['splash.active']`  →  icon | shipped | user:<name>
 *
 * ★★ **为什么存 `settings` 而不是 `user_preferences`**：
 *   使用者 2026-09-09 改的需求 ——「win 和 android 可以有不同的启动页，
 *   **共享的是图片资源**」。也就是：
 *     图片本体 → 两端共用（跟着同步走）
 *     选了哪张 → **各端自己的事**
 *   `user_preferences` 进 `SYNC_TABLES`，`settings` 不进（`core/sync-tables.ts`）——
 *   现成的分界正好就是他要的分界，一个字都不用改同步契约。
 *
 * ★ **回退是一条链，不是一个判断**：他选的那张读不出来（文件被他删了 / 换机器还没同步到）
 *   → 退到出厂插画 → 再读不出来 → 退到图标。任何一环都不报错、不白屏。
 *
 * ══ 出厂那张仍然在程序目录（这是对的）═══════════════════════
 * 图放在 `<软件>/resources/splash/`，**在 asar 之外**（`electron-builder.yml` 的
 * `extraResources`）—— **它是程序的一部分**，跟着软件走。
 * 他自己传的那些在 `data/resources/splash/`（I-106：程序目录里只有程序）。
 */

/** 出厂那张 —— 随软件发的默认插画 */
export const SPLASH_FILE = 'illustration.webp'

/** 没设过的时候用哪一张。★ 保持 B8 以来的现状：出厂插画（读不出来自然退到图标） */
export const DEFAULT_CHOICE: SplashChoice = { kind: 'shipped' }

const SETTINGS_KEY = 'splash.active'
/**
 * ══ 图片的名字（使用者 2026-09-13）══════════════════════════════
 * 他要的是「同一张图在两端叫同一个名字，任意一端改了同步到另一端，
 * 冲突时最后一次修改为准」。
 *
 * ★★ 名字**不是**「本机选了哪张」那一类，它是**资源本身的属性** ——
 *   所以它和 `splash.active` 的性质**正好相反**：active 各端自管（D-480），
 *   名字两端一致。这里先把本机这一份存下来，同步那一半在 core。
 * ★ 存 `settings` 而不是新开一张表：名字是一个 JSON 小字典，
 *   加一张表要动 schema、迁移、同步契约四处，而它一样也不需要。
 */
const LABELS_KEY = 'splash.labels'

const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

/**
 * 读出厂那张。读不出来 → `null`。
 * ★ 导出是因为设置页要**独立于「当前用哪张」**把它画出来：
 *   `app.splashArt()` 给的是「当前该画哪一张」，当前是自传图时它给的就是那一张，
 *   拿它当出厂图用，会让「Nyx 插画」那张卡**时有时无**（第一版就是这个毛病）。
 */
export function shippedArt(resourcesDir: string): string | null {
  try {
    const file = join(resourcesDir, 'splash', SPLASH_FILE)
    const mime = MIME[extname(file).toLowerCase()]
    if (!mime) return null
    const bytes = readFileSync(file)
    // 空文件 / 截断的文件也算「读不出来」—— 交给界面回退，别让它去解码一段垃圾
    if (bytes.length < 64) return null
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/** 当前这台机器选了哪一张。读不出来 / 认不出来 → 默认那一张。**不抛。** */
export function activeChoice(db: Database): SplashChoice {
  try {
    const r = db.prepare(`select value from settings where key = ?`).get(SETTINGS_KEY) as
      | { value: string }
      | undefined
    return decodeSplashChoice(r?.value) ?? DEFAULT_CHOICE
  } catch {
    return DEFAULT_CHOICE
  }
}

/** 这台机器上记着的那些名字。读不出来给空表，**不抛**。 */
export function labels(db: Database | null): Record<string, SplashLabel> {
  if (!db) return {}
  try {
    const r = db.prepare(`select value from settings where key = ?`).get(LABELS_KEY) as
      | { value: string }
      | undefined
    return decodeLabels(r?.value)
  } catch {
    return {}
  }
}

/**
 * 给一张图起 / 改名字。★ **要抛** —— 他刚改完名字，存不进去必须当面说。
 * @param at 改成这个名字的时刻。**同步那边靠它定谁赢**，所以由调用方给，
 *   不在这里取 `Date.now()` —— 测试要能注入一个确定的时间。
 */
export function setLabel(db: Database, name: string, label: string, at: number): void {
  const next = { ...labels(db) }
  const clean = cleanLabel(label)
  const was = next[name]
  if (clean) next[name] = was?.gone === undefined ? { label: clean, at } : { label: clean, at, gone: was.gone }
  /**
   * 改成空的 = 把名字去掉，回到默认那句话（不是存一个空名字）。
   * ★★ 但**墓碑不能跟着去掉**（2026-09-14）：那一条是删除的凭证，
   *   不是名字。删掉它，那张图下一趟同步就从桶里回来了。
   */
  else if (was?.gone === true) next[name] = { label: '', at: was.at, gone: true }
  else delete next[name]
  putLabels(db, next)
}

/** 名字表整份落库。**要抛** —— 这一层的每一次写都跟着他的一次动作 */
function putLabels(db: Database, next: Record<string, SplashLabel>): void {
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(LABELS_KEY, encodeLabels(next), Date.now())
}

/**
 * ══ 立一块墓碑（使用者 2026-09-14 裁「选 a：连桶一起删」）★★★ ═══════
 *
 * 他按「从资源库删除」时走这里。**本机文件由 `removeSplash` 删，这里只管立碑** ——
 * 碑是给**同步**看的：下一趟同步会拿它去桶里把那个对象也删掉，
 * 并且让另一端跟着删。
 *
 * ── 为什么删文件之外还要立碑 ─────────────────────────────
 * 2026-09-13 真出过一次：只删本机，下一趟同步就从桶里拉回来了。
 * 那张 502 字节的测试图要在手机 / 桶 / 电脑三处各删一次才干净，
 * 而中间不能让任何一端同步 —— 那个窗口关不住（开机 4 秒一趟、之后每 30 分钟一趟）。
 *
 * ★ **名字留着**：他哪天把同一张图加回来，名字还在（资源名是内容 sha256，
 *   所以「同一张图」认得出来）。
 * ★ `at` 由调用方给 —— 同步那边靠它定谁赢，测试要能注入确定的时间。
 */
export function markSplashGone(db: Database, name: string, at: number): void {
  const next = { ...labels(db) }
  next[name] = tombstone(next[name] ?? null, at)
  putLabels(db, next)
}

/**
 * ══ 把它加回来 —— 翻掉自己那块碑 ═══════════════════════════════
 *
 * 他重新导入同一张图时走这里。资源名是内容 sha256，所以「重新传同一张」
 * **一定会撞上自己以前那块碑**；不翻的话文件在本地、却永远推不上桶，
 * 而且下一趟同步还会把它再删一次 —— 屏上什么都不会说。
 *
 * ★ 写的是显式 `gone: false`，**不是把这一栏删掉**：删掉 = 「没表态」，
 *   而没表态压不过对面那块碑（见 `core/splash-names.ts` 的三态那段）。
 * ★ 从来没删过的那些**不动**：给它们凭空写一条 `gone:false` 等于
 *   多造一条「声明它活着」的记录，将来会去压别人的碑。
 */
export function markSplashBack(db: Database, name: string, at: number): void {
  const cur = labels(db)
  if (cur[name]?.gone !== true) return
  putLabels(db, { ...cur, [name]: revive(cur[name], at) })
}

/** 换一张。★ 这一处**要抛** —— 他刚按了「启用」，存不进去必须当面说。 */
export function setActiveChoice(db: Database, c: SplashChoice): void {
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(SETTINGS_KEY, encodeSplashChoice(c), Date.now())
}

/**
 * 启动页那张图的字节。**读不出来给 `null`** —— 那时界面画图标版。
 *
 * ★ 回退链：他选的 → 出厂插画 → null（图标）。
 *   选了「图标」时**直接给 null**，那不是失败，是他要的那一版。
 */
export function splashArt(paths: NyxPaths, db: Database | null): string | null {
  const choice = db ? activeChoice(db) : DEFAULT_CHOICE
  if (choice.kind === 'icon') return null
  if (choice.kind === 'user') {
    const art = readSplash(paths, choice.name)
    if (art) return art
    /* 他选的那张读不出来 —— 换机器还没同步到、或者他把文件删了。
       **不报错，退到出厂那张**：启动页不是他此刻要处理的事。 */
  }
  return shippedArt(paths.resources)
}

/**
 * ══ 删掉一张他自己传的图 ★★（使用者 2026-09-14 裁「选 a」）════
 *
 * 两件事：删文件 · 立一块碑。碑走同步，另一端跟着删、桶里那个对象也没。
 * （只删本机的话，下一趟同步就从桶里拉回来 —— 2026-09-13 真出过一次。）
 *
 * ★★ **它故意不动 `splash.active`**，这一条得写清楚，
 *    因为最容易想到的「修法」正是在这儿把它改回出厂：
 *
 *    · 库里那一条记的是「**他本来要哪一张**」。同一张图再加回来时
 *      （碑被 `gone:false` 压过），他的选择要跟着回来，不用重新挑一次。
 *      清成出厂就把这份记忆抹了。
 *    · 「下次启动他会看到选了但没了」这个担心**不成立**：
 *      `splashArt` 早就退回出厂那张了（见下面），屏上不会空。
 *      旧代码里那行清库写的就是这个理由，而那是我看错了渲染路径。
 *    · 还有一条更硬的：**同步过来的那一路本来就不碰库**
 *      （`sync/index.ts` 里那个 `delete` 只 `rmSync`）。只在本机删时清库的话，
 *      **同一个动作在两端按会得到两种结果** —— 那是真正的毛病。
 *
 * ★ 屏上该亮哪一枚由 `core/splash-name.ts::shownChoice` 回答（不写库）。
 */
export function deleteUserSplash(
  paths: NyxPaths,
  db: Database,
  name: string,
  at: number
): void {
  removeSplash(paths, name)
  markSplashGone(db, name, at)
}
