import type { Database } from 'better-sqlite3'
import { promptPrefKey } from '@core/prompt-overrides.ts'
import {
  FACE_NAME_MAX,
  isCustomFaceId,
  migrateLegacyReadingPrompt,
  newFaceId,
  parseFacePrefs,
  READING_FACES,
  legacyReadingRulesOf,
  resolveFace,
  serializeFacePrefs,
  type FacePref
} from '@core/reading-face.ts'
import {
  QUIZ_RULE_KEYS,
  readingQTypeOf,
  readingRulesOf,
  type ReadingQType,
  type ReadingRules
} from '@core/quiz-rules.ts'
import type { ReadingFacesState } from '@shared/api.ts'
import { Prefs } from './db/prefs.ts'

/**
 * 认读测试的**牌面 + 出题规则** · D-479（使用者 2026-09-08）
 *
 * ── 为什么单独一个模块，而不是写在 `index.ts` 的 IPC 里 ★ ────
 *
 * 第一版就写在那儿。写完发现**验不到**：迁移与「至少留一面」这两条判据
 * 锁在 `registerAiIpc()` 的闭包里，`test:db` 够不着 —— 而它们正是这一轮
 * 最容易悄悄坏掉的两处（迁移只该跑一次；一面都不勾必须当场拒绝）。
 * 判据够不着的地方，就是下一次没人发现的地方。所以抽出来。
 *
 * ── 存在哪 ───────────────────────────────────────────────
 *
 *   `reading.faces`             勾了哪几面（USER · 同步）
 *   `prompt.reading-card`       出题规则正文（USER · 同步；**键没变，含义改了**）
 *   `reading.facesMigratedAt`   一次性迁移的记号 —— **DEVICE，在 `settings` 里，不同步**
 *
 * 老那张名单 `settings['reading.promptLib']` **退役只读**（D-216：库里那一行不删，
 * 只是再没有人读写它）。
 *
 * ── ★★★ 记号为什么必须**不同步**（2026-09-08 · smoke:sync S7 红过一次）──
 *
 * 第一版把它当成 USER 偏好写进了 `user_preferences`。那张表进同步，行的 uid 由
 * 键名算出来（`natUid`）—— 于是**两台机器算出同一个 uid**，而这一行又是
 * 「第一次读认读状态就无条件写一次」：两台各写各的时间戳 = **必然冲突**。
 * 后果不是「值不一样」这么轻：按 D-438 冲突要把输掉那一版记进 `ops_log`，
 * 于是每换一轮就多一行账；`sync.applied` 溢出后重放老包时又会再判一次 ——
 * **重放改变了状态**，S7「多轮收敛」当场红（`★★ applied 溢出重放改变了状态`）。
 *
 * 按 `core/prefs.ts` 自己写的判据问一句「换一台设备，这一项应该自动恢复吗」：
 * **不该** —— 新机器自己判一次就行，判不出来它本来就什么都不动（幂等）。
 * 所以它是 DEVICE：跟着机器走，进 `settings`，不进白名单。
 * ★ 同步是协议锁（ARCHITECTURE LOCKED ③）：`core/sync/*` 一个字没动，
 *   改的是**引入方这一侧**把一行不该同步的东西塞进了同步表。
 */

const FACES_KEY = 'reading.faces'
const FACES_MIGRATED_KEY = 'reading.facesMigratedAt'
/**
 * ★★ D-482 那一轮的记号（确认单 §四）。和上面那个同一个道理：**DEVICE**，
 *   在 `settings` 里，不进白名单 —— 「换一台设备这一项该自动恢复吗？不该，
 *   新机器自己认一次账就行」。进了同步表就是两台机器算出同一个 uid、
 *   各写各的时间戳 = 必然冲突（2026-09-08 `smoke:sync` S7 真红过一次）。
 */
const OPTIONS_MIGRATED_KEY = 'reading.optionsMigratedAt'

/** 记号读写 —— `settings` 是设备本地那张表（不带 uid、不进 SYNC_TABLES） */
function settingOf(db: Database, key: string): string | null {
  const r = db.prepare(`select value from settings where key = ?`).get(key) as
    | { value: string }
    | undefined
  return r?.value ?? null
}

function mark(db: Database, key: string): void {
  const t = Date.now()
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(t), t)
}

const migratedAt = (db: Database): string | null => settingOf(db, FACES_MIGRATED_KEY)
const markMigrated = (db: Database): void => mark(db, FACES_MIGRATED_KEY)

/**
 * ══ 老数据认账 · 出题规则改成点选项那一轮（D-482 · 确认单 §四）══════
 *
 * **认得出就认，认不出一字不动，记号幂等。**
 *
 * 他库里 `prompt.reading-card` 躺着的那段正文只有两种可能：
 *   · 某一版的**出厂原文** → 他没写过东西，选项按出厂勾上，**无声无息**
 *   · 别的什么          → 他自己改过，那段**一个字不动地留着**，
 *                          设置页上一行「你以前写的出题规则已经收起来了，在这儿可以看到」
 *
 * ★★★ **不去猜他那段话对应哪几个选项。** 猜错了就是悄悄改掉他定的考法，
 *   比不认账糟得多（`prompt-sync.ts` 头上那条教训：我删过他 22 本词典）。
 * ★★★ 「哪几版算出厂」那张名单在 core（`FACTORY_READING_RULE_TEXTS`），两端同一份 ——
 *   各留一份的话，加一版出厂正文时漏掉一端，那一端的老用户会集体收到
 *   「你以前写的出题规则已经收起来了」，而他一个字都没写过。
 * ★ 这一趟**一个字都不往同步表里写** —— 选项不写 = 读的时候回出厂值
 *   （`readingRulesOf` 的宽容读法），行为完全一样，而同步表上少一次无条件写。
 */
export function migrateReadingOptionsOnce(db: Database): void {
  if (settingOf(db, OPTIONS_MIGRATED_KEY) !== null) return
  mark(db, OPTIONS_MIGRATED_KEY)
}

/**
 * 他以前写的那份出题规则正文；出厂原样（或压根没设过）就是 `null`。
 * ★ 界面只拿它决定「要不要给他看那一段」，不参与出题拼装（D-482）。
 *
 * ★★ **判据不在这里**（2026-09-15 搬上去的，Nyx-UI-Android 提的）：
 *   「哪几版算出厂」那张名单在 `core/reading-face.ts::FACTORY_READING_RULE_TEXTS`，
 *   两端同一份。这一层只剩「把那一行的原值读出来」—— 那才是平台的事。
 */
export function legacyReadingRules(db: Database): string | null {
  return legacyReadingRulesOf(new Prefs(db).raw(promptPrefKey('reading-card')))
}

/** 三个选项的现值。没设过的按出厂 —— 判据在 core 一处 */
export function readingOptions(db: Database): ReadingRules {
  const prefs = new Prefs(db)
  return readingRulesOf((k) => prefs.raw(k))
}

/**
 * 存一个选项。
 * ★ 界面只递「改了哪一项」，不递整份 —— 递整份的话，两个标签页同时开着时
 *   后存的那一次会把前一次的改动一起写回去。
 */
export function saveReadingOption(
  db: Database,
  patch: Partial<ReadingRules>
): ReadingFacesState {
  migrateReadingOnce(db)
  migrateReadingOptionsOnce(db)
  const prefs = new Prefs(db)
  if (patch.facePick !== undefined) prefs.set(QUIZ_RULE_KEYS.facePick, patch.facePick)
  if (patch.hintLevel !== undefined) prefs.set(QUIZ_RULE_KEYS.readingHint, patch.hintLevel)
  if (patch.shiftContext !== undefined) {
    prefs.set(QUIZ_RULE_KEYS.shiftContext, patch.shiftContext ? '1' : '0')
  }
  return readingState(db)
}

/**
 * ★★★ 老数据一次性迁移：从「五份整段提示词选一份」到「牌面 + 规则」。
 *
 * 他机器上 `prompt.reading-card` 里躺着的是**一整段老提示词**。判据在 core
 * （`migrateLegacyReadingPrompt`）：认出那是哪种考法 → 勾上对应牌面、规则回出厂。
 *
 * ★ **认不出（他自己写过的）→ 一个字都不动**：那段正文原地变成他的「规则」，
 *   牌面用出厂全开。宁可让他自己去勾一次，也不拿猜出来的配置替换他写过的东西。
 * ★ 幂等**靠记号**（`reading.facesMigratedAt`），不靠比对形状 —— `tts.sources`
 *   那次（I-156 三张脸）的教训：形状随每一版变，记号不会。
 */
export function migrateReadingOnce(db: Database): void {
  if (migratedAt(db) !== null) return
  const prefs = new Prefs(db)
  const got = migrateLegacyReadingPrompt(prefs.raw(promptPrefKey('reading-card')))
  if (got) {
    prefs.set(
      FACES_KEY,
      serializeFacePrefs(READING_FACES.map((f) => ({ id: f.id, on: got.faceIds.includes(f.id) })))
    )
    /**
     * ★★ 2026-09-15 起**不再回写那段正文**（D-482）。
     *   `prompt.reading-card` 已经从可覆盖名单里摘掉，`Prefs.set` 从此拒写它 ——
     *   照旧写会当场抛，而这一趟是在「读设置页」的路上跑的：整页打不开。
     *   不写也不丢东西：规则由三个选项拼（`core/quiz-rules.ts`），
     *   老正文原样留在库里，由 `legacyReadingRules` 只读展示。
     */
  }
  markMigrated(db)
}

/** 设置页要的那一份：牌面（含勾没勾）+ 三个选项 + 他以前写的那段（只读） */
export function readingState(db: Database): ReadingFacesState {
  migrateReadingOnce(db)
  migrateReadingOptionsOnce(db)
  const prefs = new Prefs(db)
  const picked = parseFacePrefs(prefs.raw(FACES_KEY))
  return {
    /**
     * ★ 走 `resolveFace` 不走 `faceById`（使用者 2026-09-14 第一条）：
     *   自建那几面查不到出厂表里。`parseFacePrefs` 已经把解析不出来的丢掉了，
     *   所以这里剩下的一定解析得出来 —— 但仍然过滤一遍，不写 `!`：
     *   一个 `!` 断言换来的是「哪天形状变了就当场崩在设置页」。
     */
    faces: picked.flatMap((pref) => {
      const def = resolveFace(pref)
      if (!def) return []
      const custom = isCustomFaceId(pref.id)
      return [
        {
          id: def.id,
          name: def.name,
          says: def.says,
          on: pref.on,
          custom,
          ...(custom ? { guide: def.guide } : {})
        }
      ]
    }),
    options: readingOptions(db),
    qtype: readingQTypeOf((k) => prefs.raw(k)),
    legacy: legacyReadingRules(db)
  }
}

/**
 * 存勾选。
 *
 * ★★ **至少留一面**：一面都不勾 = 认读测试再也出不了 AI 牌面（退回机械挖空），
 *   而那件事他在界面上看不出原因。所以当场拒绝、说人话 ——
 *   **不兜底、也不静默改回全开**（替他勾回来就是「我的选择不算数」）。
 * ★ 过一遍 `parseFacePrefs` 归一化：界面传什么进来都不会把这份偏好写成读不出来的东西。
 */
export function saveReadingFaces(
  db: Database,
  list: readonly { id: string; on: boolean }[]
): ReadingFacesState {
  if (!list.some((x) => x.on)) {
    throw new Error('至少留一面 —— 一面都不勾，认读测试就出不了题了（会退回机械挖空）。')
  }
  migrateReadingOnce(db)
  /**
   * ★★ 界面只递 `{ id, on }`（它不该也不需要把自建面的正文再抄一遍回来）。
   *   所以这里拿**库里现存的那一份**当底，只把勾选叠上去 ——
   *   直接存界面递来的那个列表会把自建那几面的正文**整片抹掉**，
   *   而屏幕上只表现为「我建的那一面突然没了」。
   */
  const cur = current(db)
  const want = new Map(list.map((x) => [x.id, x.on !== false]))
  const next: FacePref[] = cur.map((f) => ({ ...f, on: want.get(f.id) ?? f.on }))
  new Prefs(db).set(FACES_KEY, serializeFacePrefs(next))
  return readingState(db)
}

/**
 * 存认读的题型（D-486）。
 * ★ 和出题规则分开一个入口：它不进提示词，混在一起存会让下一个人以为它也拼进去了。
 */
export function saveReadingQType(db: Database, v: ReadingQType): ReadingFacesState {
  migrateReadingOnce(db)
  new Prefs(db).set(QUIZ_RULE_KEYS.readingQType, v)
  return readingState(db)
}

/** 库里现存那一份（已经过 `parseFacePrefs` 归一化） */
function current(db: Database): FacePref[] {
  return parseFacePrefs(new Prefs(db).raw(FACES_KEY))
}

/**
 * ══ 新建 / 改一个自建牌面（使用者 2026-09-14 第一条）══════════════
 *
 * 他的原话：「认读测试的牌面目前没有明显的『新建牌面』入口……用户应该能够
 * 在这里直接创建新的认读测试牌面。」
 *
 * ★ 三样东西都得有，缺一不可，而且**当场说清缺的是哪一样**：
 *     名字   —— 屏上那一档写什么，也是模型该写进「形式：」那一行的词
 *     给他看 —— 这一面给他看什么（`says`，只给人读）
 *     给 AI  —— 这一面的内容怎么写（`guide`，真正发出去的那一段）
 *   `guide` 空着的话，这一面对模型**什么都没说** —— 勾上它等于勾了一个
 *   不存在的考法，而屏幕上什么都不会讲。所以它不是可选的。
 * ★ 名字卡在 6 个字：`parseFace` 解析模型回来的「形式：X」时会 `slice(0, 6)`，
 *   长过了屏上那一档会被截断，而他在输入框里看不出来。
 * ★ 新建的那一面**默认勾上**：他刚建完，不勾上等于建了个看不见效果的东西。
 */
export function saveCustomFace(
  db: Database,
  face: { id?: string; name: string; says: string; guide: string },
  now: number = Date.now()
): ReadingFacesState {
  const name = (face.name ?? '').trim()
  const guide = (face.guide ?? '').trim()
  const says = (face.says ?? '').trim()
  if (!name) throw new Error('先给这一面起个名字 —— 屏幕上那一档显示的就是它。')
  if (name.length > FACE_NAME_MAX) {
    throw new Error(
      `名字最多 ${FACE_NAME_MAX} 个字（现在 ${name.length} 个）—— 再长的话，出题时那一行会被截断。`
    )
  }
  if (!guide) {
    throw new Error('「给 AI 的说明」不能空着 —— 空着的话这一面对模型什么都没说，出不了题。')
  }
  migrateReadingOnce(db)
  const cur = current(db)
  if (face.id) {
    if (!isCustomFaceId(face.id)) {
      throw new Error('出厂那四面改不了 —— 它们是电脑和手机共用的规则。想要别的考法就新建一面。')
    }
    const i = cur.findIndex((f) => f.id === face.id)
    if (i < 0) throw new Error('这一面已经不在了 —— 可能在另一台设备上被删掉了。')
    cur[i] = { id: face.id, on: cur[i]!.on, custom: { name, says, guide } }
  } else {
    cur.push({
      id: newFaceId(now, cur.map((f) => f.id)),
      on: true,
      custom: { name, says, guide }
    })
  }
  new Prefs(db).set(FACES_KEY, serializeFacePrefs(cur))
  return readingState(db)
}

/**
 * 删一个自建牌面。
 * ★ 出厂那四面删不得 —— 它们是两端共用的判据，删掉之后手机上那一份还在，
 *   同一张认读卡在两台机器上考法就不一样了。
 * ★ 删到一面不剩也不许（和 `saveReadingFaces` 同一条）：一面都没有 =
 *   认读退回机械挖空，而屏幕上不会说原因。
 */
export function deleteCustomFace(db: Database, id: string): ReadingFacesState {
  if (!isCustomFaceId(id)) {
    throw new Error('出厂那四面删不了 —— 不想用就把它关掉。')
  }
  migrateReadingOnce(db)
  const cur = current(db)
  const next = cur.filter((f) => f.id !== id)
  if (next.length === cur.length) throw new Error('这一面已经不在了。')
  if (!next.some((f) => f.on)) {
    throw new Error('删了它就一面都不剩了 —— 先勾上别的一面再删。')
  }
  new Prefs(db).set(FACES_KEY, serializeFacePrefs(next))
  return readingState(db)
}

/**
 * ══ 「整段正文编辑」2026-09-15 退役（D-482）═══════════════════
 *
 * `saveReadingRules` / `restoreReadingRules` 两个入口跟着编辑框一起撤了 ——
 * 留着它们就是**第二条能改出题规则的路**，而那条路写出来的正文
 * 从此不参与拼装：点了「保存」，屏幕上说存好了，出题一个字都不变。
 *
 * ★ `prompt.reading-card` 那一行**留在库里，一个字不删**（D-216）：
 *   他以前写的东西通过 `legacyReadingRules` 只读展示，
 *   哪天要恢复这条输入方式，正文还在原处。
 */
