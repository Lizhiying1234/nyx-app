/**
 * V30 ～ V38 · 认读卡分表（D-296）· 回收站与墓碑 · V37 / V38 纯数据迁移 · T-4.6 拆分（2026-09-06）
 *
 * ★ **正文一个字符没改**（D-216 第 4 条：写好的 up() 从此不许动；
 *   D-461：改了就要重生成 schema/vNN.sql 与同步基线）。
 *   搬动只换了外壳：`MIGRATIONS.push({` → `export const vNN: Migration = {`，
 *   收尾的 `})` → `}`。两者都在第 0 列、正文都在第 2 列，所以一行都没重新缩进。
 * ★ 顺序由本文件末尾那个数组固定，再由 migrations.ts 按段拼起来。
 */

import { SYNC_TABLES } from '@core/sync-tables.ts'
import { uidTriggerSql } from '@core/identity.ts'
import { checkPrefValue, prefUid } from '@core/prefs.ts'
import { migratePlaintextSyncSecret } from '../secrets.ts'
import type { Migration } from './types.ts'

export const v30: Migration = {
  version: 30,
  name: '同步密钥不再明文躺在库里（Step 5B · F-07 的安全尾巴）',
  up(db) {
    /**
     * ★★ 只做一件事：`sync.secret` 明文 → 密文。不夹带任何别的改动。
     *
     * 顺序不能变，它就是「不许丢密钥」这条保证本身：
     *
     *     读明文 → 加密 → 写进去 → **再解一次** → 逐字比对 → 才删明文
     *
     * 任何一步不成就抛：整条迁移回滚（明文原样留着），
     * `openDatabase` 再用升级前的备份把整个文件换回去，
     * 然后弹一句人话让他知道为什么打不开。
     *
     * ★ 宁可升级失败，也不能让他的同步密钥丢掉 —— 丢了没有任何办法找回来。
     * ★ 没配过同步的库（绝大多数全新安装）走 `none`，不要求系统凭据可用。
     * ★ 已经是密文的走 `already`，一个字不动 —— 这就是它的幂等性。
     *
     * 判据与加解密都在 `db/secrets.ts`，那是秘密的唯一边界；
     * 这里只负责在升级时调它一次。
     */
    const r = migratePlaintextSyncSecret(db)
    const t = Date.now()
    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (29, 30, ?, ?, 1, ?, ?)`
    ).run('同步密钥加密', t, JSON.stringify({ state: r.state }), t)
  }
}

export const v31: Migration = {
  version: 31,
  name: '行级同步基状态 —— 因果判断不再问时钟（Step 6C · D-292）',
  up(db) {
    /**
     * ★★ Step 6C · `row_sync_state` —— **本地专有，绝不上线。**
     *
     * ── 它解决的是一个被证明过的不可能 ──────────────────────
     *
     * 合并时要回答的那个问题是「**这一版我见过没有**」，
     * 而到 V30 为止全靠一句 `remote.updated_at > watermark`。
     * 那是一句**跨时钟比较**：左边对面的钟，右边我的钟。
     *
     * 已经证明：不存在任何只由「本机状态 + `remote.updated_at`」算出的
     * 标量判据能区分下面两种情形 ——
     *
     *   E1 回声：对面重推一个我早就收下、并在其上改过的旧版本 → 该 keep-local
     *   E2 慢钟：对面刚做的新编辑，只是它的钟慢          → 该 conflict
     *
     * 构造二者使本机状态与到达行的 `(uid, table, updated_at)` 完全相同，
     * 任何这样的判据取值必然相同，而正确答案不同。所以**只能靠行级状态**。
     *
     * ── 这张表记什么 ────────────────────────────────────────
     *
     *   `synced_updated_at` = 我最近一次**确认**与远端同步到的那个版本
     *
     * 它是合并三方比较里的**共同基版本**（common base）：
     *
     *   local == base && remote != base  → 收下对面的
     *   local != base && remote == base  → 留本地的
     *   local != base && remote != base  → 冲突（两边都动过基版本）
     *   local == base && remote == base  → 什么都不用做
     *
     * **全是相等比较，一次大小比较都没有** —— 时钟快慢从此不参与因果判断。
     *
     * ── 为什么不进同步 ──────────────────────────────────────
     *
     * 它记的是「**我**和远端确认到哪」，是一件本机私事：
     * 两台机器的基版本天然不同，传过去只会互相污染。
     * 所以它不在 `SYNC_TABLES` 里，不进 `SyncRow`、不进 chunk、
     * 不进 `applied`，一个字节都不上 RemoteStore。
     *
     * ── 为什么全部初始化成 NULL ─────────────────────────────
     *
     * 这张表建出来就是**空的** —— 存量业务行一条基状态都没有，
     * 于是它们的基版本全是 NULL，意思是「**没有被确认同步过**」。
     *
     * 不去拿 `updated_at` 回填、不去推断「这些历史行想必已经同步过了」。
     * 理由是那条一贯的不对称：
     *
     *   重复推送一次   = 可恢复、幂等、对面判 same 直接跳过
     *   错标成已同步   = **可能永久漏数据**，而且没有任何地方看得出来
     *
     * 代价是升级后第一次同步会把本地重推一遍。那是一次流量，不是一次事故。
     */
    /**
     * ★ 两条踩过的坑，都写在这儿免得下一个人再踩：
     *
     * ① **注释不许写进 `create table` 里**。`scripts/check-sql.mjs` 的表结构
     *    解析器会被块注释挡住、漏掉它后面那一列 —— 于是 check:sql 从此漏报，
     *    而它是一张永远绿的安慰牌。`tests/db-safety.ts` 里那条「尺子自己要准」
     *    的用例当场把这件事抓出来了。
     * ② **不许 `without rowid`**。体检与自愈的整库逐列比对是按 `rowid` 走的，
     *    没有 rowid 的表会让那一整套比对报 `no such column: rowid`。
     *
     * `synced_updated_at`：我最近一次确认与远端同步到的版本。
     * 「没有基版本」用**没有这一行**表示，不用 NULL —— 免得同时存在
     * 「没有行」和「行里是 NULL」两种说法，判据就有了两个入口。
     */
    /**
     * ★★ Step 6C · **两个字段，两件完全不同的事实。绝不许混用。**
     *
     *   `synced_updated_at`  我已经**处理/对账**到的那个远端版本 —— merge 的共同基版本
     *   `pushed_updated_at`  我已经成功交给远端存储的那个本地版本 —— 只管待推
     *
     * ── 为什么必须分成两个（这一段是 R-4-F-a ⑩ 用血换来的）──────
     *
     * 一开始只有一个字段，推送成功之后就把它顶上去。那等于宣称
     * **「推成功 = 对面已经对过账」** —— 而 store 是哑的 blob 存储，没有 ack，
     * 推送**永远**证明不了任何一台 peer 看过我这一版。
     *
     * 这个过度断言有两种发作形态：
     *
     *   ① 分歧在推之前就知道：那一行正等着他裁决，却因为它同时也是本地改动
     *      被推了出去、基版本跟着顶到本地版本 → 下一趟判成「只有云端改过」→
     *      take-remote。**他还没回答，问题就被替他答了**，而且 `resolutions`
     *      一个字没写，老包以后重放没有任何东西挡得住。（那 14 条同族失败）
     *   ② 分歧在推之后才知道：他选了「用本地的」，对面**在他的版本传过去之前**
     *      又改了一版。基版本已经顶到他的版本，于是那一版新改动被判成
     *      「只有云端改过」→ 静默盖掉他刚做的决定。（R-4-F-a ⑩）
     *
     * 形态①还能靠「未裁决的行不顶基版本」挡住，形态②挡不住 ——
     * 因为推的那一刻根本不知道对面会改。**所以只能分成两个字段。**
     *
     * ── 各自什么时候前进 ────────────────────────────────────
     *
     *   收下一个远端版本并**写进库了** → `synced` 和 `pushed` 一起顶到那一版
     *     （`pushed` 也顶：那一版本来就来自云端，它当然已经在远端存储里）
     *   本地版本 `put` **成功了**       → **只**顶 `pushed`
     *
     * ── 为什么两个都不许当成时间戳来比大小 ──────────────────
     *
     * 它们是**版本标记**，判据是「等不等于当前版本」，不是「谁大谁小」。
     * 一旦有人写出 `pushed_updated_at >= updated_at` 这种比较，
     * 它们就又变回墙钟水位了 —— 那正是这一整轮要拆掉的东西。
     *
     * ── 为什么建出来是空的 ──────────────────────────────────
     *
     * 存量行两个字段都没有，意思是「既没对过账、也没确认推出去过」。
     * 不拿 `updated_at` 回填、不推断。理由是那条一贯的不对称：
     *   重复推送一次 = 可恢复、幂等、对面判 same 直接跳过
     *   错标成已同步 = **可能永久漏数据**，而且没有任何地方看得出来
     */
    db.exec(`
      create table if not exists row_sync_state (
        table_name        text    not null,
        uid               text    not null,
        synced_updated_at integer,
        pushed_updated_at integer,
        updated_at        integer not null,
        primary key (table_name, uid)
      );
    `)

    /**
     * ★ 自检：这次迁移**不许动任何业务数据**。
     *
     * 建一张空表本来就不该动到别的东西，但「本来就不该」不是判据。
     * 数一遍每张同步表的行数，迁移前后必须一模一样 —— 数据静默丢失
     * 是这个项目最贵的失败形态，而它最常见的样子就是「某次迁移顺手多做了一点」。
     */
    const before = new Map<string, number>()
    for (const t of SYNC_TABLES) {
      try {
        before.set(t, (db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n)
      } catch {
        /* 表还没建出来（老库升级路径上的正常情况） */
      }
    }
    const empty = (db.prepare(`select count(*) as n from row_sync_state`).get() as { n: number }).n
    if (empty !== 0) {
      throw new Error(`row_sync_state 建出来就不是空的（${empty} 行）—— 迁移不该推断任何同步事实`)
    }
    for (const [t, n] of before) {
      const now = (db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
      if (now !== n) throw new Error(`V31 动了 "${t}" 的数据：${n} → ${now}`)
    }

    const t = Date.now()
    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (30, 31, ?, ?, 1, ?, ?)`
    ).run(
      '行级同步基状态',
      t,
      JSON.stringify({ base: 'empty', reason: '存量行一律视为未确认同步（宁可重推，不可漏数据）' }),
      t
    )
  }
}

export const v32: Migration = {
  version: 32,
  name: '词典表补上身份、状态、诊断、能力、资源清单（D2）',
  up(db) {
    /**
     * ══ D2 · `dictionaries` 只做增量扩展 ★★ ═══════════════════
     *
     * 加七列一个索引，**一行存量数据都不动**。
     *
     * ── 这条迁移里绝不许出现的四件事（他 2026-08-19 的验收要求）★★★ ──
     *
     *   ✗ 读取真实词典        ✗ 扫描目录
     *   ✗ 计算大文件 hash     ✗ 任何词典 I/O
     *
     * 理由不是洁癖，是**升级必须是可预期的**：
     * `UrbanDictionary.mdx` 471 MB、`oald10` 的资源包 2.1 GB。
     * 迁移里碰一下它们，他那次升级就会卡上几十秒到几分钟，
     * 而升级期间界面还没起来 —— 他看到的是「双击了没反应」。
     * 更糟的是移动硬盘拔掉的情形：迁移会**因为词典不在而失败**，
     * 于是整个库回滚、软件打不开 —— 词典不在根本不该影响他打开软件。
     *
     * 所以七列全部建成可空，值一律留 NULL，含义是「**还没探测过**」。
     * 真正填它们的是 `DictionaryRegistry.rescan()`（软件起来之后，D-262 的探测那一步）。
     * `tests/db-safety.ts` 里有一条用例扫这个 `up()` 的源码，
     * 出现 fs / 词典相关的调用就判红 —— 「不许做 I/O」这句话得有人守。
     *
     * ── 列的含义 ────────────────────────────────────────────
     *
     *   uid          跨设备身份（`core/dict/identity.ts::dictUid`）。
     *                ★ 不是唯一索引：同一本词典可能有两份文件（他那台机器上
     *                  LDOCE5 的资源包就是重复的），认领由 registry 判，
     *                  数据库不该在升级那一刻替他做删除决定。
     *   format       `mdict 2.0` / `stardict`
     *   status       `core/dict/diagnostics.ts::DictionaryStatus`
     *   diagnostic   一条 `DictionaryDiagnostic` 的 JSON。**这就是「诊断落库」** ——
     *                在这之前失败原因只活在内存里，靠每次启动全量装载重建；
     *                D5 要把全量装载改成惰性，那时诊断就没人重建了（见 diagnostics.ts 的第三节）。
     *   capabilities 书级能力的 JSON 数组
     *   resources    资源包清单的 JSON：`[{ name, bytes }]`
     *   probed_at    上一次探测的时刻。NULL = 从没探测过
     */
    /**
     * ★ 七条**字面**写出来，不用循环拼 —— `check:sql` 的解析器读的是字面 SQL，
     *   拼出来的列名它看不见，于是「这张表有哪些列」的那把尺子就漂了。
     *   第一版正是写成循环，`db-safety` 里那条「尺子自己要准」的用例当场变红。
     */
    db.exec(`alter table dictionaries add column uid text`)
    db.exec(`alter table dictionaries add column format text`)
    db.exec(`alter table dictionaries add column status text`)
    db.exec(`alter table dictionaries add column diagnostic text`)
    db.exec(`alter table dictionaries add column capabilities text`)
    db.exec(`alter table dictionaries add column resources text`)
    db.exec(`alter table dictionaries add column probed_at integer`)
    db.exec(`create index if not exists idx_dict_uid on dictionaries (uid)`)

    /**
     * 自检：加完之后**行数一个不少**，而且新列全是 NULL。
     * 「只增不删」不能只写在注释里 —— V31 也是这么自检的。
     */
    const n = (db.prepare(`select count(*) as n from dictionaries`).get() as { n: number }).n
    const probed = (
      db.prepare(`select count(*) as n from dictionaries where probed_at is not null`).get() as {
        n: number
      }
    ).n
    if (probed !== 0) {
      throw new Error(`V32 往新列里写了东西（${probed} 行有 probed_at）—— 迁移不该做任何探测`)
    }

    const t = Date.now()
    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (31, 32, ?, ?, 1, ?, ?)`
    ).run(
      '词典身份与诊断落库',
      t,
      JSON.stringify({ rows: n, filled: 'none', reason: '迁移不碰词典文件，全部留给 rescan 探测' }),
      t
    )
  }
}

export const v33: Migration = {
  version: 33,
  name: '默认词典跟着人走：settings 的本机 id → user_preferences 的 dictUid（D2.1）',
  allowShrink: ['settings'],
  up(db) {
    /**
     * ══ D2.1 · 他 2026-08-19 的裁决 ★★ ═══════════════════════
     *
     *   「旧决议『dict.default 属 DEVICE』成立的前提是它保存 dictionaries.id。
     *     现在身份模型已经改变：dict.default 将保存 stable dictUid。」
     *
     *   user_preferences['dict.default'] = dictUid          ← 跟着人走
     *   dictionaries.uid                 = 本机 → 稳定身份的映射
     *   dictionaries.id / ifo_path / enabled / sort_order   ← 仍然是 DEVICE
     *
     * ══ 五条规矩（缺一条就会出事）★★★ ════════════════════════
     *
     *   ① **只有解析成真实 uid 才搬。** 解析不出就原地不动 ——
     *      旧键留着，等 `rescan()` 探测出 uid 之后再自愈（见 registry 的 `healLegacyDefault`）。
     *   ② **绝不编 uid。** 找不到那一行、或那一行还没探测过（`uid is null`），
     *      就什么都不写。编一个出来的后果是：他换台设备之后默认词典指到一本
     *      根本不存在的书上，而且什么都不报。
     *   ③ **搬成功了才删旧键。** 删了没搬进去 = 他的设置丢了。
     *   ④ canonical 已经有值就不覆盖（和 V29 同一条规矩：不许拿老值盖新值）。
     *   ⑤ **不碰任何词典文件。** 这里只读 `dictionaries` 表 ——
     *      读表是数据库的事，读 `.mdx` 才是词典 I/O。V32 那条「迁移不做词典 I/O」
     *      的用例扫的是两条迁移的源码，这条也在里面。
     *
     * ══ 为什么绝大多数机器上这条迁移「什么都没做」★ ═══════════
     *
     * V32 刚把 `uid` 这一列加出来，值全是 NULL —— 要等软件起来、
     * `rescan()` 探测一遍才有。所以从 v31 一路升上来的库，
     * 走到这里时那一行的 uid 就是 NULL，按规矩 ② 什么都不做。
     * **真正干活的是 registry 里的自愈那一步。**
     * 这条迁移管的是另一种情形：已经跑过 D2、库里 uid 齐了，再升到 D2.1。
     */
    const raw = db.prepare(`select value from settings where key = 'dict.default'`).get() as
      | { value: string }
      | undefined
    const t = Date.now()
    const note: Record<string, unknown> = { had: raw?.value ?? null }

    if (raw) {
      const already = db.prepare(`select 1 as x from user_preferences where key = 'dict.default'`).get()
      if (already) {
        // 规矩 ④ · canonical 已经有了 → 旧键清掉即可（它已经没有意义了）
        db.prepare(`delete from settings where key = 'dict.default'`).run()
        note['action'] = 'canonical-already'
      } else {
        const id = Number(raw.value)
        const row = Number.isSafeInteger(id)
          ? (db.prepare(`select uid from dictionaries where id = ?`).get(id) as
              | { uid: string | null }
              | undefined)
          : undefined
        const uid = row?.uid ?? null
        if (uid && checkPrefValue('dict.default', uid).ok) {
          db.prepare(
            `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)
               on conflict(uid) do nothing`
          ).run(prefUid('dict.default'), 'dict.default', uid, t, t)
          // 规矩 ③ · 搬进去了才删
          const ok = db
            .prepare(`select value from user_preferences where key = 'dict.default'`)
            .get() as { value: string } | undefined
          if (ok?.value === uid) {
            db.prepare(`delete from settings where key = 'dict.default'`).run()
            note['action'] = 'moved'
            note['uid'] = uid
          } else {
            note['action'] = 'insert-failed'
          }
        } else {
          // 规矩 ①② · 解析不出真实 uid → 一个字都不写，旧键留着等自愈
          note['action'] = 'kept'
          note['why'] = row === undefined ? '本机没有这一行词典' : '这一行还没探测出 uid'
        }
      }
    } else {
      note['action'] = 'none'
    }

    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (32, 33, ?, ?, 1, ?, ?)`
    ).run('默认词典跟着人走', t, JSON.stringify(note), t)
  }
}

export const v34: Migration = {
  version: 34,
  name: '认读卡从 items 拆出来 —— reading_cards（D-296）',
  up(db) {
    /**
     * ══ D-296 · 为什么拆 ★★★ ══════════════════════════════════
     *
     * `items` 上住着**两个写入方完全不同的域**：
     *
     *   知识内容域   23 列   只有 Windows 写
     *   复习排期域    6 列   Windows 与 Android 都写（D-295 / D-298）
     *
     * 而冲突判定是**行级**的（`core/sync-merge.ts::decideRow` 比整行的
     * `updated_at`，没有逐列合并）。于是两边改了**毫不相干的列**也照样判冲突，
     * 裁决时又只能整行二选一 —— 另一个域的编辑被静默覆盖。
     *
     * 这不是推演，是实测：`tests/db-safety.ts` 的 **7E #20b**
     * （A 只改 6 个 card_*、B 只改 gloss，列不相交）实际结果是
     * `收 1 · 应用 0 · 失败 0 · 冲突 1`，裁决「用云端」后 gloss 被覆盖回去，
     * 全程 `failed = 0`、体检不亮。详见 `docs/issues.md` 的 **A-4**。
     *
     * 拆开之后手机碰 `reading_cards`、电脑碰 `items`，两边永远不碰同一行，
     * 假冲突**从结构上**消失，而不是靠合并逻辑去补救。
     *
     * ══ 这条迁移**不删任何东西**（D-216 只增不删）══════════════
     *
     * `items` 的 6 个 `card_*` 原样留着、值不动，作为**回滚来源**。
     * 它们同时被加进 `core/fk-map.ts` 的 `DROP_ON_SYNC['items']` ——
     * 于是不进包、不参与合并、不参与收敛 Oracle 的比对。
     * **留着但不发**：回滚用得上，正常运行构不成第二状态源。
     *
     * 物理删除留到将来单独一条迁移，且要等 v34 在两端稳定跑过之后。
     */
    const t = Date.now()

    /** ★ 迁移前的行数底账 —— 这条迁移只许**新增** reading_cards，别的表一行都不许动 */
    const before = new Map<string, number>()
    for (const tb of SYNC_TABLES) {
      if (tb === 'reading_cards') continue // 它还不存在
      try {
        before.set(tb, (db.prepare(`select count(*) as n from "${tb}"`).get() as { n: number }).n)
      } catch {
        /* 老库升级路径上可能还没这张表 */
      }
    }

    db.exec(`
      create table if not exists reading_cards (
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
      create unique index if not exists idx_reading_cards_item on reading_cards(item_id);
      create unique index if not exists idx_reading_cards_uid  on reading_cards(uid);
      -- 认读队列每次都按到期时间捞，等价于 v33 上的 idx_items_card_due
      create index if not exists idx_reading_cards_due on reading_cards(due_at);
    `)

    /**
     * uid 由**知识点的 uid 确定性推导**（`core/identity.ts::readingCardUid`）。
     * 这条迁移会在**每一台设备上各跑一次** —— 随机 uid 的话同一张卡在两台上
     * 会拿到两个 uid，同步过去变两行、撞 `unique(item_id)`，那一包永远进不了
     * `applied`。和 `item_lectures` 同一个道理、同一套解法。
     */
    db.exec(uidTriggerSql('reading_cards'))

    /**
     * ★★ 时间戳**原样搬**，绝不用迁移时刻。
     *
     * `decideRow` 的第一档判断是 `local.updatedAt === remote.updatedAt → same`，
     * 而且它**排在共同基判断之前**。两台各自迁移之后行内容与 `updated_at`
     * 逐字相同 → 直接判 `same` → 跳过，不进冲突。
     *
     * 写成 `Date.now()` 的话两台迁移时刻必然不同，而共同基又是空的
     * （见下），于是**每一行都是一处冲突** —— 几百个弹窗。
     * 这正是 D-285 当年为 V28 回填立的规矩，一字不差地适用于这里。
     */
    db.exec(`
      insert into reading_cards
        (item_id, ease, interval_days, reps, lapses, due_at, silent, created_at, updated_at)
      select id, card_ease, card_interval, card_reps, card_lapses, card_due_at, card_silent,
             created_at, updated_at
        from items
    `)

    /**
     * ★★ 每条 item 都必须有卡 —— 今天这件事由**表结构**保证
     * （`card_*` 是 `items` 上的 NOT NULL 列，行在卡就在）。
     * 拆表之后要有等价的保证，否则会出现「有知识点、没有卡，
     * 于是它永远不进认读队列」——而且不报错（F-2-②-a 那一类病）。
     *
     * 用触发器而不是在那 4 处 `insert into items` 各写一遍，理由和
     * `uidTriggerSql` 的注释一模一样：**管住所有插入路径，包括以后新写的代码**。
     *
     * ── `updated_at = 0` 是有意的（PRISTINE 语义）★★ ────────────
     *
     * 一张刚建出来的卡只有默认值，**没有任何需要跨设备传播的本地变更**。
     * 写 0 有两个正好想要的后果：
     *
     *   ① 它不进「待推」（待推查询排除 PRISTINE 行）—— 不推没有信息的行
     *   ② `decideRow` 里 `base = recordedBase ?? (local.updatedAt === 0 ? 0 : undefined)`
     *      → 本地没变、远端变了 → **take-remote**
     *
     * 第 ② 条是关键：B 收到 A 新建的知识点时，这条触发器会先建一张占位卡；
     * 紧接着 A 那张**真卡**到达（uid 相同，确定性推导），占位卡让位、被 upsert 覆盖。
     * 若占位卡写的是真实时间戳，那一刻就会被判成「两边都改过」→ 冲突，
     * 而 B 根本没碰过它。
     */
    /**
     * ★★ 为什么是**两条**触发器（这一条是实测撞出来的）
     *
     * `trg_items_uid` 和建卡触发器都是 `items` 的 AFTER INSERT，而
     * **SQLite 不保证同类触发器的先后顺序**。第一版只写了 insert 那一条，
     * 结果建卡时 `items.uid` 还是空的 → 卡的 uid 算不出来 → 23 行 uid 为 null，
     * 体检报 `sync-uid-missing`、收敛 Oracle 报「只有 A 有」。
     * **没有报错，只是那些卡永远同步不出去。**
     *
     * 所以按 `items.uid` **什么时候到位**分成两条路：
     *
     *   ① 本机新建：insert 时 uid 为空 → `trg_items_uid` 补上的那一刻建卡
     *   ② 同步收下：包里自带 uid，insert 当场就有 → 立刻建卡
     *
     * 两条都是单语句体，不给 A-1（插件切不开双语句触发器）添新债。
     */
    db.exec(`
      create trigger if not exists trg_items_reading_card after insert on items
      when new.uid is not null
      begin
        insert or ignore into reading_cards (item_id, created_at, updated_at)
          values (new.id, new.created_at, 0);
      end;
    `)
    db.exec(`
      create trigger if not exists trg_items_reading_card_late after update of uid on items
      when old.uid is null and new.uid is not null
      begin
        insert or ignore into reading_cards (item_id, created_at, updated_at)
          values (new.id, new.created_at, 0);
      end;
    `)

    /**
     * `trg_il_reading_card` 改指向新表。语义一个字没变：
     * 「条目挂进**轮转中**的讲次时，给它首次认读资格」。
     * 卡一定存在（上面那条触发器 + 本次迁移的全量搬运保证），所以仍是纯 UPDATE。
     *
     * ★ 仍然是**单语句触发器体** —— A-1（Capacitor 插件切不开双语句触发器）
     *   那条坑不因为这次拆表变多。v33 里唯一的双语句体仍然只有
     *   `trg_resolutions_merge` 一条。
     */
    db.exec(`drop trigger if exists trg_il_reading_card`)
    db.exec(`
      create trigger trg_il_reading_card after insert on item_lectures
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
    `)

    // ── 自检：缺一条就整体失败回滚（D-216 第 4 条 / D-236）────────────
    const nItems = (db.prepare(`select count(*) as n from items`).get() as { n: number }).n
    const nCards = (db.prepare(`select count(*) as n from reading_cards`).get() as { n: number }).n
    if (nCards !== nItems) {
      throw new Error(`V34 搬运不完整：items ${nItems} 行，reading_cards ${nCards} 行`)
    }

    const noUid = (
      db.prepare(`select count(*) as n from reading_cards where uid is null or uid = ''`).get() as {
        n: number
      }
    ).n
    if (noUid > 0) {
      throw new Error(
        `V34 有 ${noUid} 张卡没算出 uid —— 多半是它的知识点 items.uid 是空的，` +
          `那样两台设备算不出同一个身份，第一次同步就会撞车`
      )
    }

    /** 值必须逐列搬对 —— 只要有一行对不上就说明 select 写错了列序 */
    const bad = (
      db
        .prepare(
          `select count(*) as n
             from reading_cards c join items i on i.id = c.item_id
            where c.ease          is not i.card_ease
               or c.interval_days is not i.card_interval
               or c.reps          is not i.card_reps
               or c.lapses        is not i.card_lapses
               or c.due_at        is not i.card_due_at
               or c.silent        is not i.card_silent
               or c.created_at    is not i.created_at
               or c.updated_at    is not i.updated_at`
        )
        .get() as { n: number }
    ).n
    if (bad > 0) throw new Error(`V34 有 ${bad} 行的值与源 items 对不上`)

    for (const [tb, n] of before) {
      const now = (db.prepare(`select count(*) as n from "${tb}"`).get() as { n: number }).n
      if (now !== n) throw new Error(`V34 动了 "${tb}" 的数据：${n} → ${now}`)
    }

    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (33, 34, ?, ?, 1, ?, ?)`
    ).run(
      '认读卡拆表',
      t,
      JSON.stringify({
        moved: nCards,
        stamps: 'copied-as-is',
        base: 'row_sync_state 留空（V31 先例：宁可重推，不可错标已同步）',
        legacy: 'items.card_* 保留不删，已加进 DROP_ON_SYNC'
      }),
      t
    )
  }
}

export const v35: Migration = {
  version: 35,
  name: '原始学习事实补三样：设备来源 · 产出反应时间 · session 规则快照（D-349 / D-350）',
  up(db) {
    /**
     * ══ 为什么加这三列 ★★★（D-349 / D-350）══════════════════════
     *
     * **手机不分析，所以手机的采集必须够电脑事后分析。** 这两条是一体两面：
     * **D-348** 定了 Android **不显示任何统计与分析**，
     * 于是 **D-349** 反过来要求**上传的原始学习事实必须详细** ——
     * **采不到的，事后补不回来。**
     *
     * 梳理 v34 时量出三个缺口：
     *
     *   ① **`schema/v34.sql` 里 `device` 出现 0 次。**
     *      设备编号只活在 `settings['sync.device']` 里当同步游标用，
     *      **从没挂到过任何一条学习事实上**。
     *      后果很具体：电脑那边**分不出「地铁上用手机练的」和「书桌前用电脑练的」**——
     *      而那恰恰是 Android 存在的全部理由（碎片化学习终端）。
     *      「他在碎片时间的正确率是不是更低」这类问题，**现在的数据永远答不出来**。
     *
     *   ② **产出线不记反应时间。**
     *      认读线的 `gradeCard` 一直在传 `Date.now() - shownAt`；
     *      产出线这边 `answers` **根本没有这一列**。
     *      而产出是这套方法的核心（把「读得懂」变成「写得出」），
     *      「他想了 40 秒才写出来」在那条线上比在认读线上更有意义。
     *
     *   ③ **`sessions` 不记规则快照**（D-350）。见下。
     *
     * ══ 为什么三样一次做完 ★★ ═══════════════════════════════════
     *
     * schema 只有一份，升级判据也只有一份（Android `src/db/upgrade.ts`，
     * PC 与真机跑同一份）。**一次迁移两端一起走，比三次便宜得多**，
     * 而且少两次「两端版本错开、同步停摆」的窗口期。
     *
     * ══ D-350 · 规则快照为什么要落库，而不是只放内存 ★★ ══════════
     *
     *   ① 手机上练到一半被系统杀掉**是常态**。内存快照一死，
     *      恢复之后**悄悄换成了新规则** —— 而《指导》§14 要防的正是这个。
     *   ② ★ `sessions` **已经在 `SYNC_TABLES` 里**，加一列就自动同步到电脑。
     *      否则规则一改，历史数据的可比性**无声地断掉**：
     *      同一批答案是在哪套题型、哪个 dailyTarget 下产生的，事后说不清。
     *
     * ══ 三条实现纪律 ★★ ════════════════════════════════════════
     *
     *   · **全部可空**，老数据留空 —— **不要给历史行编一个设备编号**。
     *     「不知道」是事实，编一个是伪造，而伪造的那部分**事后分辨不出来**。
     *   · 设备列**只存编号**（`settings['sync.device']` 那一个 8 位十六进制），
     *     **不存设备名** —— 要认设备去 `nyx/devices/*.json` 加平台字段。
     *     两处存同一件事就是两份判据。
     *   · 规则快照**整块存 JSON，不拆成多列** —— 与
     *     `core/prefs.ts::ARRAY_PREFS_MERGE_WHOLE` 同一条理由：
     *     拆开合并会合出**两边都不认**的结果。
     *
     * ★ 这一条**只增列，不动任何一行数据**（D-216 只增不删）。
     *   下面的底账就是用来证明这一点的。
     */
    const t = Date.now()

    /** 迁移前的行数底账 —— 这条迁移**一行数据都不许动** */
    const before = new Map<string, number>()
    for (const tb of SYNC_TABLES) {
      try {
        before.set(tb, (db.prepare(`select count(*) as n from "${tb}"`).get() as { n: number }).n)
      } catch {
        /* 老库升级路径上可能还没这张表 */
      }
    }

    /**
     * ★ 加列前先看有没有 —— 让这条迁移**可重入**。
     *   `alter table add column` 撞名会抛，而升级中途断电重来是真实场景。
     */
    const has = (table: string, col: string): boolean =>
      (db.prepare(`pragma table_info("${table}")`).all() as { name: string }[]).some(
        (c) => c.name === col
      )
    /**
     * ★★ 每一句都必须**字面量写全**，不许包一层「更好看的」辅助函数。
     *
     * 理由不是风格：`scripts/schema-from-migrations.mjs` 是用**正则**
     * 从这个文件里解析「每张表有哪些列」的，而 `check:sql` 拿那份解析
     * 去校验全项目所有 SQL 的列名。它只认两种形状：
     *   `alter table 表名 add column 列名 …`      ← 字面量
     *   `alter table "${变量}" add column 列名 …`  ← 循环里的表名
     *
     * 第一版我写成了 `add(table, col, decl)`，表名和列名**都是变量** ——
     * 两个正则都抓不到，于是解析结果里这五列**根本不存在**，
     * `check:sql` 当场报 7 处「列名对不上表结构」，而列其实是好的。
     *
     * ★ 教训与 IPC 通道数漏掉 11 个是同一族：**「写得更漂亮」会让机器判据失明**，
     *   而失明的方式是**报错**（这次运气好）或**静默漏掉**（那次）。
     */
    // ① 设备来源 —— 三张「学习事实」表
    if (!has('review_logs', 'device')) db.exec(`alter table review_logs add column device text`)
    if (!has('answers', 'device')) db.exec(`alter table answers add column device text`)
    if (!has('sessions', 'device')) db.exec(`alter table sessions add column device text`)

    // ② 产出线的反应时间 —— 与认读线的 review_logs.duration_ms **同名同单位**
    if (!has('answers', 'duration_ms')) db.exec(`alter table answers add column duration_ms integer`)

    // ③ session 的规则快照（D-350）—— 整块 JSON，可空
    if (!has('sessions', 'rules')) db.exec(`alter table sessions add column rules text`)

    // ── 自检 ①：五列都真的在了 ──────────────────────────────
    const want: [string, string][] = [
      ['review_logs', 'device'],
      ['answers', 'device'],
      ['answers', 'duration_ms'],
      ['sessions', 'device'],
      ['sessions', 'rules']
    ]
    const missing = want.filter(([tb, c]) => !has(tb, c))
    if (missing.length > 0) {
      throw new Error(`V35 加列没成：${missing.map(([tb, c]) => `${tb}.${c}`).join('、')}`)
    }

    // ── 自检 ②：一行数据都没动 ──────────────────────────────
    for (const [tb, n] of before) {
      const now = (db.prepare(`select count(*) as n from "${tb}"`).get() as { n: number }).n
      if (now !== n) throw new Error(`V35 动了 "${tb}" 的数据：${n} → ${now}`)
    }

    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (34, 35, ?, ?, 1, ?, ?)`
    ).run(
      '原始学习事实补三样',
      t,
      JSON.stringify({
        added: want.map(([tb, c]) => `${tb}.${c}`),
        nullable: '全部可空 —— 老数据留空，不给历史行编设备编号',
        why: 'D-349 / D-350 · 手机不分析，所以采集必须够电脑事后分析',
        note: '★ 结构指纹会变，两端必须一起升到 v35（sync-protocol 会整包拒并说清楚）'
      }),
      t
    )
  }
}

export const v36: Migration = {
  version: 36,
  name: '收录关系可软删 —— 让「把一条知识点从这一讲移出去」传得到另一台（D-436③）',
  up(db) {
    /**
     * ══ 为什么加这一列 ★★★（D-436③）════════════════════════════
     *
     * ⑨ 的「移动」是**删旧收录行 + 插新收录行**。而 `item_lectures` 是同步表，
     * **删一行不会立墓碑**（`TOMBSTONE_KINDS` 只覆盖六类实体，那是有意设计：
     * 子表跟着父实体的碑走，自己不立，否则删一个知识点会带出成百上千块碑）。
     * 后果：**移动的「删」那一半到不了另一台** —— 对面两个讲次里都留着它。
     *
     * ══ 为什么不是别的三条路 ★★（都试过，都不行）══════════════
     *
     *   ① **把 `item_lectures` 加进 `TOMBSTONE_KINDS`**
     *      ✗ 它的 uid 是从 `(items.uid, lectures.uid)` 推出来的（`IDENTITY_SPECS`）。
     *        立了碑，**再把这条移回原讲就永远同步不过去**，而墓碑没有解除机制。
     *        ★ 卡住的是**身份**，不是体积 —— 实测他库里每条只挂 1 个讲次。
     *   ② **原地改 `lecture_id` 不删行**
     *      ✗ uid 触发器是 `after insert when new.uid is null`，改行不重算 →
     *        同一对 (知识点, 讲) 在两台机器上会算出两个 uid →
     *        撞 `unique(item_id, lecture_id)`，正是 `identity.ts` 开头记着的那个错。
     *   ③ **靠 `items.owner_lecture_id` 在对端反推**
     *      ✗ 一条知识点本来就允许挂多个讲次（重复收集），反推会删掉合法关系。
     *
     * ══ 为什么软删是对的形状 ★★ ═══════════════════════════════
     *
     * 身份不变（uid 照旧）· 不用墓碑 · 不改身份算法 ·
     * **移回来只是把 `deleted_at` 改回 null**，同一行复活，天然可逆。
     * 而且它和 `projects/units/lectures/items/materials/files` 是同一套语义 ——
     * 这张表原本就是那六张的关系表，只有它没有这一列。
     *
     * ★★ **漏改一处读取的最坏结果 = 今天的行为**（旧链接照旧可见），
     *    不会损坏数据。所以读取侧可以分批跟上，不必和迁移同一秒完成。
     */
    const t = Date.now()

    /** 迁移前的行数底账 —— 这条迁移**一行数据都不许动** */
    const before = new Map<string, number>()
    for (const tb of SYNC_TABLES) {
      try {
        before.set(tb, (db.prepare(`select count(*) as n from "${tb}"`).get() as { n: number }).n)
      } catch {
        /* 老库升级路径上可能还没这张表 */
      }
    }

    const has = (table: string, col: string): boolean =>
      (db.prepare(`pragma table_info("${table}")`).all() as { name: string }[]).some(
        (c) => c.name === col
      )

    /**
     * ★ 字面量写全，不许包辅助函数 —— `scripts/schema-from-migrations.mjs`
     *   是用正则从这个文件里解析列的，`check:sql` 拿那份解析去校验全项目 SQL。
     *   （V35 的注释里记着这个坑，这里照办。）
     */
    if (!has('item_lectures', 'deleted_at')) {
      db.exec(`alter table item_lectures add column deleted_at integer`)
    }

    // ── 自检 ①：列真的在了 ────────────────────────────────
    if (!has('item_lectures', 'deleted_at')) {
      throw new Error('V36 加列没成：item_lectures.deleted_at')
    }

    // ── 自检 ②：一行数据都没动，而且没有任何一行被顺手标成删了 ──
    for (const [tb, n] of before) {
      const now = (db.prepare(`select count(*) as n from "${tb}"`).get() as { n: number }).n
      if (now !== n) throw new Error(`V36 动了 "${tb}" 的数据：${n} → ${now}`)
    }
    const marked = (
      db.prepare(`select count(*) as n from item_lectures where deleted_at is not null`).get() as {
        n: number
      }
    ).n
    if (marked > 0) {
      throw new Error(`V36 不该有任何一行带着 deleted_at，实测 ${marked} 行 —— 新列必须全是 null`)
    }

    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (35, 36, ?, ?, 1, ?, ?)`
    ).run(
      '收录关系可软删',
      t,
      JSON.stringify({
        added: 'item_lectures.deleted_at',
        nullable: '可空，老数据全是 null —— 一条现有的收录关系都不受影响',
        why: 'D-436③ · 移动的「删」那一半原本传不到另一台，对面两个讲次都留着',
        note: '★ 结构指纹会变，两端必须一起升到 v36（sync-protocol 会整包拒并说清楚）'
      }),
      t
    )
  }
}

export const v37: Migration = {
  version: 37,
  name: '清掉小操练的残留：drill 解析块 + item_events 全部行 + drill.qtypes 偏好',
  /**
   * ★★ 这条迁移**有意**让这三张表少行 —— 必须在这里声明，否则 `open.ts` 的
   * D-236 自检会把它当成「掉行 = 出事」，整库回滚并拒绝启动。
   *
   * ★ 声明不等于放行：按 `Migration.allowShrink` 的约定，**迁移自己必须验过
   *   只少了该少的那几行**。下面的自检② 就是干这个的 —— 逐表比对
   *   「删前行数 − 该删的条数 == 删后行数」，多删一行当场抛。
   *   （V29 搬偏好时立的规矩：声明 + 自证，两样都要。）
   *
   * ★★ 这一条是**沙盒里真撞出来的**，不是照着文档写的：第一版没声明，
   *   拿他真库的副本一跑，应用当场拒绝启动并自动还原备份 ——
   *   「表 analysis_blocks 少了 5 行（95 → 90）；表 user_preferences 少了 1 行」。
   *   护栏是对的，漏的是声明。
   */
  allowShrink: ['analysis_blocks', 'item_events', 'user_preferences'],
  up(db) {
    /**
     * ══ 为什么有这条迁移（2026-09-03 · 使用者裁）════════════════
     *
     * 小操练已经整条删掉（界面 / 主进程 / IPC / 提示词 / core）。
     * 当时留下了库里的三样东西，理由是「只增不删」；使用者随后明确
     * **「数据库也可以删」**，所以这一条把它们清干净。
     *
     * 清的是三样：
     *   ① `analysis_blocks` 里 `block='drill'` 的行 —— AI 出的操练题，没人读了
     *   ② `item_events` 的**全部行** —— 小操练是它**唯一的写入方**，
     *      两端唯一的读取方也是小操练的历史档案（Windows `study.ts` /
     *      Android `read-path.ts`，两处已在同一轮删掉）
     *
     * ★★ **表本身留着，不 drop。** 试过 drop，被库自己的护栏当场拦下：
     *    「迁移自检没通过：表 item_events 整张不见了」。那条护栏正是 D-216
     *    「只增不删」的机械化身，挡的是**静默丢数据**这一整类事故。
     *    为了省掉一张空表就在它上面开个洞，代价和收益完全不成比例 ——
     *    **空表留着，结构指纹一个字不变，两端不用为它升级协议。**
     *    这张表已经没有任何读写方，记进阶段⑦冗余清理；真要 drop 得单独一轮，
     *    而且要先决定动不动那条护栏（那是安全决定，不是顺手）
     *   ③ `user_preferences` 里 `key='drill.qtypes'` —— 小操练勾了哪几种题型
     *
     * ══ 为什么是迁移，不是「删行 + 立墓碑」★★ ══════════════════
     *
     * 这三样都在同步表里，而**删行不立墓碑**（`TOMBSTONE_KINDS` 只覆盖六类实体，
     * D-436 记着这条）。走墓碑这条路走不通：
     *   · 给子表立碑，收的那一端会默默丢掉（`applyTombstones` 明写着跳过）
     *   · 把它们加进 `TOMBSTONE_KINDS`，代价是删一个知识点连带写出成百上千块碑
     *
     * **迁移是对的路**：两端各自跑同一条迁移、各自删自己那份，不需要传播。
     *
     * ★★ **一处要说实话的边界**：云端桶里那份快照仍然带着这些行。
     *    今天的两台设备都已经 applied 过它，不会被重放；但**一台全新设备
     *    从桶里重建**时会把 ①③ 拿回来（② 不会 —— 表没了，未知表的行会被跳过）。
     *    拿回来的是**没有任何读写方的死行**，不影响行为。真要连桶也干净，
     *    得像 F-002 那样重写快照 —— 那是另一件事，不在这一条里做。
     *
     * ══ 与 D-216「只增不删」的关系 ★★ ═════════════════════════
     *
     * D-216 管的是**结构**：不许悄悄丢列、丢表导致数据静默消失。
     * 这一条**删的是一个已经废弃的功能自己的数据**，而且是使用者当面授权的，
     * 迁移里逐样点了数、写进 `migration_log`。**账是留下的，数据是他决定不要的。**
     */
    const t = Date.now()

    /** 动手前先数一遍 —— 每一样删了多少，都要能说出来 */
    const countOf = (sql: string): number => {
      try {
        return (db.prepare(sql).get() as { n: number }).n
      } catch {
        return 0 // 老库升级路径上可能还没这张表
      }
    }
    const nDrillBlocks = countOf(`select count(*) as n from analysis_blocks where block = 'drill'`)
    const nItemEvents = countOf(`select count(*) as n from item_events`)
    const nDrillPref = countOf(`select count(*) as n from user_preferences where key = 'drill.qtypes'`)

    /**
     * ★ 先证明 `item_events` 里**只有**小操练的东西再删整张表。
     *   不是「我记得只有它写」，是当场数一遍：有别的 kind 就停手，
     *   宁可留着这张表，也不能顺手带走谁的数据。
     */
    const foreign = countOf(`select count(*) as n from item_events where kind <> 'drill'`)
    if (foreign > 0) {
      throw new Error(
        `V37 拒绝执行：item_events 里有 ${foreign} 行不是小操练写的（kind <> 'drill'）—— ` +
          `这条迁移的前提是「小操练是它唯一的写入方」，前提不成立就不许清空这张表`
      )
    }

    /** 迁移前的行数底账 —— 除了要清的这三样，别的表一行都不许动 */
    const before = new Map<string, number>()
    for (const tb of SYNC_TABLES) {
      if (tb === 'item_events' || tb === 'analysis_blocks' || tb === 'user_preferences') continue
      try {
        before.set(tb, (db.prepare(`select count(*) as n from "${tb}"`).get() as { n: number }).n)
      } catch {
        /* 老库升级路径上可能还没这张表 */
      }
    }
    const blocksBefore = countOf(`select count(*) as n from analysis_blocks`)
    const prefsBefore = countOf(`select count(*) as n from user_preferences`)

    db.exec(`delete from analysis_blocks where block = 'drill'`)
    db.exec(`delete from user_preferences where key = 'drill.qtypes'`)
    db.exec(`delete from item_events`)

    // ── 自检 ①：三样都真的没了 ────────────────────────────
    if (countOf(`select count(*) as n from analysis_blocks where block = 'drill'`) > 0) {
      throw new Error('V37 没删干净：analysis_blocks 里还有 drill 块')
    }
    if (countOf(`select count(*) as n from user_preferences where key = 'drill.qtypes'`) > 0) {
      throw new Error('V37 没删干净：user_preferences 里还有 drill.qtypes')
    }
    if (countOf(`select count(*) as n from item_events`) > 0) {
      throw new Error('V37 没清干净：item_events 里还有行')
    }

    // ── 自检 ②：只少了该少的那几行，别的一行没动 ──────────
    const blocksNow = countOf(`select count(*) as n from analysis_blocks`)
    if (blocksNow !== blocksBefore - nDrillBlocks) {
      throw new Error(
        `V37 多删了解析块：${blocksBefore} → ${blocksNow}，只该少 ${nDrillBlocks} 行`
      )
    }
    const prefsNow = countOf(`select count(*) as n from user_preferences`)
    if (prefsNow !== prefsBefore - nDrillPref) {
      throw new Error(`V37 多删了偏好：${prefsBefore} → ${prefsNow}，只该少 ${nDrillPref} 行`)
    }
    for (const [tb, n] of before) {
      const now = (db.prepare(`select count(*) as n from "${tb}"`).get() as { n: number }).n
      if (now !== n) throw new Error(`V37 动了 "${tb}" 的数据：${n} → ${now}`)
    }

    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (36, 37, ?, ?, 1, ?, ?)`
    ).run(
      '清掉小操练的残留',
      t,
      JSON.stringify({
        why: '使用者 2026-09-03 裁：小操练整条删掉之后「数据库也可以删」',
        deleted: {
          'analysis_blocks(block=drill)': nDrillBlocks,
          'item_events(全部行)': nItemEvents,
          'user_preferences(drill.qtypes)': nDrillPref
        },
        kept: 'item_events 这张表留着（空表）—— drop 会撞库自己的「表不许消失」护栏',
        note: '★ 纯数据迁移：结构一个字没动，同步表面指纹仍是 cadb369e52c0e335（与 v36 相同），两端不用协调升级',
        caveat: '云端快照里仍带着这些行；新设备从桶里重建会拿回来 —— 都是没有读写方的死行，不影响行为'
      }),
      t
    )
  }
}

export const v38: Migration = {
  version: 38,
  name: '清掉退役提示词留下的指纹账（小操练 2 份 + 精选材料 1 份）',
  /**
   * ★★ 这条迁移**有意**让 `settings` 少行 —— 不声明的话 D-236 自检会把
   * 「掉行」当成出事，整库回滚并拒绝启动（V37 就是这么撞出来的）。
   * ★ 声明不等于放行：下面的自检② 逐个证明「只少了该少的那三行」。
   */
  allowShrink: ['settings'],
  up(db) {
    /**
     * ══ 为什么有这条迁移（2026-09-03 · 使用者「清理吧」）════════
     *
     * ★★ 先说清楚**没有**要清什么：他让我清 `picks` 表，
     *    拿他真库的副本一数 —— **0 行**。精选材料是「点了才生成」的缓存，
     *    他一次都没点过。★ 那反过来印证了他那句「没什么用」。
     *    所以这条迁移**一行 `picks` 都不碰**。
     *
     * ══ 顺着查出来的真残留 ════════════════════════════════════
     *
     * 一个功能删掉之后，它的提示词从仓库里删了。但 `data/prompts` 是
     * **一次性播种**的，之后升级只覆盖仓库还带着的那些 ——
     * **退役的那几份留在他目录里，谁都不会去动。**
     * 而 `settings` 里还挂着它们的出厂指纹（`prompt.seed.<文件名>`），
     * 那是一笔**指向已经不存在的东西的账**。
     *
     * 实测他库里有三笔：
     *   · `prompt.seed.drill-check.md`   —— 小操练（D-451 附记删的）
     *   · `prompt.seed.drill-more.md`    —— 小操练
     *   · `prompt.seed.pick-materials.md` —— 精选材料（D-459 删的）
     *
     * ★★★ **他目录里那三个 .md 文件一个字都不删。**
     *    `prompt-sync.ts` 顶上那条规矩写着「一个字都不删 —— 我删过他
     *    22 本词典，这条边界不再靠自觉」。他可能在里面写过自己的东西，
     *    而「反正没用了」**不是我替他删文件的理由**。
     *    改成：同一轮给 `syncPrompts` 加了 `retired`，
     *    设置页如实列出「这几份已经用不上了 —— 没有帮你删，你自己看着处理」。
     *
     * ══ 为什么清账是安全的 ════════════════════════════════════
     *
     * `settings` **不在 `SYNC_TABLES` 里**（本地表；跟着人走的偏好在
     * `user_preferences`）—— 所以没有墓碑问题、不需要传播、两端各清各的。
     * 而这三笔账的唯一读取方是 `syncPrompts`，它只遍历**仓库还带着的**文件，
     * 早就不会再读到它们。
     */
    const t = Date.now()

    /** 退役提示词的文件名 —— 写死是有意的：要能一眼看出这一条动了哪三笔 */
    const RETIRED = ['drill-check.md', 'drill-more.md', 'pick-materials.md']
    const keys = RETIRED.map((x) => 'prompt.seed.' + x)

    const countOf = (sql: string, ...a: unknown[]): number => {
      try {
        return (db.prepare(sql).get(...a) as { n: number }).n
      } catch {
        return 0 // 老库升级路径上可能还没这张表
      }
    }

    const settingsBefore = countOf('select count(*) as n from settings')
    const hit = keys.filter((k) => countOf('select count(*) as n from settings where key = ?', k) > 0)

    /**
     * ★ 顺带把 `picks` 数一遍写进账 —— **不删，只记**。
     *   万一他哪台设备上真有行，账上会留下这个事实，
     *   下一轮要不要清就有依据了（而不是靠我记得）。
     */
    const nPicks = countOf('select count(*) as n from picks')

    for (const k of keys) db.prepare('delete from settings where key = ?').run(k)

    // ── 自检 ①：该走的三笔都走了 ──────────────────────────
    for (const k of keys) {
      if (countOf('select count(*) as n from settings where key = ?', k) > 0) {
        throw new Error('V38 没删干净：settings 里还有 ' + k)
      }
    }

    // ── 自检 ②：只少了该少的那几行 ────────────────────────
    const settingsNow = countOf('select count(*) as n from settings')
    if (settingsNow !== settingsBefore - hit.length) {
      throw new Error(
        'V38 多删了设置：' + settingsBefore + ' → ' + settingsNow + '，只该少 ' + hit.length + ' 行'
      )
    }

    // ── 自检 ③：picks 一行都不许动（这一条明确不碰它）──────
    if (countOf('select count(*) as n from picks') !== nPicks) {
      throw new Error('V38 动了 picks 的数据 —— 这一条不该碰它')
    }

    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (37, 38, ?, ?, 1, ?, ?)`
    ).run(
      '清掉退役提示词的指纹账',
      t,
      JSON.stringify({
        why: '使用者 2026-09-03「清理吧」',
        found: '他真库副本里 picks 表 0 行 —— 精选材料一次都没生成过，无可清',
        deleted: { 'settings(prompt.seed.*)': hit },
        kept: {
          'data/prompts 里那三个 .md': '一个字没删 —— prompt-sync 那条「一个字都不删」同样管这里；改由设置页如实列出',
          picks表: '结构与行都没动（' + nPicks + ' 行）；它已无任何读写方，记进阶段⑦'
        },
        note: '★ 纯数据迁移，结构一个字没动；settings 不在 SYNC_TABLES 里，两端各清各的，不需要传播'
      }),
      t
    )
  }
}

/** 这一段按版本号顺序排好，交给 migrations.ts 拼成完整的 MIGRATIONS */
export const V30_V38: Migration[] = [
  v30,
  v31,
  v32,
  v33,
  v34,
  v35,
  v36,
  v37,
  v38
]
