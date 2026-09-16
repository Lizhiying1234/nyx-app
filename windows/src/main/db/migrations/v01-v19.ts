/**
 * V1 ～ V19 · 建库与早期结构（2026 年初～ V19） · T-4.6 拆分（2026-09-06）
 *
 * ★ **正文一个字符没改**（D-216 第 4 条：写好的 up() 从此不许动；
 *   D-461：改了就要重生成 schema/vNN.sql 与同步基线）。
 *   搬动只换了外壳：`MIGRATIONS.push({` → `export const vNN: Migration = {`，
 *   收尾的 `})` → `}`。两者都在第 0 列、正文都在第 2 列，所以一行都没重新缩进。
 * ★ 顺序由本文件末尾那个数组固定，再由 migrations.ts 按段拼起来。
 */

import { findQuoteIn } from '@core/quote.ts'
import { SYNC_TABLES } from '@core/sync-tables.ts'
import type { Migration } from './types.ts'

/** V1 —— 拆分前它是数组字面量里的第一个元素，这里连缩进都保持原样 */
const v1s: Migration[] = [
  {
    version: 1,
    name: '设置表与迁移日志',
    up(db) {
      // 键值设置。API key 不存这里（D-220：走系统凭据，不明文进库）。
      db.exec(`
        create table if not exists settings (
          key         text primary key,
          value       text not null,
          updated_at  integer not null
        );
      `)

      // 每次迁移留痕，出问题时能看出升级到底做过什么。
      db.exec(`
        create table if not exists migration_log (
          id           integer primary key autoincrement,
          from_version integer not null,
          to_version   integer not null,
          name         text    not null,
          ran_at       integer not null,
          ok           integer not null,
          note         text,
          updated_at   integer not null
        );
      `)
    }
  }
]

export const v2: Migration = {
  version: 2,
  name: '业务结构：三层 · 材料 · 知识点 · 两条线 · 作答与日志',
  up(db) {
    // ── 三层结构 · D-074 ────────────────────────────────────────
    // 删除一律软删（deleted_at），落实 D-216 只增不删 + D-087 垃圾箱 30 天。
    db.exec(`
      create table if not exists projects (
        id         integer primary key autoincrement,
        name       text    not null,
        color      text    not null default '#6d5efc',
        pinned     integer not null default 0,
        silent     integer not null default 0,
        sort       integer not null default 0,
        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      );

      create table if not exists units (
        id         integer primary key autoincrement,
        project_id integer not null references projects(id),
        name       text    not null,
        sort       integer not null default 0,
        silent     integer not null default 0,
        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      );

      -- status · F-03：分析完先停在 review（待审阅），点「这批我看过了」才进轮转。
      -- 它同时回答了「首次到期日落在哪一天」——审阅之后的第二天。
      create table if not exists lectures (
        id            integer primary key autoincrement,
        unit_id       integer not null references units(id),
        name          text    not null,
        number        integer not null default 1,
        status        text    not null default 'empty',
        interval_days integer not null default 0,
        due_at        integer,
        silent        integer not null default 0,
        sort          integer not null default 0,
        deleted_at    integer,
        created_at    integer not null,
        updated_at    integer not null
      );
      create index if not exists idx_units_project  on units(project_id);
      create index if not exists idx_lectures_unit  on lectures(unit_id);
      create index if not exists idx_lectures_due   on lectures(due_at) where deleted_at is null;
    `)

    // ── 材料 · D-062 / D-063 / R-001 ────────────────────────────
    // kind 区分「原文材料」与「我自己整理的 chunk」——这是两条完全不同的处理路径：
    // 原文交给 AI 全权扫描；chunk 原样入库、不拆不去重不改写、不出产出题（D-006 / M-015）。
    db.exec(`
      create table if not exists materials (
        id          integer primary key autoincrement,
        lecture_id  integer not null references lectures(id),
        kind        text    not null,
        title       text    not null,
        origin      text    not null default 'paste',
        source_ref  text,
        content     text    not null,
        char_count  integer not null default 0,
        analyzed_at integer,
        deleted_at  integer,
        created_at  integer not null,
        updated_at  integer not null
      );
      create index if not exists idx_materials_lecture on materials(lecture_id);
    `)

    // ── 知识点 · 全局唯一，两条线的进度都挂在它身上 ──────────────
    // layer   A=被动词汇（只走认读线）· B=主动词汇（两条线都走）· D-023
    // kind    五分类降为属性 · D-069
    // source  ai / self / both（双方共识 · D-044）
    db.exec(`
      create table if not exists items (
        id                integer primary key autoincrement,
        term              text    not null,
        gloss             text    not null default '',
        gloss_zh          text    not null default '',
        layer             text    not null default 'A',
        kind              text    not null default 'chunk',
        source            text    not null default 'ai',
        owner_lecture_id  integer references lectures(id),
        confidence        real    not null default 1.0,
        recollected_count integer not null default 0,
        derived_from      integer references items(id),

        -- 产出线 · D-084 / grading.ts
        production_state   text    not null default 'new',
        streak             integer not null default 0,
        attempts           integer not null default 0,
        attempts_in_stage  integer not null default 0,
        corrects           integer not null default 0,
        hard_entries       integer not null default 0,

        -- 认读线 · D-017 / sm2-item.ts
        card_ease     real    not null default 2.5,
        card_interval integer not null default 0,
        card_reps     integer not null default 0,
        card_lapses   integer not null default 0,
        card_due_at   integer,
        card_silent   integer not null default 0,

        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_items_owner on items(owner_lecture_id);
      create index if not exists idx_items_term  on items(term);
      create index if not exists idx_items_card_due on items(card_due_at) where deleted_at is null;
    `)

    // 条目全局唯一，但可被多个 lecture 引用 · D-089
    // 「向使用者隐瞒『这个表达三个月前学过、今天又碰到』是浪费一个有价值的事实。」
    db.exec(`
      create table if not exists item_lectures (
        item_id    integer not null references items(id),
        lecture_id integer not null references lectures(id),
        is_owner   integer not null default 0,
        created_at integer not null,
        updated_at integer not null,
        primary key (item_id, lecture_id)
      );
    `)

    // ── 原文出处 · D-057 / D-152 / M-012 / M-013 ★★ ─────────────
    // 「一条知识点如果不知道自己出自哪句话，它就退化成了一张单词卡。」
    // 单独一张表而不是 items 上的一个字段，因为同一表达在多篇材料里出现时
    // **每一次的原句都要存下来**——不同语境下的用法差异本身就是学习材料，
    // 而且这些句子是分析时顺手得到的，零成本。后补这张表要重跑全部分析。
    db.exec(`
      create table if not exists occurrences (
        id          integer primary key autoincrement,
        item_id     integer not null references items(id),
        material_id integer references materials(id),
        lecture_id  integer references lectures(id),
        quote       text    not null,
        para        integer,
        created_at  integer not null,
        updated_at  integer not null
      );
      create index if not exists idx_occ_item on occurrences(item_id);
    `)

    // ── 解析逐区块存 · D-257 / D-149 / D-190 ────────────────────
    // 整块 JSON 存不下「手动改过的区块，重新生成时不覆盖」这个语义。
    db.exec(`
      create table if not exists analysis_blocks (
        id          integer primary key autoincrement,
        item_id     integer not null references items(id),
        block       text    not null,
        content     text    not null,
        edited      integer not null default 0,
        regen_count integer not null default 0,
        created_at  integer not null,
        updated_at  integer not null,
        unique (item_id, block)
      );
    `)

    // ── 预生成题库 · D-129 ──────────────────────────────────────
    db.exec(`
      create table if not exists questions (
        id         integer primary key autoincrement,
        item_id    integer not null references items(id),
        tier       integer not null,
        type       text    not null,
        prompt     text    not null,
        context    text    not null default 'original',
        reference  text,
        used_at    integer,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_questions_item on questions(item_id, tier);
    `)

    // ── 练习会话与作答 · D-128 / D-121 / D-140 ──────────────────
    db.exec(`
      create table if not exists sessions (
        id          integer primary key autoincrement,
        kind        text    not null,
        scope       text    not null default '',
        target      integer not null default 0,
        started_at  integer not null,
        finished_at integer,
        created_at  integer not null,
        updated_at  integer not null
      );

      -- is_first 决定这一条算不算数：**只记第一次判定**（D-121 / M-019）。
      -- 改到过关的后续提交照样存（那是 D-140 演变线的素材），但不推进进度。
      create table if not exists answers (
        id          integer primary key autoincrement,
        session_id  integer references sessions(id),
        item_id     integer not null references items(id),
        question_id integer references questions(id),
        attempt_no  integer not null default 1,
        is_first    integer not null default 1,
        text        text    not null,
        grade       integer,
        annotations text,
        feedback    text,
        reference   text,
        hinted      integer not null default 0,
        created_at  integer not null,
        updated_at  integer not null
      );
      create index if not exists idx_answers_item on answers(item_id);

      -- F-04 · 没提交的作答也要留着。写了三行英文、软件关了，回来白写 ——
      -- 这是会让人当场不想再用的那种事。
      create table if not exists drafts (
        id          integer primary key autoincrement,
        session_id  integer not null references sessions(id),
        question_id integer not null references questions(id),
        text        text    not null,
        created_at  integer not null,
        updated_at  integer not null,
        unique (session_id, question_id)
      );
    `)

    // ── 日志 · D-017 / D-256 ────────────────────────────────────
    // review_logs 是**条目级**（将来切 FSRS 的训练数据），item_id NOT NULL。
    // lecture 级事件不属于它 —— 上一版把 lecture 排期塞进来并把 item_id 置 NULL，
    // 每练完一轮就抛异常（I-014）。所以 lecture_logs 单独一张表。
    db.exec(`
      create table if not exists review_logs (
        id              integer primary key autoincrement,
        item_id         integer not null references items(id),
        line            text    not null,
        grade           integer not null,
        interval_before integer,
        interval_after  integer,
        ease_after      real,
        duration_ms     integer,
        created_at      integer not null,
        updated_at      integer not null
      );
      create index if not exists idx_review_item on review_logs(item_id);

      create table if not exists lecture_logs (
        id         integer primary key autoincrement,
        lecture_id integer not null references lectures(id),
        event      text    not null,
        detail     text    not null default '',
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_lecture_logs on lecture_logs(lecture_id);
    `)

    // ── 分析任务 · D-072 断电恢复 / D-225 中途取消 ───────────────
    // 「已经花钱跑出来的结果不作废。」
    db.exec(`
      create table if not exists analysis_jobs (
        id          integer primary key autoincrement,
        lecture_id  integer not null references lectures(id),
        material_id integer references materials(id),
        stage       text    not null default 'queued',
        status      text    not null default 'running',
        error_kind  text,
        error_msg   text,
        found       integer not null default 0,
        created_at  integer not null,
        updated_at  integer not null
      );
      create index if not exists idx_jobs_lecture on analysis_jobs(lecture_id);
    `)
  }
}

export const v3: Migration = {
  version: 3,
  name: '分析预设：按材料给临时指令',
  up(db) {
    // 使用者的要求：「我根据不同材料，我自己决定」。
    //
    // 分工（不许打破）：
    //   prompts/*.md  = **基线**，记事本可改，管全局，仍是唯一真相来源（D-213）
    //   预设的 extra   = 在基线之上**追加**的一段话，管这一次分析
    //
    // 为什么是追加而不是整篇替换：那份 md 里写着 JSON 输出契约和判层规则，
    // 整篇替换很容易把契约写丢，然后表现成「分析成功但一条都没提取到」——
    // 又是一个说不清原因的失败。要改基线就去改文件，那才是它存在的意义。
    db.exec(`
      create table if not exists prompt_presets (
        id         integer primary key autoincrement,
        name       text    not null,
        target     text    not null default 'analyze-material',
        extra      text    not null default '',
        builtin    integer not null default 0,
        sort       integer not null default 0,
        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      );
    `)

    // 一个 lecture 通常就是一类材料，记住上次用的那个，不用每次重选
    db.exec(`alter table lectures add column preset_id integer`)
    // 每次分析用的是哪个预设 —— 结果不一样时要能回溯是不是因为换了指令
    db.exec(`alter table analysis_jobs add column preset_name text`)

    const t = Date.now()
    const seed = db.prepare(
      `insert into prompt_presets (name, target, extra, builtin, sort, created_at, updated_at)
       values (?, 'analyze-material', ?, 1, ?, ?, ?)`
    )
    // 三个起手预设。都可以改、可以删 —— 它们是例子，不是规定。
    seed.run(
      '学术论文',
      'This is academic prose. Weight argumentative and hedging machinery heavily — ' +
        'concession, attribution, qualification, causal claims. Technical terms that only work ' +
        'in this one field should be layer A, however impressive they look.',
      1,
      t,
      t
    )
    seed.run(
      '时评随笔',
      'This is commentary. Weight register and stance heavily — irony, understatement, ' +
        'and the verbs a columnist uses to signal judgement without stating it. ' +
        'Topical proper nouns are layer A.',
      2,
      t,
      t
    )
    seed.run(
      '文学作品',
      'This is literary prose. Weight imagery, collocation and rhythm heavily. ' +
        'Be stricter than usual about reuse value: a phrase that only works in this scene ' +
        'is not worth production training, however beautiful.',
      3,
      t,
      t
    )
  }
}

export const v4: Migration = {
  version: 4,
  name: '文件学习 · AI 导师 · 对话',
  up(db) {
    // ── 文件学习 · D-115 第二条阅读路径 ─────────────────────────
    // 「lecture 材料分析（扔进去让 AI 拆）与文件学习精读（自己读、边读边捞）**都保留**，
    //  终点同为 lecture，但前期用途不同。」
    db.exec(`
      create table if not exists files (
        id          integer primary key autoincrement,
        title       text    not null,
        content     text    not null,
        origin      text    not null default 'paste',
        source_ref  text,
        -- D-110 / D-198 · 先设路径，指向 lecture，决定捞到的条目归到哪。
        -- 没路径的话，这篇文章捞到的条目无处可去。
        lecture_id  integer references lectures(id),
        -- D-167 · 按状态分组：未读 / 在读 / 读完。「读完」由使用者手动标记
        status      text    not null default 'unread',
        progress    integer not null default 0,
        -- D-172 · 转 lecture 后**两边都留**，这边标「已转为 L4」。
        -- 转完就消失会让人不敢点
        converted_lecture_id integer references lectures(id),
        deleted_at  integer,
        created_at  integer not null,
        updated_at  integer not null
      );
      create index if not exists idx_files_status on files(status) where deleted_at is null;
    `)

    // ── AI 导师 · D-098 + R-005 多导师 ──────────────────────────
    // D-098 只定义了**单个**导师的四个可调项。使用者要能建多个、能切换，
    // 所以导师升格成一份**可命名的配置**。
    //
    // 「『严谨学术导师』这五个字 AI 会怎么理解谁也不知道，而且每次可能不一样。
    //  『纠错严厉度 8、写完才给答案』是确定的、可复现的。」——所以可调项是主体，
    //  自由提示词是补充，两者一起组装。
    db.exec(`
      create table if not exists tutors (
        id            integer primary key autoincrement,
        name          text    not null,
        persona       text    not null default '',
        strictness    integer not null default 7,
        task_density  integer not null default 5,
        answer_timing text    not null default 'after',
        free_prompt   text    not null default '',
        is_default    integer not null default 0,
        builtin       integer not null default 0,
        sort          integer not null default 0,
        deleted_at    integer,
        created_at    integer not null,
        updated_at    integer not null
      );
    `)

    // ── 对话 · D-099 一条连续流 + 自动分段 ──────────────────────
    // 「旧对话压缩为摘要后不再喂给 AI，但**原文永久保留可回看**。」
    // D-081 · 任务做成任务卡，有未完成/已完成状态，答复与点评挂在卡下。
    db.exec(`
      create table if not exists chat_messages (
        id         integer primary key autoincrement,
        file_id    integer references files(id),
        lecture_id integer references lectures(id),
        role       text    not null,
        content    text    not null,
        kind       text    not null default 'message',
        task_state text,
        -- D-174 · 任务可指向文档的具体段落，点任务左栏滚到该段并高亮
        para       integer,
        tutor_name text,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_chat_file on chat_messages(file_id);
    `)

    const t = Date.now()
    const seed = db.prepare(
      `insert into tutors (name, persona, strictness, task_density, answer_timing, builtin, is_default, sort, created_at, updated_at)
       values (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    )
    // R-005 · 预置两三个模板，可改可删 —— 它们是起点，不是规定
    seed.run(
      '严谨学术型',
      'A tutor from the seminar tradition: precise, demanding about evidence, quick to name an unexamined assumption. Never flatters.',
      8,
      6,
      'after',
      1,
      1,
      t,
      t
    )
    seed.run(
      '苏格拉底式',
      'Answers almost nothing directly. Responds with the question that would let the learner find it themselves. Patient, never condescending.',
      6,
      8,
      'hint',
      0,
      2,
      t,
      t
    )
    seed.run(
      '轻松陪练型',
      'Warm and conversational. Corrects the things that matter and lets small slips go. Keeps the learner writing rather than worrying.',
      3,
      3,
      'direct',
      0,
      3,
      t,
      t
    )
  }
}

export const v5: Migration = {
  version: 5,
  name: '状态迁移事件：报告的「知识流向」要靠它',
  up(db) {
    /**
     * D-043 · 「报告回答**我的知识在往哪流**，不是我做了多少题。做题量是过程，不是进步。
     *  六个模块里**知识流向是主角**：知识点在 `新增 → 训练中 → 攻坚 → 静默` 四态间的流动。」
     *
     * 光有当前状态画不出流动 —— 得知道**什么时候**从哪一态到了哪一态。
     * 这张表从现在起记下每一次迁移；不记的话，将来想画也补不回来
     * （和 D-017「日志自第一天起完整记录」同一个道理）。
     */
    db.exec(`
      create table if not exists state_events (
        id         integer primary key autoincrement,
        item_id    integer not null references items(id),
        line       text    not null default 'production',
        from_state text,
        to_state   text    not null,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_state_events_at on state_events(created_at);
      create index if not exists idx_state_events_item on state_events(item_id);
    `)

    // 已有条目补一条「出生」事件，否则它们在流向图上凭空出现
    const t = Date.now()
    db.prepare(
      `insert into state_events (item_id, line, from_state, to_state, created_at, updated_at)
       select id, 'production', null, 'new', created_at, ? from items where deleted_at is null`
    ).run(t)
  }
}

export const v6: Migration = {
  version: 6,
  name: '水平评估：认读 / 产出两个等级 + 能力画像',
  up(db) {
    /**
     * D-177 / D-181 · 「水平**不允许自填**，由 AI 评定。」
     *
     * 为什么不让使用者填（M-041）：**人对自己的产出能力普遍高估、对认读能力普遍低估**，
     * 而这套方法的整个立论就建立在这两者的差距上。让他自己填，
     * 等于用他最不可能估准的数去校准一台专门测量这个差距的仪器。
     *
     * D-181 · 「全部结果**永久保存**，形成跨年的能力曲线。」所以是一张流水表，不是一行设置。
     */
    db.exec(`
      create table if not exists assessments (
        id               integer primary key autoincrement,
        reading_level    text    not null,
        production_level text    not null,
        portrait         text    not null default '',
        compared         text    not null default '',
        -- data = 综合分析全部数据（D-177 主路径）· cold = 5 道诊断题冷启动（D-180）
        source           text    not null default 'data',
        evidence         text    not null default '{}',
        created_at       integer not null,
        updated_at       integer not null
      );
    `)

    /**
     * D-180 · 「**客观事实项**（考过什么试、几分、读英文多久）。」
     * 注意它和自评的区别：「我觉得我 B2」是自评，「我考过雅思 6.5」是事实。
     * 事实可以采信，自评不行。
     */
    db.exec(`
      create table if not exists profile_facts (
        id         integer primary key autoincrement,
        exams      text    not null default '',
        years      text    not null default '',
        goal       text    not null default '',
        sample     text    not null default '',
        created_at integer not null,
        updated_at integer not null
      );
    `)
  }
}

export const v7: Migration = {
  version: 7,
  name: '本地词典：识别到的书目、优先级、启用状态',
  up(db) {
    /**
     * D-151 · 「词典**纯本地**，使用者把文件放进指定目录，软件自动识别并排优先级。」
     * D-234 · 「设置页给一个列表 —— 识别到几本、**可拖动排序定优先级、可停用某一本**。」
     *
     * 为什么优先级要**落库**而不是每次按文件名排：使用者排好的顺序是他的偏好，
     * 重扫一次就打乱等于白排。`missing` 而不是删行 —— 移动硬盘拔了不是删词典。
     */
    db.exec(`
      create table if not exists dictionaries (
        id         integer primary key autoincrement,
        ifo_path   text    not null unique,
        folder     text    not null,
        bookname   text    not null,
        word_count integer not null default 0,
        enabled    integer not null default 1,
        sort_order integer not null default 0,
        missing    integer not null default 0,
        updated_at integer not null
      );
      create index if not exists idx_dict_order on dictionaries (sort_order);
    `)
  }
}

export const v8: Migration = {
  version: 8,
  name: 'AI 精选材料：按角度分组的推荐',
  up(db) {
    /**
     * ★★ 这个功能已经整个删掉了（2026-09-03，使用者要求）。
     *    **迁移是历史，不许改**：改了老库升级路径就断了。
     *    表也留着 —— 库只增不删（D-216），他那些老推荐不该被静默铲掉。
     *    下面是当年的判据，存照。
     *
     * D-077 · 项目级与 lecture 级两级都有 · D-171 · 按角度分组
     *
     * 为什么要落库：推荐一次要花一次重任务的钱，每次打开都重算太贵；
     * 而这类内容一周之内不会有意义地变化。存下来，使用者想刷新时自己点。
     */
    db.exec(`
      create table if not exists picks (
        id         integer primary key autoincrement,
        scope      text    not null,
        scope_id   integer not null,
        content    text    not null,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_picks_scope on picks (scope, scope_id, id desc);
    `)
  }
}

export const v9: Migration = {
  version: 9,
  name: '同步：给每张表加跨设备行号 uid',
  up(db) {
    /**
     * D-201 修订 · 增量行级同步的第二个前提。
     *
     * 第一个前提是 `updated_at`（每张表从建表起就有）。第二个是**行身份**：
     * 自增 id **不能**当同步身份 —— 两台机器各自新建一条，都会拿到同一个 id，
     * 同步时一方会把另一方的行整个盖掉，而且**不报错**。
     *
     * uid 一旦生成就不再改变。老数据按「表名-本机-id」回填，
     * 保证同一台机器上的老行在任何一次同步里都指向同一个东西。
     */
    const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    for (const t of SYNC_TABLES) {
      const cols = db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]
      if (cols.length === 0) continue // 表还不存在就跳过，不让整次升级挂掉
      if (cols.some((c) => c.name === 'uid')) continue

      db.exec(`alter table "${t}" add column uid text`)
      // item_lectures 是复合主键，没有 id —— 用它自己的两列拼。
      // 分隔符必须用**单引号**：SQLite 里 "-" 是标识符（当成列名），不是字符串。
      const key = cols.some((c) => c.name === 'id') ? 'id' : `item_id || '-' || lecture_id`
      db.exec(`update "${t}" set uid = '${t}-${seed}-' || (${key}) where uid is null`)
      db.exec(`create unique index if not exists idx_${t}_uid on "${t}" (uid)`)

      /**
       * 新插入的行也要有 uid。用**触发器**而不是去改几十处 insert ——
       * 漏掉一处的后果是「那张表的那些行永远同步不出去」，而且**不报错**。
       * 触发器管的是「所有插入」，包括以后新写的代码。
       */
      db.exec(`
        create trigger if not exists trg_${t}_uid after insert on "${t}"
          when new.uid is null
        begin
          update "${t}" set uid = '${t}-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;
      `)
    }
  }
}

export const v10: Migration = {
  version: 10,
  name: '条目事件：改字留痕 · 小操练问答',
  up(db) {
    /**
     * I-046 / I-060 · 「这条知识点身上发生过什么」。
     *
     * 为什么**不塞进 `state_events`**：那张表记的是**状态流转**
     * （line / from_state / to_state），分析报告的知识流向图完全靠它。
     * 往里塞改字记录和小操练问答，一来它没有 `to_state` 可填（NOT NULL），
     * 二来会把流向图算歪 —— 那张图回答的是「我的知识在往哪流」，
     * 混进「我做了几道小练习」就不是那个问题了。
     *
     * 所以另起一张：kind 区分事件类型，detail 存 JSON。
     */
    db.exec(`
      create table if not exists item_events (
        id         integer primary key autoincrement,
        item_id    integer not null references items(id),
        kind       text    not null,
        detail     text    not null default '',
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_item_events on item_events (item_id, id);
    `)

    /**
     * uid + 触发器要在这里自己补一遍 —— V9 那条给「当时已有的」同步表加了 uid，
     * 它跑在本条之前，管不到这张新表。
     * 漏了的后果：这张表永远同步不出去，而且**不报错**（D-201）。
     * 验收里那条「每张同步表都有 uid」当场就把它抓出来了。
     */
    db.exec(`alter table item_events add column uid text`)
    db.exec(`create unique index if not exists idx_item_events_uid on item_events (uid)`)
    db.exec(`
      create trigger if not exists trg_item_events_uid after insert on item_events
        when new.uid is null
      begin
        update item_events set uid = 'item_events-' || lower(hex(randomblob(8)))
         where rowid = new.rowid;
      end;
    `)
  }
}

export const v11: Migration = {
  version: 11,
  name: 'item-source-material',
  up(db) {
    db.exec(`alter table items add column source_material_id integer references materials(id)`)
    db.exec(
      `create index if not exists idx_items_source_material on items(source_material_id)`
    )
    /**
     * 老数据回填：按原来的推断方式补一次，这样升级之后行为不变。
     * 只补「自己收集的原句」（derived_from is null），析出项本来就不需要。
     */
    db.exec(`
      update items set source_material_id = (
        select o.material_id from occurrences o
         where o.item_id = items.id and o.material_id is not null
         order by o.id limit 1
      )
      where source_material_id is null and derived_from is null
    `)
  }
}

export const v12: Migration = {
  version: 12,
  name: 'behaviour-ledger',
  up(db) {
    db.exec(`
      create table if not exists term_ledger (
        id         integer primary key,
        uid        text,
        norm       text    not null,
        term       text    not null,
        verdict    text    not null,
        scope      text    not null default 'global',
        lecture_id integer references lectures(id),
        note       text,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_ledger_norm on term_ledger(norm);
      create unique index if not exists idx_ledger_one
        on term_ledger(norm, verdict, coalesce(lecture_id, 0));

      create table if not exists ops_log (
        id         integer primary key,
        uid        text,
        op         text    not null,
        target     text    not null,
        target_id  integer,
        title      text,
        detail     text,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_ops_at on ops_log(created_at);
      create index if not exists idx_ops_op on ops_log(op);
    `)

    /**
     * uid 的唯一索引和触发器要**在这里自己补**。
     *
     * 加 uid 的那次迁移编号在前（V9），它遍历 SYNC_TABLES 的时候这两张表还不存在，
     * 而迁移只跑一次、不会因为名单变长就重跑。漏了的后果是
     * **这两张表的行永远同步不出去，而且不报错** —— 正是那次注释里写的那种病。
     */
    for (const t of ['term_ledger', 'ops_log']) {
      db.exec(`update "${t}" set uid = '${t}-' || lower(hex(randomblob(8))) where uid is null`)
      db.exec(`create unique index if not exists idx_${t}_uid on "${t}" (uid)`)
      db.exec(`
        create trigger if not exists trg_${t}_uid after insert on "${t}"
          when new.uid is null
        begin
          update "${t}" set uid = '${t}-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;
      `)
    }
  }
}

export const v13: Migration = {
  version: 13,
  name: 'item-silenced-by',
  up(db) {
    db.exec(`alter table items add column silenced_by text`)
    db.exec(`create index if not exists idx_items_silenced_by on items(silenced_by)`)
    // 已经是 silent 的条目，都算「自己单独静默的」—— 升级前只有这一种
    db.exec(`update items set silenced_by = 'self' where production_state = 'silent'`)
  }
}

export const v14: Migration = {
  version: 14,
  name: 'genres',
  up(db) {
    db.exec(`
      create table if not exists genres (
        id         integer primary key autoincrement,
        uid        text,
        name       text    not null,
        prompt     text    not null default '',
        is_default integer not null default 0,
        builtin    integer not null default 0,
        sort       integer not null default 0,
        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_genres_sort on genres(sort);
    `)

    // uid 索引与触发器要自己补 —— 加 uid 那次迁移编号在前，跑不到这张表
    db.exec(`update genres set uid = 'genres-' || lower(hex(randomblob(8))) where uid is null`)
    db.exec(`create unique index if not exists idx_genres_uid on genres (uid)`)
    db.exec(`
      create trigger if not exists trg_genres_uid after insert on genres
        when new.uid is null
      begin
        update genres set uid = 'genres-' || lower(hex(randomblob(8))) where rowid = new.rowid;
      end;
    `)

    const t = Date.now()
    const seed = db.prepare(
      `insert into genres (name, prompt, is_default, builtin, sort, created_at, updated_at)
       values (?, ?, ?, 1, ?, ?, ?)`
    )
    const BUILTIN: [string, string][] = [
      [
        '论说文',
        '按论说文的读法提问：论点是什么、靠什么支撑、哪一步推得最勉强、' +
          '作者预设了什么没说出口的前提。问题要能用一两句话回答，但答不出来就说明没读懂。'
      ],
      [
        '叙事',
        '按叙事的读法提问：视角在谁身上、时间怎么走、哪些细节在暗示后面的事、' +
          '哪一处的语气和内容不一致。避免「你觉得怎么样」这种没有着落的问题。'
      ],
      [
        '学术写作',
        '按学术写作的读法提问：研究问题、方法的限度、结论超出证据多少、' +
          '这一段在整篇论证里承担什么功能。术语要求他用自己的话复述。'
      ],
      [
        '新闻评论',
        '按新闻评论的读法提问：事实与判断在哪里分界、立场靠哪些措辞传达、' +
          '同一件事换一个立场会怎么写。逼他分辨「报道」和「说服」。'
      ]
    ]
    BUILTIN.forEach(([name, prompt], i) => seed.run(name, prompt, i === 0 ? 1 : 0, i, t, t))
  }
}

export const v15: Migration = {
  version: 15,
  name: 'question-qtype-signature',
  up(db) {
    db.exec(`alter table questions add column qtype_sig text`)
    // 老题库当成「上一套勾选」出的 —— 留空即可，第一次进练习会自然重出
  }
}

export const v16: Migration = {
  version: 16,
  name: 'backfill-quotes',
  up(db) {
    // 迁移里不 import repo（那会把整个 Repo 拖进迁移的依赖里），
    // 逻辑同 repo.backfillQuotes —— 两边都只调 core 的 findQuoteIn，判据是同一条。
    const flat = (x: string): string => (x ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
    const lectures = db.prepare(`select id from lectures`).all() as { id: number }[]
    const t = Date.now()
    let n = 0
    for (const l of lectures) {
      const texts = [
        ...(
          db
            .prepare(
              `select content from materials
                where lecture_id = ? and kind = 'original' and deleted_at is null order by id`
            )
            .all(l.id) as { content: string }[]
        ).map((r) => r.content),
        ...(
          db
            .prepare(`select content from files where lecture_id = ? and deleted_at is null order by id`)
            .all(l.id) as { content: string }[]
        ).map((r) => r.content)
      ]
      if (!texts.some((x) => x?.trim())) continue

      const rows = db
        .prepare(
          `select o.id, o.quote, i.term
             from occurrences o join items i on i.id = o.item_id
            where o.lecture_id = ?`
        )
        .all(l.id) as { id: number; quote: string; term: string }[]

      for (const r of rows) {
        if (flat(r.quote) !== flat(r.term)) continue
        const q = findQuoteIn(texts, r.term)
        if (!q || flat(q) === flat(r.term)) continue
        db.prepare(`update occurrences set quote = ?, updated_at = ? where id = ?`).run(q, t, r.id)
        n++
      }
    }
    if (n > 0) console.log(`[迁移 16] 补回原文出处 ${n} 条`)
  }
}

/**
 * ★★★ V17 建表时那 12 种题型 —— **冻成字面量**（T-2.12 的先例，2026-09-08）
 *
 * 这里原来写的是 `import { QTYPES as SEED_QTYPES } from '@core/qtypes.ts'` ——
 * 一条**已经写完、已经在使用者机器上跑过**的迁移，引用了一个会变的常量。
 * D-478 取消档位、把 `QTypeDef.tier` 删掉的那一刻它就编译不过了；
 * 而就算编得过，改一次 core 的出厂题型也会**悄悄改掉一条历史迁移的行为**
 * （D-216：编号迁移不回头改。V29 那次的 `V29_PREFS` 是同一个处置）。
 *
 * ★ 冻的是**它当时写下的那一份**（含 `tier` —— `qtypes.tier` 是 `not null`，
 *   而那时候档位还在）。今天的出厂题型在 `core/qtypes.ts`，由 `db/builtins.ts` 落库；
 *   两者从此各走各的，谁都不会再牵动谁。
 */
const V17_SEED_QTYPES = [
  {
    id: '造句',
    name: '造句',
    tier: 1,
    brief: '给一个场景，用这个表达写一句',
    guide: 'Give a concrete situation and ask for one sentence using the target expression.',
    canonical: true
  },
  {
    id: '搭配填空',
    name: '搭配填空',
    tier: 1,
    brief: '句子里空掉搭配的那一半，自己填',
    guide:
      'Write one sentence with the collocating part of the expression left as a blank ' +
      '(e.g. the preposition, or the verb it takes). No options — they write it themselves.',
    canonical: false
  },
  {
    id: '开放填空',
    name: '开放填空',
    tier: 1,
    brief: '整条挖空，没有选项',
    guide:
      'Write one sentence where the whole target expression is blanked out with underscores, ' +
      'one underscore group per word. Never offer options.',
    canonical: false
  },

  {
    id: '句子改写',
    name: '句子改写',
    tier: 2,
    brief: '给一句平淡的，用这个表达重写',
    guide:
      'Give a flat but correct sentence carrying the same meaning, and ask them to rewrite it ' +
      'using the target expression.',
    canonical: true
  },
  {
    id: '释义改写',
    name: '释义改写',
    tier: 2,
    brief: '给一句解释性的说法，压缩成这个表达',
    guide:
      'Give a wordy paraphrase of the idea and ask them to say the same thing more economically ' +
      'with the target expression.',
    canonical: false
  },
  {
    id: '句子合并',
    name: '句子合并',
    tier: 2,
    brief: '两句并成一句，用上这个表达',
    guide:
      'Give two short sentences and ask them to combine into one, using the target expression ' +
      'to carry the relation between them.',
    canonical: false
  },

  {
    id: '错误订正',
    name: '错误订正',
    tier: 3,
    brief: '给一句用错的，找出来改对',
    guide:
      'Give one sentence that misuses the expression in a way a learner plausibly would, ' +
      'and ask them to fix it. The error must be in the expression itself, not elsewhere.',
    canonical: true
  },
  {
    id: '语域转换',
    name: '语域转换',
    tier: 3,
    brief: '同一件事，换一个语域说',
    guide:
      'Give one sentence using the expression in one register and ask them to rewrite it for ' +
      'a different setting (spoken ↔ written, or neutral → academic), keeping the expression apt.',
    canonical: false
  },

  {
    id: '限定写作',
    name: '限定写作',
    tier: 4,
    brief: '三句话，带着约束写',
    guide:
      'Ask for three sentences on a given topic under an explicit constraint ' +
      '(a stance to take, a word to avoid, a structure to use), with the expression carrying weight.',
    canonical: true
  },
  {
    id: '摘要写作',
    name: '摘要写作',
    tier: 4,
    brief: '把一段压成三句，用上这个表达',
    guide:
      'Give a short passage (4–6 sentences) and ask them to summarise it in three sentences, ' +
      'using the target expression where it genuinely fits.',
    canonical: false
  },

  {
    id: '情景任务',
    name: '情景任务',
    tier: 5,
    brief: '一个真实场景，写 80–120 词',
    guide:
      'Give a realistic writing task (an email, a comment, a short argument) in 80–120 words ' +
      'where the expression is the natural choice, not a bolt-on.',
    canonical: true
  },
  {
    id: '论点应答',
    name: '论点应答',
    tier: 5,
    brief: '回应一个观点，80–120 词',
    guide:
      'State a position they are likely to disagree with, and ask for an 80–120 word response ' +
      'that concedes something and then pushes back, using the expression to carry the pivot.',
    canonical: false
  }
] as const

export const v17: Migration = {
  version: 17,
  name: 'qtypes-table',
  up(db) {
    db.exec(`
      create table if not exists qtypes (
        id         integer primary key autoincrement,
        uid        text,
        key        text    not null,
        name       text    not null,
        tier       integer not null,
        brief      text    not null default '',
        guide      text    not null default '',
        prompt     text    not null default '',
        enabled    integer not null default 1,
        canonical  integer not null default 0,
        builtin    integer not null default 0,
        sort       integer not null default 0,
        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists idx_qtypes_sort on qtypes(tier, sort, id);
      create unique index if not exists idx_qtypes_key on qtypes(key);
    `)
    db.exec(`update qtypes set uid = 'qtypes-' || lower(hex(randomblob(8))) where uid is null`)
    db.exec(`create unique index if not exists idx_qtypes_uid on qtypes (uid)`)
    db.exec(`
      create trigger if not exists trg_qtypes_uid after insert on qtypes
        when new.uid is null
      begin
        update qtypes set uid = 'qtypes-' || lower(hex(randomblob(8))) where rowid = new.rowid;
      end;
    `)

    const t = Date.now()
    const ins = db.prepare(
      `insert into qtypes (key, name, tier, brief, guide, enabled, canonical, builtin, sort,
                           created_at, updated_at)
       values (?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)
       on conflict(key) do nothing`
    )
    let sort = 0
    for (const q of V17_SEED_QTYPES) {
      ins.run(q.id, q.name, q.tier, q.brief, q.guide, q.canonical ? 1 : 0, ++sort, t, t)
    }
  }
}

export const v18: Migration = {
  version: 18,
  name: 'chat-mode-and-quest-cards',
  up(db) {
    db.exec(`alter table chat_messages add column mode text not null default 'enlighten'`)
    db.exec(`alter table chat_messages add column quest_no integer`)
    db.exec(`create index if not exists idx_chat_mode on chat_messages(file_id, mode, quest_no, id)`)
    /**
     * 以前 Quest 出的题是 kind='task' 存的，混在同一条流里。
     * 把它们连同紧邻的对话认领到 quest 那一边 —— 不这么做，
     * 他切到 Quest 会看见一个空聊天框，以为历史没了。
     */
    db.exec(`update chat_messages set mode = 'quest' where kind = 'task'`)
    const tasks = db
      .prepare(`select id, file_id from chat_messages where kind = 'task' order by file_id, id`)
      .all() as { id: number; file_id: number }[]
    const seen = new Map<number, number>()
    const up = db.prepare(`update chat_messages set quest_no = ? where id = ?`)
    for (const row of tasks) {
      const n = (seen.get(row.file_id) ?? 0) + 1
      seen.set(row.file_id, n)
      up.run(n, row.id)
    }
  }
}

export const v19: Migration = {
  version: 19,
  name: 'analyzing 不再是业务状态（F-2-①）',
  up(db) {
    /**
     * ★★ F-2-① · `analyzing` 从 `lectures.status` 里退出。
     *
     * 它是**运行事实**（这一讲正在被分析），不是业务状态。以前它占着
     * `status` 那一格，写进去的那一刻就把真实状态（training / review / empty）
     * 销毁了 —— 崩溃之后启动恢复只能靠 `due_at` 和「有没有知识点」去猜，
     * 于是同一份数据，正常异常退出和崩溃重启会得到不同的结果（F-2）。
     *
     * 新代码不再写它。但**旧库里可能还留着**（上一次分析跑到一半就关了软件），
     * 这些行必须在这里安全落地 —— 留着不管的话，工作台上既没有 review 的
     * 「开始学」也没有 training 的界面，那一讲等于废掉。
     *
     * ── 怎么转：用**这版软件本来就会用的那条规则** ──────────────
     *
     * 不发明新判据。`recover.ts / recoverStuckAnalyzing` 现有的规则是：
     *   有排期  → training（只有 startLearning 会写 due_at，说明它进过轮转）
     *   有内容  → review（上次分析的部分结果保住了，停在 F-03 那道门）
     *   都没有  → empty
     * 也就是说：这些行**在下一次启动时本来就会被这么处理**，
     * 迁移只是把那一刻提前，行为一个字都没变。
     *
     * ── 保守在哪 ────────────────────────────────────────────
     *
     * 只改 `status` 一个字段。`due_at` / `interval_days` / `silent` /
     * 学习记录 / 条目进度一律不碰 —— 尤其**不许凭空造出 due_at**：
     * `training + due_at=null + silent=1` 是合法的（归档不排期），
     * `silent=0` 的那种是 D-4 的历史遗留，交给已有的自愈和数据体检，
     * 不在这里替它们做决定。
     *
     * 每一条都写进 `lecture_logs`：他在那一讲的日志里看得见发生过什么，
     * 而不是某天发现状态莫名其妙变了。
     */
    const rows = db
      .prepare(
        `select l.id, l.name, l.due_at as dueAt,
                (select count(*) from item_lectures il join items i on i.id = il.item_id
                  where il.lecture_id = l.id and i.deleted_at is null) as items
           from lectures l
          where l.status = 'analyzing'`
      )
      .all() as { id: number; name: string; dueAt: number | null; items: number }[]
    if (rows.length === 0) return

    const t = Date.now()
    const up = db.prepare(`update lectures set status = ?, updated_at = ? where id = ?`)
    const log = db.prepare(
      `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at)
       values (?, 'recovered', ?, ?, ?)`
    )
    for (const l of rows) {
      const to = l.dueAt !== null ? 'training' : l.items > 0 ? 'review' : 'empty'
      up.run(to, t, l.id)
      log.run(
        l.id,
        `升级时发现它停在「分析中」（上次分析没跑完），按已有规则恢复为「${to}」—— 排期与进度一个字没动`,
        t,
        t
      )
    }
  }
}

/** 这一段按版本号顺序排好，交给 migrations.ts 拼成完整的 MIGRATIONS */
export const V01_V19: Migration[] = [
  ...v1s,
  v2,
  v3,
  v4,
  v5,
  v6,
  v7,
  v8,
  v9,
  v10,
  v11,
  v12,
  v13,
  v14,
  v15,
  v16,
  v17,
  v18,
  v19
]
