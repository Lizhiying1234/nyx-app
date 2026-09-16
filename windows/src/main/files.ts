import type { Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { callAi, extractJson } from './ai/client.ts'
import { resolveSlot } from './ai/config.ts'
import { fill, loadPrompt } from './ai/prompts.ts'
import { backfillQuotes } from './db/repo.ts'
import type { ChatMessage, FileDetail, FileRow, GenreRow, TutorRow } from '@shared/api.ts'

/** 拼多行提示词用。写成常量是因为工具链上反复丢转义层 */
const NL = String.fromCharCode(10)

const now = (): number => Date.now()

/**
 * 文件学习 · D-115 第二条阅读路径 + AI 导师 · D-098 / R-005
 *
 * 和 lecture 那条路的区别：那边是**整篇交给 AI 拆**，这边是**你自己读、边读边捞**。
 * 终点同为 lecture（D-115），但前期用途不同。
 */
export class Files {
  constructor(
    private db: Database,
    private promptsDir: string
  ) {}

  // ── 文件 ────────────────────────────────────────────────────

  list(): FileRow[] {
    return this.db
      .prepare(
        `select f.id, f.title, f.status, f.progress, f.lecture_id as lectureId,
                f.converted_lecture_id as convertedLectureId,
                length(f.content) as chars, f.created_at as createdAt,
                l.name as lectureName,
                (select count(*) from chat_messages c where c.file_id = f.id) as messages
           from files f left join lectures l on l.id = f.lecture_id
          where f.deleted_at is null
          order by case f.status when 'reading' then 0 when 'unread' then 1 else 2 end, f.id desc`
      )
      .all() as FileRow[]
  }

  add(title: string, content: string, lectureId: number | null): number {
    if (!content.trim()) throw new Error('文章是空的，没有可读的内容。')
    const t = now()
    const id = Number(
      this.db
        .prepare(
          `insert into files (title, content, lecture_id, created_at, updated_at)
           values (?, ?, ?, ?, ?)`
        )
        .run(title.trim() || '未命名文章', content, lectureId, t, t).lastInsertRowid
    )
    // ★ I-114 · 文章正文也算这一讲的原文（见 originalTextsOf），到了就回头补出处
    if (lectureId) backfillQuotes(this.db, lectureId)
    return id
  }

  detail(fileId: number): FileDetail {
    const f = this.db
      .prepare(
        `select f.id, f.title, f.content, f.status, f.progress, f.lecture_id as lectureId,
                f.converted_lecture_id as convertedLectureId, l.name as lectureName
           from files f left join lectures l on l.id = f.lecture_id
          where f.id = ? and f.deleted_at is null`
      )
      .get(fileId) as FileDetail['file'] | undefined
    if (!f) throw new Error(`找不到这篇文章（id=${fileId}）`)

    const messages = this.db
      .prepare(
        `select id, role, content, kind, task_state as taskState, para,
                tutor_name as tutorName, created_at as at,
                mode, quest_no as questNo
           from chat_messages where file_id = ? order by id`
      )
      .all(fileId) as ChatMessage[]

    // Findings · D-168 第二个 Tab：从这篇文章捞到的条目，内部再分主动/被动
    const findings = f.lectureId
      ? (this.db
          .prepare(
            `select i.id, i.term, i.gloss, i.layer from items i
               join item_lectures il on il.item_id = i.id and il.deleted_at is null
              where il.lecture_id = ? and i.deleted_at is null order by i.id`
          )
          .all(f.lectureId) as FileDetail['findings'])
      : []

    return { file: f, messages, findings }
  }

  /**
   * 就地分析这一篇 · I-039
   *
   * 使用者：「Findings 中也没有分析的选项，也没有分析仅限于这个文章的范围，
   *          甚至根本没有分析。」
   *
   * 做法不是另起一条分析管线，而是**把这篇文章作为一份材料挂进它的 lecture**，
   * 然后走原来那条（D-072 / I-043 都在里面）。理由：
   *   · 只有一条管线，判层、去重、出处、完整解析的规则不会分叉
   *   · 「仅限这篇」是天然的 —— 它是一份独立材料，材料级独立分析（D-063 修订）
   *   · 捞到的条目照常进主动/被动，Findings 只是同一份数据的另一个视图
   *
   * 返回材料 id；真正的分析由调用方接着跑（那一步要 AI，属于主进程编排）。
   */
  stageForAnalysis(fileId: number): { lectureId: number; materialId: number } {
    const f = this.db
      .prepare(
        `select id, title, content, lecture_id as lectureId from files
          where id = ? and deleted_at is null`
      )
      .get(fileId) as { id: number; title: string; content: string; lectureId: number | null } | undefined
    if (!f) throw new Error(`找不到这篇文章（id=${fileId}）`)
    if (!f.lectureId) {
      throw new Error('这篇还没设路径 —— 先选一个 Lecture，捞到的条目才有地方去（D-110）。')
    }

    // 已经挂过就不重复挂，直接复用（重挂会把同一篇分析两遍，白花钱）
    const had = this.db
      .prepare(
        `select id, analyzed_at as analyzedAt from materials
          where lecture_id = ? and kind = 'original' and title = ? and deleted_at is null
          order by id desc limit 1`
      )
      .get(f.lectureId, f.title) as { id: number; analyzedAt: number | null } | undefined

    if (had) {
      if (had.analyzedAt) {
        // 重新分析：把 analyzed_at 清掉，让管线重新收下它
        this.db
          .prepare(`update materials set analyzed_at = null, updated_at = ? where id = ?`)
          .run(now(), had.id)
      }
      return { lectureId: f.lectureId, materialId: had.id }
    }

    const t = now()
    const r = this.db
      .prepare(
        `insert into materials (lecture_id, kind, title, origin, content, char_count, created_at, updated_at)
         values (?, 'original', ?, 'file', ?, ?, ?, ?)`
      )
      .run(f.lectureId, f.title, f.content, f.content.length, t, t)
    backfillQuotes(this.db, f.lectureId) // ★ I-114
    return { lectureId: f.lectureId, materialId: Number(r.lastInsertRowid) }
  }

  /** D-110 / D-198 · 没路径的话，这篇文章捞到的条目无处可去。 */
  setPath(fileId: number, lectureId: number): void {
    const t = now()
    this.db
      .prepare(`update files set lecture_id = ?, updated_at = ? where id = ?`)
      .run(lectureId, t, fileId)
    // ★ I-114 · 挂上来的这一刻，这一讲才第一次有了这篇正文
    backfillQuotes(this.db, lectureId)
  }

  /**
   * 删一篇文章（使用者 2026-08-10）。
   *
   * 软删，进垃圾箱（`TrashKind` 里本来就有 `file`，只是一直没有入口）。
   * 聊天记录跟着这篇走，不单独删 —— 恢复的时候还要用。
   */
  remove(fileId: number): void {
    const t = now()
    this.db.prepare(`update files set deleted_at = ?, updated_at = ? where id = ?`).run(t, t, fileId)
  }

  /** D-167 ·「读完」由使用者手动标记，软件不替他判断。 */
  setStatus(fileId: number, status: 'unread' | 'reading' | 'shelved' | 'done'): void {
    const t = now()
    this.db.prepare(`update files set status = ?, updated_at = ? where id = ?`).run(status, t, fileId)
  }

  /**
   * 转为 lecture · D-172
   * 「转后**两边都留**，文件学习里保留原记录并标『已转为 L4』。**不做主动提示。**」
   * 理由：转完就消失会让人不敢点。两边留着也不重复 ——
   * 文件学习记的是「我读过这篇」，lecture 是「我在系统学它」。
   */
  convert(fileId: number, lectureId: number): void {
    const t = now()
    this.db
      .prepare(
        `update files set converted_lecture_id = ?, lecture_id = coalesce(lecture_id, ?), updated_at = ?
          where id = ?`
      )
      .run(lectureId, lectureId, t, fileId)
  }

  // ── AI 导师 · D-098 / R-005 ─────────────────────────────────

  tutors(): TutorRow[] {
    return this.db
      .prepare(
        `select id, name, persona, strictness, task_density as taskDensity,
                answer_timing as answerTiming, free_prompt as freePrompt,
                is_default as isDefault, builtin
           from tutors where deleted_at is null order by sort, id`
      )
      .all()
      .map((r) => {
        const x = r as Omit<TutorRow, 'isDefault' | 'builtin'> & { isDefault: number; builtin: number }
        return { ...x, isDefault: x.isDefault !== 0, builtin: x.builtin !== 0 }
      })
  }

  // ── 体裁 · 使用者 5.2 ──────────────────────────────────────
  //
  // 「体裁可像导师一样：新增、编辑、设置提示词。」
  // 分工：**导师决定口吻**（Enlighten 用），**体裁决定出什么问题**（Quest 用）。

  genres(): GenreRow[] {
    return (
      this.db
        .prepare(
          `select uid, name, prompt, is_default as isDefault, builtin, sort
             from genres where deleted_at is null order by sort, uid`
        )
        .all() as (Omit<GenreRow, 'isDefault' | 'builtin'> & {
        isDefault: number
        builtin: number
      })[]
    ).map((x) => ({ ...x, isDefault: x.isDefault !== 0, builtin: x.builtin !== 0 }))
  }

  saveGenre(g: Partial<GenreRow> & { name: string }): string {
    const t = now()
    if (g.uid) {
      this.db
        .prepare(`update genres set name = ?, prompt = ?, updated_at = ? where uid = ?`)
        .run(g.name.trim() || '未命名体裁', g.prompt ?? '', t, g.uid)
      return g.uid
    }
    const max = (
      this.db.prepare(`select coalesce(max(sort), 0) as n from genres`).get() as { n: number }
    ).n
    /**
     * ★ uid 现在是主键，插入时**必须自己给**（R-3-h / V27）。
     *   老写法靠 after-insert 触发器补 uid —— 那个触发器已经删掉了：
     *   留着它只会让人以为「不给 uid 也没事」，而那正是这次事故的土壤。
     */
    const uid = `genres-${randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.db
      .prepare(
        `insert into genres (uid, name, prompt, sort, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`
      )
      .run(uid, g.name.trim() || '未命名体裁', g.prompt ?? '', max + 1, t, t)
    return uid
  }

  deleteGenre(uid: string): void {
    const t = now()
    const left = (
      this.db.prepare(`select count(*) as n from genres where deleted_at is null`).get() as {
        n: number
      }
    ).n
    // 和导师同一条规矩：删光了 Quest 就没法出题了
    if (left <= 1) throw new Error('至少要留一种体裁 —— 删光了 Quest 就出不了题。')
    this.db.prepare(`update genres set deleted_at = ?, updated_at = ? where uid = ?`).run(t, t, uid)
    const stillDefault = this.db
      .prepare(`select 1 as x from genres where deleted_at is null and is_default = 1`)
      .get()
    if (!stillDefault) {
      this.db.prepare(
        `update genres set is_default = 1, updated_at = ?
          where uid = (select uid from genres where deleted_at is null order by sort, uid limit 1)`
      ).run(t)
    }
  }

  private genreOf(uid: string | null): GenreRow {
    const list = this.genres()
    if (list.length === 0) {
      // 理论上不会发生（迁移里铺了四种，删也删不到 0），但真发生了要给条能用的默认
      return { uid: '', name: '论说文', prompt: '', isDefault: true, builtin: true, sort: 0 }
    }
    return list.find((g) => g.uid === uid) ?? list.find((g) => g.isDefault) ?? list[0]
  }

  saveTutor(t0: Partial<TutorRow> & { name: string }): number {
    const t = now()
    if (t0.id) {
      this.db
        .prepare(
          `update tutors set name = ?, persona = ?, strictness = ?, task_density = ?,
                             answer_timing = ?, free_prompt = ?, updated_at = ?
            where id = ?`
        )
        .run(
          t0.name.trim() || '未命名导师',
          t0.persona ?? '',
          t0.strictness ?? 7,
          t0.taskDensity ?? 5,
          t0.answerTiming ?? 'after',
          t0.freePrompt ?? '',
          t,
          t0.id
        )
      return t0.id
    }
    const max = (
      this.db.prepare(`select coalesce(max(sort), 0) as n from tutors`).get() as { n: number }
    ).n
    return Number(
      this.db
        .prepare(
          `insert into tutors (name, persona, strictness, task_density, answer_timing,
                               free_prompt, sort, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          t0.name.trim() || '未命名导师',
          t0.persona ?? '',
          t0.strictness ?? 7,
          t0.taskDensity ?? 5,
          t0.answerTiming ?? 'after',
          t0.freePrompt ?? '',
          max + 1,
          t,
          t
        ).lastInsertRowid
    )
  }

  deleteTutor(id: number): void {
    const t = now()
    const left = (
      this.db.prepare(`select count(*) as n from tutors where deleted_at is null`).get() as {
        n: number
      }
    ).n
    if (left <= 1) throw new Error('至少要留一个导师 —— 删光了对话就没人应答了。')
    this.db.prepare(`update tutors set deleted_at = ?, updated_at = ? where id = ?`).run(t, t, id)
    // 删掉的正好是默认的话，把默认让给剩下的第一个
    const hasDefault = (
      this.db
        .prepare(`select count(*) as n from tutors where deleted_at is null and is_default = 1`)
        .get() as { n: number }
    ).n
    if (hasDefault === 0) {
      const first = this.db
        .prepare(`select id from tutors where deleted_at is null order by sort, id limit 1`)
        .get() as { id: number } | undefined
      if (first) this.setDefaultTutor(first.id)
    }
  }

  setDefaultTutor(id: number): void {
    const t = now()
    const tx = this.db.transaction(() => {
      this.db.prepare(`update tutors set is_default = 0, updated_at = ?`).run(t)
      this.db.prepare(`update tutors set is_default = 1, updated_at = ? where id = ?`).run(t, id)
    })
    tx()
  }

  private tutorOf(id: number | null): TutorRow {
    const list = this.tutors()
    if (list.length === 0) throw new Error('一个导师都没有 —— 去设置页建一个。')
    return list.find((x) => x.id === id) ?? list.find((x) => x.isDefault) ?? list[0]!
  }

  // ── 对话 · R-004 右栏必须读到左栏的文章 ─────────────────────

  /**
   * 「文件学习中的 ai 聊天那里也没有读取左侧的文件，问它什么也不知道，还要我自己贴」
   *
   * 所以：**每一轮都把整篇文章送进上下文**。走「长上下文」那一组（D-202）——
   * 它存在的理由就是这个：需要长窗口，与另外两组的取舍不同。
   */
  async chat(
    fileId: number,
    text: string,
    tutorId: number | null,
    /**
     * ★ 使用者 5.2 · 两个互斥的模式，取代原来的「带练 / 只答疑」。
     *
     *   · **Enlighten（理解）** —— 选导师。只做理解引导，**一道题都不出**
     *   · **Quest（思考）**     —— 选体裁。按体裁出问题，让他回答
     *
     * 这不是换个名字。原来的 tutor / ask 是「要不要顺带派活」的开关，
     * 主线仍然是问答；现在这两个是**两件不同的事**：
     * 一个把文章讲开，一个逼他自己想。所以互斥 —— 同时开着等于两件事都做不专。
     */
    mode: 'enlighten' | 'quest' = 'enlighten',
    /** Quest 用哪一种体裁出题。Enlighten 模式下忽略 */
    genreUid: string | null = null,
    /**
     * ★ 他点了「下一个问题」。
     *
     * 使用者：「用户没有点击『下一个问题』之前，一直停留在当前问题卡片，
     *          可以持续与 AI 讨论、理解、追问这一个问题，
     *          AI 只围绕当前问题进行解答和引导。」
     *
     * 所以 Quest 有两种回合，**必须由这个参数分开**，不能让模型自己拿捏：
     *   · `true`  —— 出下一张卡（quest_no + 1）
     *   · `false` —— 就这一张卡追问；上下文只喂这张卡的线程，并明说不许出新题
     */
    questNext = false,
    signal?: AbortSignal
  ): Promise<ChatMessage[]> {
    const f = this.db
      .prepare(`select content, status from files where id = ? and deleted_at is null`)
      .get(fileId) as { content: string; status: string } | undefined
    if (!f) throw new Error(`找不到这篇文章（id=${fileId}）`)

    const tutor = this.tutorOf(tutorId)
    const genre = this.genreOf(genreUid)
    const t = now()

    /**
     * 这一轮属于第几张问题卡。
     *
     * Quest 是「一张卡一条线程」：点了「下一个问题」才 +1，
     * 否则一直挂在当前这张上 —— 这正是「停留在当前问题卡片」的落点。
     */
    const lastNo = (
      this.db
        .prepare(
          `select coalesce(max(quest_no), 0) as n from chat_messages
            where file_id = ? and mode = 'quest'`
        )
        .get(fileId) as { n: number }
    ).n
    const questNo = mode === 'quest' ? (questNext || lastNo === 0 ? lastNo + 1 : lastNo) : null
    /** 这一轮该出新题吗 */
    const askNew = mode === 'quest' && questNo !== null && questNo > lastNo

    // 使用者这一条先落库 —— 就算 AI 那边失败了，他写的东西也不能丢（D-205 失败不吞数据）
    // 点「下一个问题」时他没打字，这一条就不写（空气泡很难看，也不是他说的话）
    if (text.trim()) {
      this.db
        .prepare(
          `insert into chat_messages (file_id, role, content, mode, quest_no, created_at, updated_at)
           values (?, 'user', ?, ?, ?, ?, ?)`
        )
        .run(fileId, text, mode, questNo, t, t)
    }
    if (f.status === 'unread') this.setStatus(fileId, 'reading')

    /**
     * D-099 / D-189 · 超过 40 轮开始压缩，最近 15 轮保留原文。
     * 这里先做「只喂最近 15 轮」那一半；压缩摘要等对话真的长起来再说。
     *
     * ★ 两处收窄，都是为了做到「AI 只围绕当前问题」：
     *   · 只喂**同一个模式**的历史 —— 否则切到 Quest 它会顺着讲解继续讲
     *   · Quest 追问时只喂**这一张卡**的线程 —— 否则它会接着上一题往下说，
     *     而他明明还在问这一题。这条光靠提示词说是压不住的。
     */
    const recent = (
      mode === 'quest' && !askNew
        ? this.db
            .prepare(
              `select role, content, kind from chat_messages
                where file_id = ? and mode = 'quest' and quest_no = ?
                order by id desc limit 15`
            )
            .all(fileId, questNo)
        : this.db
            .prepare(
              `select role, content, kind from chat_messages
                where file_id = ? and mode = ? order by id desc limit 15`
            )
            .all(fileId, mode)
    ).reverse() as { role: string; content: string; kind: string }[]

    /** 当前这张卡的题面 —— 追问时原样贴给它看，它才知道「当前问题」是哪一句 */
    const curCard = (
      mode === 'quest' && !askNew
        ? (this.db
            .prepare(
              `select content from chat_messages
                where file_id = ? and mode = 'quest' and quest_no = ? and kind = 'task'
                order by id limit 1`
            )
            .get(fileId, questNo) as { content: string } | undefined)
        : undefined
    )?.content

    const history = recent
      .map((m) => `${m.role === 'user' ? 'Learner' : 'Tutor'}: ${m.content}`)
      .join('\n\n')

    const p = loadPrompt(this.promptsDir, 'tutor-chat')
    const TIMING: Record<string, string> = {
      direct: 'direct — answer, then explain',
      after: 'after — make them attempt it first',
      hint: 'hint — never hand it over'
    }

    // 提示词说了不给任务，但模型未必听话。**这一层再兜一次** ——
    // 使用者说「别派活」就是别派活，不能靠模型自觉（I-039）
    const raw = await callAi(
      resolveSlot(this.db, 'long'), // D-202 · 长上下文那一组，整篇文章要塞进去
      {
        system: fill(p.system, {
          PERSONA: tutor.persona,
          STRICTNESS: String(tutor.strictness),
          // Quest 模式下「任务密度」这个概念不成立 —— 出题本来就是它要做的事
          DENSITY: mode === 'quest' ? '10' : String(tutor.taskDensity),
          TIMING: TIMING[tutor.answerTiming] ?? tutor.answerTiming,
          MODE:
            mode === 'quest'
              ? askNew
                ? [
                    '## MODE: QUEST（思考）· 出下一张问题卡',
                    '',
                    '体裁：**' + genre.name + '**',
                    genre.prompt.trim(),
                    '',
                    '这一轮**只出问题**：按上面这一体裁的读法提**一个**问题，放进 `task`。',
                    '`say` 里只写一两句把他引到那个问题上，**不要先把答案讲了**。',
                    '前面已经问过的不要重复 —— 换一个角度，或者往后一段。'
                  ].join(NL)
                : [
                    '## MODE: QUEST（思考）· 就当前这一题往下谈',
                    '',
                    '当前这一题是：',
                    '',
                    (curCard ?? '（题面丢了，就按他上一句里说的那个问题算）')
                      .split(NL)
                      .map((x) => '> ' + x)
                      .join(NL),
                    '',
                    '**不要出新题** —— `task` 必须是 null。他还没说「下一个问题」。',
                    '他现在是在跟你讨论上面这一题：可能是在答、在追问、在要提示。',
                    '你要做的是**围着这一题**回应 —— 判断他答得怎么样、把他没想到的那一层点出来、',
                    '或者给一步提示让他自己往下走。**不要把话题带到别的段落或别的问题上。**'
                  ].join(NL)
              : [
                  '## MODE: ENLIGHTEN（理解）',
                  '',
                  '这一轮**只做理解引导**：把他问的地方讲开、讲透。',
                  '**一道题都不要出** —— `task` 必须是 null。',
                  '他现在要的是读懂，不是被考。',
                  '',
                  '### 回答的样子',
                  '',
                  '按这个次序写，**不要写小标题**，段与段之间空一行：',
                  '',
                  '1. **先直接答他问的那一句** —— 一到两句，不要绕。',
                  '2. **再说凭什么** —— 回到原文，引一小段（原样，不要翻译整句），',
                  '   指出是哪个词、哪个结构支撑了上面那个判断。',
                  '3. **最后一句「顺带一提」** —— 一个他没问但正好挨着的点：',
                  '   一个近义表达的差别、一个容易读反的地方、一处作者的手法。',  // copy:prompt
                  '',
                  '整段控制在 150 词以内。讲不完就讲最要紧的那一层，',
                  '**不要为了凑齐三段而注水** —— 他要的是读懂，不是读一篇小论文。'
                ].join(NL),
          FREE: tutor.freePrompt.trim()
            ? `### Also, from the learner\n\n${tutor.freePrompt.trim()}`
            : ''
        }),
        user: fill(p.user, { DOC: f.content, HISTORY: history }),
        json: true,
        maxTokens: 2000,
        signal
      },
      'long'
    )

    const j = extractJson<{ say?: string; task?: { title?: string; body?: string; para?: number } }>(
      raw
    )
    const t2 = now()

    if (j.say?.trim()) {
      this.db
        .prepare(
          `insert into chat_messages (file_id, role, content, mode, quest_no, tutor_name, created_at, updated_at)
           values (?, 'ai', ?, ?, ?, ?, ?, ?)`
        )
        .run(fileId, j.say.trim(), mode, questNo, tutor.name, t2, t2)
    }
    /**
     * D-081 · 任务做成任务卡，有未完成 / 已完成状态。
     *
     * 两处兜底，都不能指望模型自觉：
     *   · Enlighten 模式下**一个都不给**（I-039 / 5.2）
     *   · Quest 追问回合（`askNew === false`）也不给 —— 他还没点「下一个问题」，
     *     这时候冒出一张新卡，等于软件替他翻页。上面提示词说了，这里再兜一次。
     */
    if (mode === 'quest' && askNew && j.task?.body?.trim()) {
      this.db
        .prepare(
          `insert into chat_messages (file_id, role, content, kind, task_state, para, mode, quest_no, tutor_name, created_at, updated_at)
           values (?, 'ai', ?, 'task', 'open', ?, 'quest', ?, ?, ?, ?)`
        )
        .run(
          fileId,
          `${j.task.title ?? '任务'}\n${j.task.body.trim()}`,
          j.task.para ?? null,
          questNo,
          tutor.name,
          t2 + 1,
          t2 + 1
        )
    }

    return this.detail(fileId).messages
  }

  /**
   * 历史接口，界面已不再调用。
   *
   * 问题卡的「做完了 / 跳过」撤掉了（使用者：「看起来没什么意义」）——
   * 那两个按钮要他自己判断这一题算不算过，而 Quest 的全部意义就是他答、AI 判；
   * 自评既不进判分也不影响出下一题。
   *
   * 方法留着是因为 `task_state` 这一列还在（D-216 只增不删），
   * 将来真要做「已答过」标记时，写入口在这里，不必再找一遍。
   * @deprecated 没有调用方；加回按钮之前不要用它
   */
  setTaskState(messageId: number, state: 'open' | 'done' | 'skipped'): void {
    const t = now()
    this.db
      .prepare(`update chat_messages set task_state = ?, updated_at = ? where id = ?`)
      .run(state, t, messageId)
  }
}
