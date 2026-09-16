/**
 * 提示词覆盖 · 三层优先级的运行时事实 · T-7.3
 *
 * ══ 它挡的是哪一种事故 ═══════════════════════════════════════
 *
 * 同一句提示词有三个地方能改（说明见 `docs/PROMPT_LAYERS.md`）：
 *
 *   ① `user_preferences['prompt.<name>']`   他在手机 / 电脑上改的，**同步表**，跟着人走
 *   ② `data/prompts/<name>.md`              他电脑上那份（D-223 特意让他能直接改）
 *   ③ `main/ai/prompts.ts` 的 BUILTIN 副本   只有两份有
 *
 * 三层的每一次「往下落」都是**静默**的 —— 落错了不会抛、不会红，
 * 只会让他看到「AI 出的题没一道能用」，而账记在 AI 和他自己头上。
 *
 * `check:contract` 第 ⑥ 节守的是**名单与说明对不对得上**（静态）。
 * 这里守的是**跑起来真的是这个顺序**（动态）—— 两件事，缺一条都能单独漂：
 * 名单对着、`loadPrompt` 里 if 的顺序写反了，静态那条闸一个字都看不出来。
 *
 * ══ 为什么在 ② 档而不是 `npm test` ═══════════════════════════
 *
 * `main/ai/prompts.ts` 末尾 re-export 了 `@core/prompt-fill.ts`。那个别名由
 * electron-vite 打包时解析，**纯 node 的 `node --test` 跑不通**（同 harness.ts
 * 顶上 `--dump-schema` 那段说的道理）。所以判据只能在这一档跑。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPrompt, setPromptOverrides } from '../../src/main/ai/prompts.ts'
import { OVERRIDABLE_PROMPTS, promptPrefKey, SHARED_PROMPTS } from '../../src/core/prompt-overrides.ts'
import { check, assert, freshDir } from './harness.ts'
import { openDatabase } from '../../src/main/db/open.ts'
import { Prefs } from '../../src/main/db/prefs.ts'
import {
  migrateReadingOnce,
  readingState,
  saveReadingFaces,
  saveReadingOption
} from '../../src/main/reading-faces.ts'
import { practiceOptions, savePracticeOption } from '../../src/main/practice-rules.ts'
import {
  DEFAULT_READING_RULES,
  READING_FACES,
  READING_RULES_BEFORE_OPTIONS
} from '../../src/core/reading-face.ts'
import {
  CONTEXT_SPREAD_LINES,
  FULL_SENTENCE_LINE,
  MATCH_REGISTER_LINE,
  NO_SOURCE_LINE,
  noteLastFace,
  parseLastFace,
  PRACTICE_RULES_FACTORY,
  READING_RULES_FACTORY
} from '../../src/core/quiz-rules.ts'
import { fill } from '../../src/core/prompt-fill.ts'
import {
  practiceGlobalLines,
  practiceHintLines
} from '../../src/core/quiz-rules.ts'
import { QTypes } from '../../src/main/db/qtypes.ts'
import { PREF_KEYS, prefUid } from '../../src/core/prefs.ts'
import { isSyncTable } from '../../src/core/sync-tables.ts'
import { Study } from '../../src/main/study.ts'

console.log('\n提示词覆盖 · 三层优先级\n')

/**
 * 造一个「他以前写过认读出题规则」的老库。
 *
 * ★★ 不能走 `Prefs.set`：`prompt.reading-card` 2026-09-15 从可覆盖名单里摘掉了（D-482），
 *   白名单从此拒写它 —— 而**这正是要的**（再没有任何代码该往那里写）。
 *   老库里那一行是**以前的版本**留下的，所以 fixture 直接插库。
 *   ★ uid **自己算**（`prefUid`，和 `Prefs.set` 同一条 canonical identity）——
 *     那一列是 `text primary key not null`，而补 uid 的触发器是 `after insert`，
 *     留空会当场撞 NOT NULL。
 */
function seedLegacyRules(db: import('better-sqlite3').Database, text: string): void {
  const t = Date.now()
  db.prepare(
    `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)
       on conflict(uid) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(prefUid('prompt.reading-card'), 'prompt.reading-card', text, t, t)
}

/** 有 BUILTIN 副本的那两份之一 —— 只有它能一路落到第 ③ 层 */
const WITH_BUILTIN = 'analyze-material'
/** 没有 BUILTIN 副本的：文件缺了就该当场抛，不许静默 */
const NO_BUILTIN = 'generate-questions'

const MD = (sys: string, usr: string): string =>
  ['## SYSTEM', '', sys, '', '## USER', '', usr, ''].join('\n')

/**
 * 一个只有这一条用例看得见的 prompts 目录。
 * ★ 每条用例自己建自己的 —— 共用一个目录的话，前一条删了文件，后一条读到的是
 *   「文件不在」而不是它自己摆的场景，红起来指向的地方是错的（I-136 定向注入同一条道理）。
 */
function promptsDir(): string {
  const { dir } = freshDir()
  const d = join(dir, 'prompts')
  mkdirSync(d, { recursive: true })
  return d
}

/** 装一层覆盖，跑完一定摘掉 —— 它是模块级的全局，漏掉会污染后面所有用例 */
function withOverride<T>(of: (name: string) => string | null, fn: () => T): T {
  setPromptOverrides(of)
  try {
    return fn()
  } finally {
    setPromptOverrides(null)
  }
}

// ── 前提：这两个名字确实一个有 BUILTIN、一个没有 ────────────────
// 不先钉住它，下面每一条都可能在验一个不存在的场景（「绿着什么都没验」）
check('P-0 · 前提：analyze-material 有内置副本，generate-questions 没有', () => {
  const empty = promptsDir()
  const b = loadPrompt(empty, WITH_BUILTIN)
  assert(b.source === 'builtin', `★★ 前提没成立：${WITH_BUILTIN} 落不到 BUILTIN（source=${b.source}）`)
  let threw = ''
  try {
    loadPrompt(empty, NO_BUILTIN)
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  assert(
    threw.includes(NO_BUILTIN),
    `★★ 前提没成立：${NO_BUILTIN} 没有内置副本、文件也不在，却没抛（抛的是「${threw}」）`
  )
})

check('P-1 · 没有覆盖时读磁盘那份', () => {
  const d = promptsDir()
  writeFileSync(join(d, `${WITH_BUILTIN}.md`), MD('SYS-FILE', 'USR-FILE'), 'utf8')
  const p = loadPrompt(d, WITH_BUILTIN)
  assert(p.system === 'SYS-FILE' && p.user === 'USR-FILE', `读到的不是磁盘那份：${p.system} / ${p.user}`)
  assert(p.source === 'file', `source 应该是 file，是 ${p.source}`)
})

check('P-2 ★★★ · 覆盖压过磁盘那份', () => {
  const d = promptsDir()
  writeFileSync(join(d, `${WITH_BUILTIN}.md`), MD('SYS-FILE', 'USR-FILE'), 'utf8')
  withOverride(
    (n) => (n === WITH_BUILTIN ? MD('SYS-OVER', 'USR-OVER') : null),
    () => {
      const p = loadPrompt(d, WITH_BUILTIN)
      assert(
        p.system === 'SYS-OVER' && p.user === 'USR-OVER',
        `★★★ 他改过的那份没生效，读的还是磁盘：${p.system} / ${p.user}\n` +
          `      → 手机上改了提示词，电脑上出的题还是老样子，而两边都不报错`
      )
    }
  )
})

check('P-3 ★★★ · 磁盘那份压过内置副本', () => {
  const d = promptsDir()
  writeFileSync(join(d, `${WITH_BUILTIN}.md`), MD('SYS-FILE', 'USR-FILE'), 'utf8')
  const p = loadPrompt(d, WITH_BUILTIN)
  assert(
    p.source === 'file' && p.system === 'SYS-FILE',
    `★★★ 磁盘上有那份却走了内置副本（source=${p.source}）\n` +
      `      → D-223 把 prompts/ 排在 asar 之外就是为了让他能改文件，这一层塌了等于 D-213 失效`
  )
})

check('P-4 · 三层一起在的时候，覆盖赢', () => {
  const d = promptsDir()
  writeFileSync(join(d, `${WITH_BUILTIN}.md`), MD('SYS-FILE', 'USR-FILE'), 'utf8')
  withOverride(
    () => MD('SYS-OVER', 'USR-OVER'),
    () => {
      const p = loadPrompt(d, WITH_BUILTIN)
      assert(p.user === 'USR-OVER', `三层都在时读到的是 ${p.user}，不是覆盖那份`)
    }
  )
})

// ── 「往下落」的两条：空的那一层不算数 ──────────────────────────
// 判据是 USER 段非空。半截提示词发出去，AI 只能自己发挥，
// 而软件照常收货、照常按判据筛，最后报的是「AI 出的题没一道能用」。
check('P-5 ★★ · 覆盖的 USER 段是空的 → 落回磁盘，不是用一份空的', () => {
  const d = promptsDir()
  writeFileSync(join(d, `${WITH_BUILTIN}.md`), MD('SYS-FILE', 'USR-FILE'), 'utf8')
  withOverride(
    () => MD('SYS-OVER', ''),
    () => {
      const p = loadPrompt(d, WITH_BUILTIN)
      assert(
        p.user === 'USR-FILE',
        `★★ 覆盖那份的 USER 段是空的，却还是用了它（user=「${p.user}」）—— 半截提示词会发出去`
      )
    }
  )
})

check('P-6 ★★ · 磁盘那份的 USER 段是空的 → 落到内置副本', () => {
  const d = promptsDir()
  writeFileSync(join(d, `${WITH_BUILTIN}.md`), MD('SYS-FILE', ''), 'utf8')
  const p = loadPrompt(d, WITH_BUILTIN)
  assert(p.source === 'builtin', `★★ 磁盘那份是空的，却没落到内置副本（source=${p.source}）`)
})

check('P-7 · 覆盖读崩了不许把整条 AI 链带塌', () => {
  const d = promptsDir()
  writeFileSync(join(d, `${WITH_BUILTIN}.md`), MD('SYS-FILE', 'USR-FILE'), 'utf8')
  withOverride(
    () => {
      throw new Error('库读不出来')
    },
    () => {
      const p = loadPrompt(d, WITH_BUILTIN)
      assert(p.user === 'USR-FILE', `覆盖那一层抛了之后没落回磁盘，读到的是 ${p.user}`)
    }
  )
})

check('P-8 ★★ · 没有内置副本的那几份，文件缺了要当场抛', () => {
  const d = promptsDir()
  let threw = false
  try {
    loadPrompt(d, NO_BUILTIN)
  } catch {
    threw = true
  }
  assert(
    threw,
    `★★ ${NO_BUILTIN} 的文件不在、内置副本也没有，却安静地返回了 —— ` +
      `静默降级成一份不知道哪来的提示词，比打不开更贵`
  )
})

// ── 名单这一侧：能覆盖的四条与 PREF 白名单 ───────────────────────
check('P-9 · SHARED_PROMPTS 就是 scope=both 那几条，没有第二处名单', () => {
  const both = OVERRIDABLE_PROMPTS.filter((p) => p.scope === 'both').map((p) => p.name)
  const shared = SHARED_PROMPTS.map((p) => p.name)
  assert(
    both.length === shared.length && both.every((n, i) => n === shared[i]),
    `SHARED_PROMPTS 与 scope=both 对不上：${shared.join('、')} ≠ ${both.join('、')}`
  )
  assert(shared.length > 0, '★★ SHARED_PROMPTS 是空的 —— Windows 那个钩子会一条都不认')
})

/**
 * ★★ I-157（2026-09-07）· 账上分得出第 ① 层和第 ② 层了。
 *
 * ── 这一条原来钉的是什么 ──────────────────────────────────
 *
 * 它原来叫「【记录今天的事实】覆盖命中时 source 仍报 file」，钉的是**当时的病**：
 * 第 ① 层命中时返回 `source: 'file'` 加上磁盘那份的 `path`，于是他在手机上改过之后，
 * 电脑这边的诊断说「读的是 data/prompts/xxx.md」——**而那句是假的**，
 * 用的根本不是那个文件，那个文件甚至可能不存在。
 * 那条用例的头注写着「改对了这一条会红，那时候是对的：和 PROMPT_LAYERS.md §五·1
 * 一起改掉，别把它删了了事」。现在就是那一刻，所以它没被删，被改成了下面这样。
 *
 * ── 现在钉的是什么 ────────────────────────────────────────
 *
 *   · 覆盖命中 → `source: 'override'`，`path` 是**偏好键**（`prompt.<name>`）
 *   · ★ `path` 里不许再出现磁盘那份的文件名 —— 冒充磁盘那份正是被修掉的那件事
 *   · 摘掉覆盖之后，同一次调用回到 `source: 'file'` + 那个 .md 的路径（对照的另一半）
 *
 * 用哪一份**没变**：覆盖仍然赢（下面第一句断言）。这一条只管账记得对不对。
 */
check('P-10 · 覆盖命中时 source = override、path 指偏好键 —— 不冒充磁盘那份（I-157）', () => {
  const d = promptsDir()
  writeFileSync(join(d, `${WITH_BUILTIN}.md`), MD('SYS-FILE', 'USR-FILE'), 'utf8')
  withOverride(
    () => MD('SYS-OVER', 'USR-OVER'),
    () => {
      const p = loadPrompt(d, WITH_BUILTIN)
      assert(p.user === 'USR-OVER', `用的该是覆盖那份，实际 user=${p.user}`)
      assert(p.source === 'override', `★★ 账上分不出第①层：source=${p.source}`)
      assert(
        p.path === promptPrefKey(WITH_BUILTIN),
        `★ path 该是偏好键 ${promptPrefKey(WITH_BUILTIN)}，实际 ${p.path}`
      )
      assert(
        !p.path.includes('.md'),
        `★★ path 仍然指着磁盘那份（${p.path}）—— 他会照着这句去改一个没被用到的文件`
      )
    }
  )
  // 对照的另一半：没有覆盖时，同一次调用照旧报 file + 那个 .md
  const q = loadPrompt(d, WITH_BUILTIN)
  assert(
    q.source === 'file' && q.path.includes(`${WITH_BUILTIN}.md`) && q.user === 'USR-FILE',
    `★ 摘掉覆盖之后该回到磁盘那份：source=${q.source} path=${q.path}`
  )
})

check('P-11 · 出厂那份都在仓里（builtin: file 的每一条）', () => {
  for (const p of OVERRIDABLE_PROMPTS) {
    if (p.builtin !== 'file') continue
    const f = join(process.cwd(), 'prompts', `${p.name}.md`)
    assert(existsSync(f), `★★ ${p.name} 说默认在 prompts/${p.name}.md，那个文件不在`)
  }
})

// 跑完把全局钩子摘干净 —— 后面还有别的分册在同一个进程里跑
setPromptOverrides(null)

// ══════════════════════════════════════════════════════════════
// ★★★ D-479 · 认读测试：牌面（多选）+ 出题规则（一份）
// ══════════════════════════════════════════════════════════════

check('★★★ D-479 · 一面都不勾 → 当场拒绝，说人话（不兜底、不静默改回全开）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const before = readingState(r.db).faces
  assert(before.length === READING_FACES.length, `牌面没全给出来：${before.length}`)
  assert(before.every((f) => f.on), '出厂该是全开')

  let why = ''
  try {
    saveReadingFaces(r.db, before.map((f) => ({ id: f.id, on: false })))
  } catch (e) {
    why = (e as Error).message
  }
  assert(/至少留一面/.test(why), `★★★ 一面都不勾居然存进去了：${why || '（没报错）'}`)
  // 拒绝之后**库里那份没变**（不是先写坏再报错）
  assert(readingState(r.db).faces.every((f) => f.on), '★★★ 拒绝了却把勾选写坏了')
  r.db.close()
})

check('★★★ D-479 · 勾两面存得住、读得回（那两面就是发给 AI 的那两面）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const want = new Set(['cloze', 'define'])
  const out = saveReadingFaces(
    r.db,
    READING_FACES.map((f) => ({ id: f.id, on: want.has(f.id) }))
  )
  assert(
    out.faces.filter((f) => f.on).map((f) => f.id).join(',') === 'cloze,define',
    `存回来的不是那两面：${JSON.stringify(out.faces)}`
  )
  // 重新读一遍（走库，不是内存里那份）
  const again = readingState(r.db)
  assert(again.faces.filter((f) => f.on).length === 2, '★★★ 重新读回来变了')
  r.db.close()
})

check('★★★ D-479 · 迁移只迁一次：老「中译回想」→ 勾上那一面，改完之后不再被覆盖', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  // 他机器上现在的样子：`prompt.reading-card` 里躺着一整段老提示词
  seedLegacyRules(
    r.db,
    '你在给一个中文母语者出一张英语「认读卡」的题面。**用一种形式：中译回想。**'
  )

  const first = readingState(r.db)
  assert(
    first.faces.filter((f) => f.on).map((f) => f.id).join(',') === 'zh-recall',
    `★★★ 迁移没认出「中译回想」：${JSON.stringify(first.faces)}`
  )
  /**
   * ★★ 2026-09-15 起这一趟**不再回写正文**（D-482：`prompt.reading-card` 摘出白名单，
   *   `Prefs.set` 从此拒写它）。所以判据从「换成出厂那份」改成「**一个字没动**」——
   *   规则由三个选项拼，老正文只读展示。
   */
  assert(
    new Prefs(r.db).raw('prompt.reading-card') ===
      '你在给一个中文母语者出一张英语「认读卡」的题面。**用一种形式：中译回想。**',
    '★★★ 老正文被动过了 —— 这一趟只该勾牌面，不该碰那一行'
  )

  // 他自己又改了一次：勾成两面
  saveReadingFaces(r.db, READING_FACES.map((f) => ({ id: f.id, on: f.id !== 'zh-recall' })))
  // 再打开设置页 —— 迁移**不许**再跑一遍把他的选择盖回去
  const second = readingState(r.db)
  assert(
    !second.faces.find((f) => f.id === 'zh-recall')!.on,
    '★★★ 迁移又跑了一遍，把他改过的选择盖回去了 —— 记号没起作用'
  )
  r.db.close()
})

check('★★ D-479 · 认不出的老提示词一个字都不动（他自己写的那份不许被猜掉）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const mine = '我自己从头写的认读提示词，随便怎么出题。'
  seedLegacyRules(r.db, mine)

  const st = readingState(r.db)
  assert(
    new Prefs(r.db).raw('prompt.reading-card') === mine,
    '★★★ 他自己写的那份被换掉了'
  )
  assert(st.legacy === mine, `★★★ 他以前写的那段没原样还给界面：${String(st.legacy).slice(0, 30)}`)
  assert(st.faces.every((f) => f.on), '认不出时牌面该是出厂全开')
  r.db.close()
})

/**
 * ★★ 老那条「规则空着 → 退回出厂」2026-09-15 作废（D-482）：
 *   写正文这条入口整条撤了（编辑框收起，`saveReadingRules` 跟着删）。
 *   钉一个已经不存在的入口 = 下一个人以为它还在。换成下面那一组老数据认账。
 */

check('★ D-479 · 迁移记号落在 settings（DEVICE），重开软件不再迁一次', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  migrateReadingOnce(r.db)
  const mark = r.db
    .prepare(`select value from settings where key = 'reading.facesMigratedAt'`)
    .get() as { value: string } | undefined
  assert(mark !== undefined, '记号没落库')
  /**
   * ★★★ 而且**不许落在偏好表**（2026-09-08 · smoke:sync S7）。
   *   它进过 `user_preferences` 一天：那张表进同步、行的 uid 由键名算，
   *   两台机器写同一个 uid 各写各的时间戳 = 必然冲突，重放老包还会再变一次状态。
   */
  assert(
    new Prefs(r.db).raw('reading.facesMigratedAt') === null,
    '★★★ 记号又写进偏好表了 —— 那是同步表，两台各写各的就是必然冲突（S7）'
  )
  r.db.close()
})

/**
 * ★★★ **读一次状态，不许在同步表里写一行**（S7 那条病的根，直接钉在最便宜的一层）。
 *
 * 病的形状：`readingState()` 里那趟一次性迁移**无条件**写一行偏好。
 * 单机上完全看不出来 —— 值是对的、界面是对的、`test:db` 也全绿；
 * 只有两台机器同时用才炸，而那是 `smoke:sync` 里最贵的一条用例（S7，2000×2 行）。
 * 所以这里用最便宜的方式问同一个问题：**光是读，偏好表动了吗。**
 */
check('★★★ D-479 · 光是读认读状态，不许动偏好表（同步表上的无条件写 = 必然冲突）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const rows = (): string =>
    JSON.stringify(
      r.db.prepare(`select key, value, updated_at from user_preferences order by key`).all()
    )
  const before = rows()
  readingState(r.db)
  readingState(r.db)
  assert(rows() === before, '★★★ 只是读了两次认读状态，偏好表就变了 —— 那是要同步出去的')
  r.db.close()
})


/**
 * ══ D-482 · 出题规则改成点选项（使用者 2026-09-15「全部按照推荐的来」）══
 *
 * 下面这一组钉的是**老数据认账**（确认单 §四）和**那个新存的数**（A-2）。
 * 两件事的共同点：错了都不报错 —— 一个表现为「他没写过的话被说成他写的」，
 * 一个表现为「轮着来和以前一模一样」。
 */

check('★★★ D-482 · 没改过的库：无声无息，不给他看任何「你以前写的」', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  /** 三种「出厂原样」都要认得出来 —— 只认今天这份的话，老用户全被判成「改过」 */
  for (const text of [null, READING_RULES_BEFORE_OPTIONS, DEFAULT_READING_RULES]) {
    if (text !== null) seedLegacyRules(r.db, text)
    const st = readingState(r.db)
    assert(
      st.legacy === null,
      `★★★ 出厂原样却被判成「他改过」：${String(text).slice(0, 24)} —— ` +
        '他会收到一句自己一个字都没写过的话'
    )
    assert(
      JSON.stringify(st.options) === JSON.stringify(READING_RULES_FACTORY),
      '没改过的库该按出厂值勾上'
    )
  }
  r.db.close()
})

check('★★★ D-482 · 改过的库：他那份正文一个字不动，只读展示', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const mine = '我自己写的：每次都用中文问，别给英文线索。'
  seedLegacyRules(r.db, mine)

  const st = readingState(r.db)
  assert(st.legacy === mine, '★★★ 他以前写的那段没还给界面')
  assert(new Prefs(r.db).raw('prompt.reading-card') === mine, '★★★ 他那份正文被动过了')
  /**
   * ★★★ 负向对照盯的就是这一句：把「改过 → 不动正文」那半拆掉
   *   （例如迁移里顺手 `prefs.set(promptPrefKey('reading-card'), DEFAULT_READING_RULES)`），
   *   上面那两句当场红在「旧正文被覆盖」。
   */
  assert(
    JSON.stringify(st.options) === JSON.stringify(READING_RULES_FACTORY),
    '改过的库，选项也该按出厂值勾上（不去猜他那段话对应哪几个选项）'
  )
  r.db.close()
})

check('★★ D-482 · 题型写过自定义出题要求：继续用他写的，不自动清空', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const qt = new QTypes(r.db)
  const one = qt.all()[0]!
  qt.save({ ...one, prompt: 'Ask them to write a limerick.' })

  practiceOptions(r.db) // 认账那一趟
  const after = new QTypes(r.db).all().find((q) => q.uid === one.uid)!
  assert(
    after.prompt === 'Ask them to write a limerick.',
    '★★★ 他写过的出题要求被自动清空了 —— 那是悄悄改掉他调过的出题方式'
  )
  r.db.close()
})

check('★★ D-482 · 两个记号都落在 settings（DEVICE），不进偏好白名单', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  readingState(r.db)
  practiceOptions(r.db)
  for (const key of ['reading.optionsMigratedAt', 'qtypes.optionsMigratedAt']) {
    const mark = r.db.prepare(`select value from settings where key = ?`).get(key) as
      | { value: string }
      | undefined
    assert(mark !== undefined, `记号没落库：${key}`)
    /**
     * ★★★ 进了偏好表就是同步表上的无条件写：两台机器算出同一个 uid、
     *   各写各的时间戳 = 必然冲突（2026-09-08 smoke:sync S7 真红过）。
     *   `check:contract` 那一侧也钉着同一件事（白名单项数）。
     */
    assert(new Prefs(r.db).raw(key) === null, `★★★ 记号写进偏好表了：${key}`)
  }
  r.db.close()
})

check('★★★ D-482 · 七个选项存得住读得回（save → 再读一次设置页）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)

  saveReadingOption(r.db, { facePick: 'rotate' })
  saveReadingOption(r.db, { hintLevel: 'less' })
  saveReadingOption(r.db, { shiftContext: false })
  const read = readingState(r.db).options
  assert(read.facePick === 'rotate' && read.hintLevel === 'less' && !read.shiftContext,
    `★★★ 认读那三个没读回来：${JSON.stringify(read)}`)

  savePracticeOption(r.db, { hintLevel: 'none' })
  savePracticeOption(r.db, { contextSpread: 'far' })
  savePracticeOption(r.db, { requireFullSentence: false })
  savePracticeOption(r.db, { matchRegister: false })
  const w = practiceOptions(r.db)
  assert(
    w.hintLevel === 'none' && w.contextSpread === 'far' && !w.requireFullSentence && !w.matchRegister,
    `★★★ 写作那四个没读回来：${JSON.stringify(w)}`
  )

  /** ★ 只递改动的那一项 —— 存第四个的时候不许把前三个写回出厂 */
  savePracticeOption(r.db, { matchRegister: true })
  const again = practiceOptions(r.db)
  assert(again.contextSpread === 'far', '★★ 存一项把别的项冲掉了')
  r.db.close()
})

check('★★★ D-482 · A-2 那个数存在 settings 里，落库读得回，而且**没动任何表结构**', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)

  /**
   * ★★★ 主控 2026-09-15 改判：这个数**不进同步表、不加列不加表**。
   *   加列会改结构表面指纹，而协调升级要 Android 真上机一次，和这一轮「不装机」冲突。
   *   所以这里先钉住「那一列不许出现」—— 哪天有人又把它加回同步表，这条当场红。
   */
  const cols = (r.db.prepare(`pragma table_info("reading_cards")`).all() as { name: string }[]).map(
    (c) => c.name
  )
  assert(
    !cols.includes('face_log'),
    '★★★ 又往同步表 reading_cards 上加列了 —— 指纹会变，两端就得协调升库'
  )

  const t = Date.now()
  const raw = noteLastFace(null, 'items-abc', 'cloze')
  r.db
    .prepare(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    )
    .run('reading.lastFace', raw, t)

  const back = r.db.prepare(`select value from settings where key = 'reading.lastFace'`).get() as
    | { value: string }
    | undefined
  assert(parseLastFace(back?.value)['items-abc'] === 'cloze', `★★★ 没读回来：${String(back?.value)}`)

  /** ★★ 它是 DEVICE：既不许进偏好白名单（同步表），也不许被推上云 */
  assert(!PREF_KEYS.includes('reading.lastFace'), '★★★ 这个数进了偏好白名单 —— 那是同步表')
  assert(!isSyncTable('settings'), 'settings 本来就不该在 SYNC_TABLES 里')
  r.db.close()
})

/**
 * ══ A-3 · 每一档渲染一次，看真的拼进模板了 ═══════════════════
 *
 * ★ 为什么在这一档跑：`fill` 要的模板是磁盘上那份 md（D-213 它是文件），
 *   而这条路上最容易出的事是**占位符没人填** —— 那一段会原样发给 AI，
 *   `fill` 会当场抛（F-6 那条用例守的就是它）。所以这里连 `fill` 一起验。
 */
check('★★★ D-482 · W-1 三档渲染：目标表达永远在，释义 / 原句按档', () => {
  const p = loadPrompt('prompts', 'generate-questions')
  const material = { gloss: 'to take the worst of it', quote: 'She bore the brunt.' }
  const render = (level: 'full' | 'gloss-only' | 'none'): string => {
    const rules = { ...PRACTICE_RULES_FACTORY, hintLevel: level }
    return fill(p.user, {
      TERM: 'bear the brunt',
      GLOSS: material.gloss,
      QUOTE: material.quote,
      LEVEL: 'B2',
      TYPES: '（略）',
      SPREAD: CONTEXT_SPREAD_LINES[rules.contextSpread],
      OPTIONS: practiceGlobalLines(rules).join('\n'),
      HINTS: practiceHintLines(rules, material).join('\n')
    })
  }
  const full = render('full')
  assert(full.includes('Meaning: to take the worst of it'), 'full 档没给释义')
  assert(full.includes('She bore the brunt.'), 'full 档没给原句')

  const gloss = render('gloss-only')
  assert(gloss.includes('Meaning: to take the worst of it'), 'gloss-only 档没给释义')
  assert(!gloss.includes('Where the learner met it'), 'gloss-only 档还在给原句')

  const none = render('none')
  assert(!none.includes('Meaning:'), 'none 档还在给释义')
  assert(!none.includes('She bore the brunt.'), '★★★ none 档把原句漏出去了')
  for (const one of [full, gloss, none]) {
    assert(one.includes('bear the brunt'), '★★★ 目标表达那一行不见了（D-137：三档都给）')
  }
})

check('★★★ D-482 · W-2 三档渲染：语境跨度那一段按档换', () => {
  const p = loadPrompt('prompts', 'generate-questions')
  const render = (spread: 'near' | 'mixed' | 'far'): string =>
    fill(p.system, {
      TERM: 'x', GLOSS: 'x', QUOTE: 'x', LEVEL: 'B2', TYPES: '（略）',
      SPREAD: CONTEXT_SPREAD_LINES[spread], OPTIONS: '', HINTS: ''
    })
  assert(render('near').includes('Use context values "original" and "near" only.'), 'near 没拼上')
  assert(render('mixed').includes('completely unfamiliar setting'), 'mixed 不是出厂那段')
  assert(render('far').includes('at least half in "far" or "unseen" settings.'), 'far 没拼上')
  /** ★ 三档互斥 —— 拼了一档就不该同时留着另一档 */
  assert(!render('near').includes('at least half in "far"'), '★★ near 里混进了 far 那一段')
})

check('★★ D-482 · W-1「都不给」那一档额外那句真的进了 system', () => {
  const p = loadPrompt('prompts', 'generate-questions')
  const sys = (level: 'full' | 'none'): string =>
    fill(p.system, {
      TERM: 'x', GLOSS: 'x', QUOTE: 'x', LEVEL: 'B2', TYPES: '（略）',
      SPREAD: CONTEXT_SPREAD_LINES.mixed,
      OPTIONS: practiceGlobalLines({ ...PRACTICE_RULES_FACTORY, hintLevel: level })
        .map((x) => '- ' + x)
        .join('\n'),
      HINTS: ''
    })
  assert(sys('none').includes(NO_SOURCE_LINE), '★★★ 「都不给」却没拦住它去抄原句')
  assert(!sys('full').includes(NO_SOURCE_LINE), '出厂档不该多这一句')
})

/**
 * ★★★ W-3 / W-4 的豁免要在**真的拼出来的那一段**上验，不只在 core 里验。
 *   core 那一条（`quiz-rules.test.ts`）钉的是判据；这一条钉的是
 *   「判据真的接进了出题那条路」—— 两者缺一条都能单独漂。
 */
check('★★★ D-482 · W-3 / W-4 跟着每一种题型走（成段题型 / 语域转换不拼）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const study = new Study(r.db, 'prompts', () => 'B2')
  const inner = study as unknown as {
    typesBrief(plan: unknown[], rules: unknown): string
    plan(itemId: number): unknown[]
  }
  const brief = inner.typesBrief(
    [{ type: '造句' }, { type: '情景任务' }, { type: '语域转换' }],
    PRACTICE_RULES_FACTORY
  )
  const seg = (key: string): string => {
    const at = brief.indexOf('#### `' + key + '`')
    if (at < 0) return ''
    const next = brief.indexOf('#### `', at + 6)
    return brief.slice(at, next < 0 ? undefined : next)
  }
  assert(seg('造句').includes(FULL_SENTENCE_LINE), '「造句」该收到「必须写完整句」')
  assert(seg('造句').includes(MATCH_REGISTER_LINE), '「造句」该收到「贴着原文的语域」')
  assert(
    !seg('情景任务').includes(FULL_SENTENCE_LINE),
    '★★★ 「情景任务」本来就要写 80–120 词，却收到了「必须写完整句」'
  )
  assert(
    !seg('语域转换').includes(MATCH_REGISTER_LINE),
    '★★★ 「语域转换」收到了「语域要和原句一致」—— 题目自相矛盾'
  )
  r.db.close()
})
