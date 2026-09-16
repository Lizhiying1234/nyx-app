import type { Database } from 'better-sqlite3'
import { QTYPES } from '@core/qtypes.ts'
import { canonicalUid } from '@core/builtin-identity.ts'

/**
 * 出厂内容自愈 · I-118
 *
 * ── 这个 bug 是怎么被找出来的 ──────────────────────────────
 *
 * 「清除全部数据」上线之后做整体排查时发现的：
 * 导师、体裁、题型、分析预设这四样是**迁移里播种的**，
 * 而迁移只跑一次。清空之后重启，`user_version` 已经是最新，
 * 迁移不会再跑 —— **这四张表就永远空着**。
 *
 * 后果比「没有内容」更糟，因为其中三个是静默降级：
 *   · `tutors` 空  → 文件学习聊天抛「一个导师都没有」（至少还报错）
 *   · `genres` 空  → Quest 拿到一个假体裁（id=0、提示词空），**照常出题但没有体裁指令**
 *   · `qtypes` 空  → 出题提示词里的题型段整段是空的，**AI 不知道该出什么题**
 *   · `prompt_presets` 空 → 分析预设没了
 *
 * 也就是说「恢复出厂」得到的状态**比全新安装还差**。
 * 而且老的「清空全部学习数据（勾了连设置一起清）」有同一个病，早就在了。
 *
 * ── 为什么做成「启动时自愈」而不是「清完补一下」 ──────────
 *
 * 补在清除那一步，只能治清除这一条路。而表变空的路不止一条：
 * 出厂重置、老的清空、从别人的备份导回、同步把删除同过来、手工改库。
 * **判据应该是「表空了」，不是「谁把它清空的」** ——
 * 前者不会漏，后者每加一条路就要记得补一次，而忘了的表现是静默降级。
 *
 * ── 和迁移里那份种子的关系 ────────────────────────────────
 *
 * 迁移里那几段**一个字都不能改**（D-216：已写好的 up() 从此冻结）。
 * 所以这里是**另一份**同样内容的种子，两者刻意重复：
 * 迁移那份是历史记录（回放老库用），这份是现行出厂内容。
 * 将来要改出厂导师/体裁，改这里 —— 迁移那份留着不动。
 */

const now = (): number => Date.now()

/**
 * ★★ R-4-G · 出厂内容播下去时，`updated_at` 写 **0**，不写 `now`。
 *
 * `updated_at` 的语义是「这一行最后一次发生**需要跨设备传播的本地变更**」。
 * 出厂那一刻不是变更 —— 两台设备各自播种同一份内容，没有任何东西要传给对方。
 * 写 `now` 的后果是两边时间戳不同，uid 归一之后反而变成「两边都改过」的冲突
 * （实测：第一次同步 22 处，而他一条都没碰过）。
 *
 * 他一改名 / 改内容 / 开关 / 软删，那些入口照常写 `now`，变更正常进同步。
 * `created_at` 仍然写真实时间 —— 它是「这一行什么时候进的库」，与同步无关。
 */
const PRISTINE = 0

/** 这张表还有几行（软删的不算） */
function alive(db: Database, table: string): number {
  const hasSoftDelete = (db.prepare(`pragma table_info("${table}")`).all() as { name: string }[]).some(
    (c) => c.name === 'deleted_at'
  )
  return (
    db
      .prepare(`select count(*) as n from "${table}"${hasSoftDelete ? ' where deleted_at is null' : ''}`)
      .get() as { n: number }
  ).n
}

export interface BuiltinResult {
  /** 补了哪几张表，各补了几行 */
  filled: Record<string, number>
}

/**
 * 四张出厂表，空了就补回来。
 *
 * **只在整张表空的时候补** —— 他删掉两个导师只留一个，那是他的选择，
 * 不该在下次启动时又冒出三个。判据是「一个都不剩」，不是「少于三个」。
 */
function fillTutors(db: Database, t: number): number {
    const ins = db.prepare(
      `insert into tutors (name, persona, strictness, task_density, answer_timing,
                           builtin, is_default, sort, uid, created_at, updated_at)
       values (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    )
    const rows: [string, string, number, number, string, number, number][] = [
      [
        '严谨学术型',
        'A tutor from the seminar tradition: precise, demanding about evidence, quick to name an unexamined assumption. Never flatters.',
        8,
        6,
        'after',
        1,
        1
      ],
      [
        '苏格拉底式',
        'Answers almost nothing directly. Responds with the question that would let the learner find it themselves. Patient, never condescending.',
        6,
        8,
        'hint',
        0,
        2
      ],
      [
        '轻松陪练型',
        'Warm and conversational. Corrects the things that matter and lets small slips go. Keeps the learner writing rather than worrying.',
        3,
        3,
        'direct',
        0,
        3
      ]
    ]
    db.transaction(() => {
      // 序位就是这个数组的次序 —— 和 V20 里「按 sort, id 排出来的名次」是同一件事
      rows.forEach((r, i) => ins.run(...r, canonicalUid('tutors', { builtin: 1, ordinal: i + 1 }), t, PRISTINE))
    })()
  return rows.length
}

function fillGenres(db: Database, t: number): number {
    const ins = db.prepare(
      `insert into genres (name, prompt, is_default, builtin, sort, uid, created_at, updated_at)
       values (?, ?, ?, 1, ?, ?, ?, ?)`
    )
    const rows: [string, string, number, number][] = [
      [
        '论说文',
        '按论说文的读法提问：论点是什么、靠什么支撑、哪一步推得最勉强、' +
          '作者预设了什么没说出口的前提。问题要能用一两句话回答，但答不出来就说明没读懂。',
        1,
        1
      ],
      [
        '叙事',
        '按叙事的读法提问：视角在谁身上、时间怎么走、哪些细节在暗示后面的事、' +
          '哪一处的语气和内容不一致。避免「你觉得怎么样」这种没有着落的问题。',
        0,
        2
      ],
      [
        '学术写作',
        '按学术写作的读法提问：研究问题、方法的限度、结论超出证据多少、' +
          '这一段在整篇论证里承担什么功能。术语要求他用自己的话复述。',
        0,
        3
      ],
      [
        '新闻评论',
        '按新闻评论的读法提问：事实与判断在哪里分界、立场靠哪些措辞传达、' +
          '同一件事换一个立场会怎么写。逼他分辨「报道」和「说服」。',
        0,
        4
      ]
    ]
    db.transaction(() => {
      rows.forEach((r, i) => ins.run(...r, canonicalUid('genres', { builtin: 1, ordinal: i + 1 }), t, PRISTINE))
    })()
  return rows.length
}

function fillQtypes(db: Database, t: number): number {
    const ins = db.prepare(
      // ★ `tier` 列按 D-216 留着（not null 且无默认值）但没含义了（D-478），一律写 1
      `insert into qtypes (key, name, tier, brief, guide, prompt, enabled, canonical, builtin,
                           sort, uid, created_at, updated_at)
       values (?, ?, 1, ?, ?, '', 1, ?, 1, ?, ?, ?, ?)`
    )
    db.transaction(() => {
      let sort = 0
      // 题型的出厂内容在 core/qtypes.ts —— 那里是唯一定义，这里只负责落库
      for (const q of QTYPES) {
        // 题型认 key，不认序位 —— 它本来就有唯一索引，restoreBuiltin 也是按 key 判「同一条」
        const uid = canonicalUid('qtypes', { builtin: 1, key: q.id })
        ins.run(q.id, q.name, q.brief, q.guide, q.canonical ? 1 : 0, ++sort, uid, t, PRISTINE)
      }
    })()
  return QTYPES.length
}

function fillPresets(db: Database, t: number): number {
    const ins = db.prepare(
      `insert into prompt_presets (name, target, extra, builtin, sort, uid, created_at, updated_at)
       values (?, 'analyze-material', ?, 1, ?, ?, ?, ?)`
    )
    const rows: [string, string, number][] = [
      [
        '学术论文',
        'This is academic prose. Weight argumentative and hedging machinery heavily — ' +
          'concession, attribution, qualification, causal claims. Technical terms that only work ' +
          'in this one field should be layer A, however impressive they look.',
        1
      ],
      [
        '时评随笔',
        'This is commentary. Weight register and stance heavily — irony, understatement, ' +
          'and the verbs a columnist uses to signal judgement without stating it. ' +
          'Topical proper nouns are layer A.',
        2
      ],
      [
        '文学作品',
        'This is literary prose. Weight imagery, collocation and rhythm heavily. ' +
          'Be stricter than usual about reuse value: a phrase that only works in this scene ' +
          'is not worth production training, however beautiful.',
        3
      ]
    ]
    db.transaction(() => {
      rows.forEach((r, i) =>
        ins.run(...r, canonicalUid('prompt_presets', { builtin: 1, ordinal: i + 1 }), t, PRISTINE)
      )
    })()
  return rows.length
}

/**
 * 四张出厂表，一张一步。
 *
 * ★ R-1 · 拆成「步」是为了让启动那一层能**一步一步地包**：
 * 补题型时炸了，不该连带把「补导师」也吞掉，更不该让整个软件打不开。
 * 每一步各自成事务（见各 `fill*`），所以一步失败只回滚它自己。
 */
export const BUILTIN_STEPS: { table: string; fill: (db: Database, t: number) => number }[] = [
  { table: 'tutors', fill: fillTutors },
  { table: 'genres', fill: fillGenres },
  { table: 'qtypes', fill: fillQtypes },
  { table: 'prompt_presets', fill: fillPresets }
]

/**
 * 四张出厂表，空了就补回来。
 *
 * **只在整张表空的时候补** —— 他删掉两个导师只留一个，那是他的选择，
 * 不该在下次启动时又冒出三个。判据是「一个都不剩」，不是「少于三个」。
 *
 * `onError` 不传就照旧往外抛（单元测试要看得见异常）。
 * 传了就是启动路径：由调用方去分级 —— 是「这一步的毛病」还是「库已经不可信」。
 */
export function ensureBuiltins(
  db: Database,
  onError?: (table: string, err: unknown) => void
): BuiltinResult {
  const filled: Record<string, number> = {}
  const t = now()
  for (const s of BUILTIN_STEPS) {
    try {
      if (alive(db, s.table) !== 0) continue
      const n = s.fill(db, t)
      if (n > 0) filled[s.table] = n
    } catch (err) {
      if (!onError) throw err
      onError(s.table, err)
    }
  }
  return { filled }
}
