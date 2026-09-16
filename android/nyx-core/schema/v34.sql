-- Nyx 本地数据库的目标结构 · v34
--
-- ★★ 这份文件是**生成的，不要手改**。
--    重新生成：npm run schema:dump
--
-- ── 它是什么 ────────────────────────────────────────────────
--
--   migrations.ts    老库 → v34        （升级路径，只增不删）
--   本文件            v34 应该长什么样  （目标定义，两端共用）
--
-- 两者由 `npm run check:schema` 互相验证：
--   空库 → 重放全部 migration      → 结构 A
--   空库 → 执行本文件              → 结构 B
--   A 与 B 必须逐字相同，同步表面指纹也必须相同。
--   不相同就说明本文件不是真相，只是一份漂了的复制品。
--
-- ── Android 怎么用 ──────────────────────────────────────────
--
-- 全新安装**不重放历史 migration**，直接执行这一份建到 v34。
-- 之后的结构变更（v35 起）两端共用同一份 DDL。
-- 本地独有的表（Windows 的 dictionaries / analysis_jobs）可以不一样 ——
-- 同步兼容性只看**同步表面**，不看整库。

pragma foreign_keys = ON;
CREATE TABLE analysis_blocks (
        id          integer primary key autoincrement,
        item_id     integer not null references items(id),
        block       text    not null,
        content     text    not null,
        edited      integer not null default 0,
        regen_count integer not null default 0,
        created_at  integer not null,
        updated_at  integer not null, uid text,
        unique (item_id, block)
      );

CREATE TABLE analysis_jobs (
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
      , preset_name text);

CREATE TABLE answers (
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
      , uid text);

CREATE TABLE assessments (
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
      , uid text);

CREATE TABLE chat_messages (
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
      , uid text, mode text not null default 'enlighten', quest_no integer);

CREATE TABLE dictionaries (
        id         integer primary key autoincrement,
        ifo_path   text    not null unique,
        folder     text    not null,
        bookname   text    not null,
        word_count integer not null default 0,
        enabled    integer not null default 1,
        sort_order integer not null default 0,
        missing    integer not null default 0,
        updated_at integer not null
      , uid text, format text, status text, diagnostic text, capabilities text, resources text, probed_at integer);

CREATE TABLE drafts (
        id          integer primary key autoincrement,
        session_id  integer not null references sessions(id),
        question_id integer not null references questions(id),
        text        text    not null,
        created_at  integer not null,
        updated_at  integer not null, uid text,
        unique (session_id, question_id)
      );

CREATE TABLE files (
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
      , uid text);

CREATE TABLE "genres" (
        uid        text    primary key not null,
        name       text    not null,
        prompt     text    not null default '',
        is_default integer not null default 0,
        builtin    integer not null default 0,
        sort       integer not null default 0,
        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      );

CREATE TABLE item_events (
        id         integer primary key autoincrement,
        item_id    integer not null references items(id),
        kind       text    not null,
        detail     text    not null default '',
        created_at integer not null,
        updated_at integer not null
      , uid text);

CREATE TABLE item_lectures (
        item_id    integer not null references items(id),
        lecture_id integer not null references lectures(id),
        is_owner   integer not null default 0,
        created_at integer not null,
        updated_at integer not null, uid text,
        primary key (item_id, lecture_id)
      );

CREATE TABLE items (
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
      , uid text, source_material_id integer references materials(id), silenced_by text);

CREATE TABLE lecture_logs (
        id         integer primary key autoincrement,
        lecture_id integer not null references lectures(id),
        event      text    not null,
        detail     text    not null default '',
        created_at integer not null,
        updated_at integer not null
      , uid text);

CREATE TABLE lectures (
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
      , preset_id integer, uid text);

CREATE TABLE materials (
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
      , uid text);

CREATE TABLE migration_log (
          id           integer primary key autoincrement,
          from_version integer not null,
          to_version   integer not null,
          name         text    not null,
          ran_at       integer not null,
          ok           integer not null,
          note         text,
          updated_at   integer not null
        );

CREATE TABLE occurrences (
        id          integer primary key autoincrement,
        item_id     integer not null references items(id),
        material_id integer references materials(id),
        lecture_id  integer references lectures(id),
        quote       text    not null,
        para        integer,
        created_at  integer not null,
        updated_at  integer not null
      , uid text);

CREATE TABLE ops_log (
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

CREATE TABLE picks (
        id         integer primary key autoincrement,
        scope      text    not null,
        scope_id   integer not null,
        content    text    not null,
        created_at integer not null,
        updated_at integer not null
      , uid text);

CREATE TABLE profile_facts (
        id         integer primary key autoincrement,
        exams      text    not null default '',
        years      text    not null default '',
        goal       text    not null default '',
        sample     text    not null default '',
        created_at integer not null,
        updated_at integer not null
      , uid text);

CREATE TABLE projects (
        id         integer primary key autoincrement,
        name       text    not null,
        color      text    not null default '#6d5efc',
        pinned     integer not null default 0,
        silent     integer not null default 0,
        sort       integer not null default 0,
        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      , uid text);

CREATE TABLE prompt_presets (
        id         integer primary key autoincrement,
        name       text    not null,
        target     text    not null default 'analyze-material',
        extra      text    not null default '',
        builtin    integer not null default 0,
        sort       integer not null default 0,
        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      , uid text);

CREATE TABLE "qtypes" (
        uid        text    primary key not null,
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

CREATE TABLE questions (
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
      , uid text, qtype_sig text);

CREATE TABLE reading_cards (
        id            integer primary key autoincrement,
        item_id       integer not null references items(id),

        ease          real    not null default 2.5,
        interval_days integer not null default 0,
        reps          integer not null default 0,
        lapses        integer not null default 0,
        due_at        integer,
        silent        integer not null default 0,

        uid           text,
        created_at    integer not null,
        updated_at    integer not null
      );

CREATE TABLE resolutions (
        uid            text    primary key not null,
        target_uid     text    not null,
        kind           text    not null,
        rejected_up_to integer not null,
        created_at     integer not null,
        updated_at     integer not null
      );

CREATE TABLE review_logs (
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
      , uid text);

CREATE TABLE row_sync_state (
        table_name        text    not null,
        uid               text    not null,
        synced_updated_at integer,
        pushed_updated_at integer,
        updated_at        integer not null,
        primary key (table_name, uid)
      );

CREATE TABLE sessions (
        id          integer primary key autoincrement,
        kind        text    not null,
        scope       text    not null default '',
        target      integer not null default 0,
        started_at  integer not null,
        finished_at integer,
        created_at  integer not null,
        updated_at  integer not null
      , uid text);

CREATE TABLE settings (
          key         text primary key,
          value       text not null,
          updated_at  integer not null
        );

CREATE TABLE state_events (
        id         integer primary key autoincrement,
        item_id    integer not null references items(id),
        line       text    not null default 'production',
        from_state text,
        to_state   text    not null,
        created_at integer not null,
        updated_at integer not null
      , uid text);

CREATE TABLE term_ledger (
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
      , revoked_at integer);

CREATE TABLE tombstones (
        id         integer primary key autoincrement,
        uid        text,
        target_uid text    not null,
        kind       text    not null,
        purged_at  integer not null,
        created_at integer not null,
        updated_at integer not null
      , target_id integer);

CREATE TABLE tutors (
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
      , uid text);

CREATE TABLE units (
        id         integer primary key autoincrement,
        project_id integer not null references projects(id),
        name       text    not null,
        sort       integer not null default 0,
        silent     integer not null default 0,
        deleted_at integer,
        created_at integer not null,
        updated_at integer not null
      , uid text);

CREATE TABLE user_preferences (
        uid         text    primary key not null,
        key         text    not null,
        value       text    not null,
        created_at  integer not null,
        updated_at  integer not null
      );

CREATE UNIQUE INDEX idx_analysis_blocks_uid on "analysis_blocks" (uid);

CREATE INDEX idx_answers_item on answers(item_id);

CREATE UNIQUE INDEX idx_answers_uid on "answers" (uid);

CREATE UNIQUE INDEX idx_assessments_uid on "assessments" (uid);

CREATE INDEX idx_chat_file on chat_messages(file_id);

CREATE UNIQUE INDEX idx_chat_messages_uid on "chat_messages" (uid);

CREATE INDEX idx_chat_mode on chat_messages(file_id, mode, quest_no, id);

CREATE INDEX idx_dict_order on dictionaries (sort_order);

CREATE INDEX idx_dict_uid on dictionaries (uid);

CREATE UNIQUE INDEX idx_drafts_uid on "drafts" (uid);

CREATE INDEX idx_files_status on files(status) where deleted_at is null;

CREATE UNIQUE INDEX idx_files_uid on "files" (uid);

CREATE INDEX idx_genres_sort on genres(sort);

CREATE INDEX idx_item_events on item_events (item_id, id);

CREATE UNIQUE INDEX idx_item_events_uid on item_events (uid);

CREATE UNIQUE INDEX idx_item_lectures_uid on "item_lectures" (uid);

CREATE INDEX idx_items_card_due on items(card_due_at) where deleted_at is null;

CREATE INDEX idx_items_owner on items(owner_lecture_id);

CREATE INDEX idx_items_silenced_by on items(silenced_by);

CREATE INDEX idx_items_source_material on items(source_material_id);

CREATE INDEX idx_items_term  on items(term);

CREATE UNIQUE INDEX idx_items_uid on "items" (uid);

CREATE INDEX idx_jobs_lecture on analysis_jobs(lecture_id);

CREATE INDEX idx_lecture_logs on lecture_logs(lecture_id);

CREATE UNIQUE INDEX idx_lecture_logs_uid on "lecture_logs" (uid);

CREATE INDEX idx_lectures_due   on lectures(due_at) where deleted_at is null;

CREATE UNIQUE INDEX idx_lectures_uid on "lectures" (uid);

CREATE INDEX idx_lectures_unit  on lectures(unit_id);

CREATE INDEX idx_ledger_live on term_ledger(norm, revoked_at);

CREATE INDEX idx_ledger_norm on term_ledger(norm);

CREATE UNIQUE INDEX idx_ledger_one
        on term_ledger(norm, verdict, coalesce(lecture_id, 0));

CREATE INDEX idx_materials_lecture on materials(lecture_id);

CREATE UNIQUE INDEX idx_materials_uid on "materials" (uid);

CREATE INDEX idx_occ_item on occurrences(item_id);

CREATE UNIQUE INDEX idx_occurrences_uid on "occurrences" (uid);

CREATE INDEX idx_ops_at on ops_log(created_at);

CREATE UNIQUE INDEX idx_ops_log_uid on "ops_log" (uid);

CREATE INDEX idx_ops_op on ops_log(op);

CREATE INDEX idx_picks_scope on picks (scope, scope_id, id desc);

CREATE UNIQUE INDEX idx_picks_uid on "picks" (uid);

CREATE UNIQUE INDEX idx_profile_facts_uid on "profile_facts" (uid);

CREATE UNIQUE INDEX idx_projects_uid on "projects" (uid);

CREATE UNIQUE INDEX idx_prompt_presets_uid on "prompt_presets" (uid);

CREATE UNIQUE INDEX idx_qtypes_key on qtypes(key);

CREATE INDEX idx_qtypes_sort on qtypes(tier, sort, uid);

CREATE INDEX idx_questions_item on questions(item_id, tier);

CREATE UNIQUE INDEX idx_questions_uid on "questions" (uid);

CREATE INDEX idx_reading_cards_due on reading_cards(due_at);

CREATE UNIQUE INDEX idx_reading_cards_item on reading_cards(item_id);

CREATE UNIQUE INDEX idx_reading_cards_uid  on reading_cards(uid);

CREATE UNIQUE INDEX idx_resolutions_target
        on resolutions (target_uid, kind);

CREATE INDEX idx_review_item on review_logs(item_id);

CREATE UNIQUE INDEX idx_review_logs_uid on "review_logs" (uid);

CREATE UNIQUE INDEX idx_sessions_uid on "sessions" (uid);

CREATE INDEX idx_state_events_at on state_events(created_at);

CREATE INDEX idx_state_events_item on state_events(item_id);

CREATE UNIQUE INDEX idx_state_events_uid on "state_events" (uid);

CREATE UNIQUE INDEX idx_term_ledger_uid on "term_ledger" (uid);

CREATE INDEX idx_tombstones_parent on tombstones (kind, target_id);

CREATE INDEX idx_tombstones_purged on tombstones (purged_at);

CREATE UNIQUE INDEX idx_tombstones_target on tombstones (target_uid, kind);

CREATE UNIQUE INDEX idx_tombstones_uid on tombstones (uid);

CREATE UNIQUE INDEX idx_tutors_uid on "tutors" (uid);

CREATE INDEX idx_units_project  on units(project_id);

CREATE UNIQUE INDEX idx_units_uid on "units" (uid);

CREATE UNIQUE INDEX idx_user_preferences_key on user_preferences (key);

CREATE TRIGGER trg_analysis_blocks_uid after insert on "analysis_blocks"
            when new.uid is null
          begin
            update "analysis_blocks" set uid = ('analysis_blocks-nat-' || replace(replace((select p.uid from items p where p.id = new.item_id), '\', '\\'), '|', '\p') || '|' || replace(replace(new.block, '\', '\\'), '|', '\p')) where rowid = new.rowid;
          end;

CREATE TRIGGER trg_answers_uid after insert on "answers"
          when new.uid is null
        begin
          update "answers" set uid = 'answers-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_assessments_uid after insert on "assessments"
          when new.uid is null
        begin
          update "assessments" set uid = 'assessments-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_chat_messages_uid after insert on "chat_messages"
          when new.uid is null
        begin
          update "chat_messages" set uid = 'chat_messages-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_drafts_uid after insert on "drafts"
            when new.uid is null
          begin
            update "drafts" set uid = ('drafts-nat-' || replace(replace((select p.uid from sessions p where p.id = new.session_id), '\', '\\'), '|', '\p') || '|' || replace(replace((select p.uid from questions p where p.id = new.question_id), '\', '\\'), '|', '\p')) where rowid = new.rowid;
          end;

CREATE TRIGGER trg_files_uid after insert on "files"
          when new.uid is null
        begin
          update "files" set uid = 'files-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_il_reading_card after insert on item_lectures
        when exists (
          select 1 from lectures l
           where l.id = new.lecture_id
             and l.status = 'training'
             and l.silent = 0
             and l.deleted_at is null
        )
      begin
        update reading_cards set due_at = new.created_at, updated_at = new.created_at
         where item_id = new.item_id
           and due_at is null
           and silent = 0
           and exists (
             select 1 from items i
              where i.id = new.item_id and i.deleted_at is null and i.source = 'self'
           );
      end;

CREATE TRIGGER trg_item_events_uid after insert on item_events
        when new.uid is null
      begin
        update item_events set uid = 'item_events-' || lower(hex(randomblob(8)))
         where rowid = new.rowid;
      end;

CREATE TRIGGER trg_item_lectures_uid after insert on "item_lectures"
            when new.uid is null
          begin
            update "item_lectures" set uid = ('item_lectures-nat-' || replace(replace((select p.uid from items p where p.id = new.item_id), '\', '\\'), '|', '\p') || '|' || replace(replace((select p.uid from lectures p where p.id = new.lecture_id), '\', '\\'), '|', '\p')) where rowid = new.rowid;
          end;

CREATE TRIGGER trg_items_reading_card after insert on items
      when new.uid is not null
      begin
        insert or ignore into reading_cards (item_id, created_at, updated_at)
          values (new.id, new.created_at, 0);
      end;

CREATE TRIGGER trg_items_reading_card_late after update of uid on items
      when old.uid is null and new.uid is not null
      begin
        insert or ignore into reading_cards (item_id, created_at, updated_at)
          values (new.id, new.created_at, 0);
      end;

CREATE TRIGGER trg_items_uid after insert on "items"
          when new.uid is null
        begin
          update "items" set uid = 'items-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_lecture_logs_uid after insert on "lecture_logs"
          when new.uid is null
        begin
          update "lecture_logs" set uid = 'lecture_logs-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_lectures_uid after insert on "lectures"
          when new.uid is null
        begin
          update "lectures" set uid = 'lectures-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_materials_uid after insert on "materials"
          when new.uid is null
        begin
          update "materials" set uid = 'materials-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_occurrences_uid after insert on "occurrences"
            when new.uid is null
          begin
            update "occurrences" set uid = (case when new.material_id is not null then ('occurrences-nat-' || replace(replace('m', '\', '\\'), '|', '\p') || '|' || replace(replace((select p.uid from items p where p.id = new.item_id), '\', '\\'), '|', '\p') || '|' || replace(replace((select p.uid from materials p where p.id = new.material_id), '\', '\\'), '|', '\p')) else ('occurrences-nat-' || replace(replace('l', '\', '\\'), '|', '\p') || '|' || replace(replace((select p.uid from items p where p.id = new.item_id), '\', '\\'), '|', '\p') || '|' || replace(replace((select p.uid from lectures p where p.id = new.lecture_id), '\', '\\'), '|', '\p')) end) where rowid = new.rowid;
          end;

CREATE TRIGGER trg_ops_log_uid after insert on "ops_log"
          when new.uid is null
        begin
          update "ops_log" set uid = 'ops_log-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_picks_uid after insert on "picks"
          when new.uid is null
        begin
          update "picks" set uid = 'picks-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_profile_facts_uid after insert on "profile_facts"
          when new.uid is null
        begin
          update "profile_facts" set uid = 'profile_facts-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_projects_uid after insert on "projects"
          when new.uid is null
        begin
          update "projects" set uid = 'projects-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_prompt_presets_uid after insert on "prompt_presets"
          when new.uid is null
        begin
          update "prompt_presets" set uid = 'prompt_presets-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_questions_uid after insert on "questions"
          when new.uid is null
        begin
          update "questions" set uid = 'questions-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_reading_cards_uid after insert on "reading_cards"
            when new.uid is null
          begin
            update "reading_cards" set uid = ('reading_cards-nat-' || replace(replace((select p.uid from items p where p.id = new.item_id), '\', '\\'), '|', '\p')) where rowid = new.rowid;
          end;

CREATE TRIGGER trg_resolutions_merge before insert on resolutions
        when exists (
          select 1 from resolutions
           where target_uid = new.target_uid and kind = new.kind
        )
      begin
        update resolutions
           set rejected_up_to = max(rejected_up_to, new.rejected_up_to),
               updated_at     = max(updated_at, new.updated_at)
         where target_uid = new.target_uid and kind = new.kind;
        select raise(ignore);
      end;

CREATE TRIGGER trg_review_logs_uid after insert on "review_logs"
          when new.uid is null
        begin
          update "review_logs" set uid = 'review_logs-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_sessions_uid after insert on "sessions"
          when new.uid is null
        begin
          update "sessions" set uid = 'sessions-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_state_events_uid after insert on "state_events"
          when new.uid is null
        begin
          update "state_events" set uid = 'state_events-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_term_ledger_uid after insert on "term_ledger"
            when new.uid is null
          begin
            update "term_ledger" set uid = ('term_ledger-nat-' || replace(replace(new.norm, '\', '\\'), '|', '\p') || '|' || replace(replace(new.verdict, '\', '\\'), '|', '\p') || '|' || replace(replace(coalesce((select p.uid from lectures p where p.id = new.lecture_id), '-'), '\', '\\'), '|', '\p')) where rowid = new.rowid;
          end;

CREATE TRIGGER trg_tombstones_uid after insert on "tombstones"
            when new.uid is null
          begin
            update "tombstones" set uid = ('tombstones-nat-' || replace(replace(new.kind, '\', '\\'), '|', '\p') || '|' || replace(replace(new.target_uid, '\', '\\'), '|', '\p')) where rowid = new.rowid;
          end;

CREATE TRIGGER trg_tutors_uid after insert on "tutors"
          when new.uid is null
        begin
          update "tutors" set uid = 'tutors-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_units_uid after insert on "units"
          when new.uid is null
        begin
          update "units" set uid = 'units-' || lower(hex(randomblob(8)))
           where rowid = new.rowid;
        end;

CREATE TRIGGER trg_user_preferences_uid after insert on "user_preferences"
            when new.uid is null
          begin
            update "user_preferences" set uid = ('user_preferences-nat-' || replace(replace(new.key, '\', '\\'), '|', '\p')) where rowid = new.rowid;
          end;

pragma user_version = 34;
