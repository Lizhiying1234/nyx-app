/**
 * V20 ～ V29 · 跨设备身份归一（R-4-G）· user_preferences · 同步密钥 · uid 主键 · T-4.6 拆分（2026-09-06）
 *
 * ★ **正文一个字符没改**（D-216 第 4 条：写好的 up() 从此不许动；
 *   D-461：改了就要重生成 schema/vNN.sql 与同步基线）。
 *   搬动只换了外壳：`MIGRATIONS.push({` → `export const vNN: Migration = {`，
 *   收尾的 `})` → `}`。两者都在第 0 列、正文都在第 2 列，所以一行都没重新缩进。
 * ★ 顺序由本文件末尾那个数组固定，再由 migrations.ts 按段拼起来。
 */

import { BUILTIN_TABLES, canonicalUid } from '@core/builtin-identity.ts'
import { IDENTITY_SPECS, uidTriggerSql } from '@core/identity.ts'
import type { IdentitySpec } from '@core/identity.ts'
import { checkPrefValueOf, prefUid, type PrefSpec } from '@core/prefs.ts'
import { PARAM_SPEC } from '../../params.ts'
import { BUILTIN_IDENTITY_KEY } from './keys.ts'
import type { Migration } from './types.ts'

export const v20: Migration = {
  version: 20,
  name: 'builtin 的跨设备身份归一（R-4-G）',
  up(db) {
    /**
     * ★★ R-4-G · 让「同一个出厂内容在两台设备上是同一个对象」成立。
     *
     * 病根写在 `core/builtin-identity.ts` 的头上，这里只做一件事：
     * 把 `builtin = 1` 的行的 `uid` 换成那份纯函数算出来的确定值。
     *
     * ── 这一步碰什么、绝不碰什么 ──────────────────────────
     *
     * 碰：`uid`；以及 **pristine 那些行的** `updated_at`。
     *
     * ── `updated_at = 0` 是什么意思 ★★ ────────────────────
     *
     * `builtin = 1` 只表示「这是软件出厂给的对象」。
     * `updated_at` 表示「这一行最后一次发生**需要跨设备传播的本地变更**」。
     * 出厂那一刻不是变更 —— 两台设备各自播种同一份出厂内容，
     * 没有任何东西需要传给对方。所以基准值是 **0**。
     *
     * 不这么做的话：A 的出厂导师 `updated_at = A 迁移那一刻`，
     * B 的是 `B 迁移那一刻`，两边 uid 归一之后成了「同一行」，
     * 却因为时间戳不同、且都 > 水位 0，**第一次同步就是 22 处冲突** ——
     * 而那 22 条他一个都没碰过。（实测过，就是这个数。）
     *
     * ── 只对「从没被改过」的行写 0 ★★ ─────────────────────
     *
     * 判据不是猜的：**播种时 `created_at` 和 `updated_at` 写的是同一个值**，
     * 而全部 13 条用户修改入口（改名 / 改内容 / 开关 / 重排 / 软删 / 恢复 /
     * 设默认）**没有一条会动 `created_at`**（逐条追过调用链）。
     * 所以 `created_at === updated_at` ⟺ 这一行自入库起没有被改过。
     *
     * 改过的一律**保留原 `updated_at`**。抹掉真实修改历史比留下一次冲突严重得多 ——
     * 那等于把他的修改从同步里吞掉。他真实库里就有一条：
     * qtypes 第 7 行「错误订正」，改动发生在入库之后约 4 分 51 秒。
     *
     * **V20 绝不伪造一次「用户修改」，也绝不抹掉一次真实的。**
     *
     * 不碰：`id` / `name` / `key` / `sort` / `deleted_at` / 内容 / 任何用户字段。
     * 尤其**不碰 `builtin = 0` 的行** —— 那是他自己建的，
     * 他真实库里那个导师已经改名叫 Lumen 了，一个字都不许动。
     *
     * **不新建任何行。** 他那台机器的 `prompt_presets` 是空的，
     * 这一步就该在那张表上什么都不做 —— 补种是 `ensureBuiltins` 的职责，
     * 让启动流程按它自己的判据去补，不要在迁移里抢它的活。
     *
     * ── 序位为什么把软删的也算进去 ────────────────────────
     *
     * 软删的行还是那一行，只是被删了。另一台设备上同一行可能没删 ——
     * 序位两边必须一致才对得上，所以按 `sort, id` 排**全部** `builtin = 1` 的行。
     *
     * ── 原子性 ────────────────────────────────────────────
     *
     * `open.ts` 把所有待跑的迁移包在**一个事务**里，失败整体回滚 +
     * 用升级前的备份还原（D-236）。所以这里**不吞任何异常** ——
     * 出现「四张表改了两张」那种半迁移状态，比升级失败严重得多。
     */
    const t = Date.now()
    const problems: { table: string; id: number; want: string; why: string }[] = []

    for (const table of BUILTIN_TABLES) {
      const cols = (db.prepare(`pragma table_info("${table}")`).all() as { name: string }[]).map(
        (c) => c.name
      )
      // 表还没建出来（老库回放）就跳过，别让整次升级挂掉
      if (cols.length === 0 || !cols.includes('uid') || !cols.includes('builtin')) continue

      const hasKey = cols.includes('key')
      const rows = db
        .prepare(
          `select id, uid, sort, created_at as createdAt, updated_at as updatedAt${
            hasKey ? ', key' : ''
          } from "${table}"
            where builtin = 1 order by sort, id`
        )
        .all() as {
        id: number
        uid: string | null
        sort: number
        createdAt: number
        updatedAt: number
        key?: string
      }[]

      const up = db.prepare(`update "${table}" set uid = ?, updated_at = ? where id = ?`)
      const byUid = db.prepare(`select id from "${table}" where uid = ?`)

      let ordinal = 0
      for (const r of rows) {
        ordinal += 1
        const want = canonicalUid(table, { builtin: 1, key: r.key ?? null, ordinal })
        if (!want) {
          problems.push({ table, id: r.id, want: '', why: '算不出跨设备身份（key 空？）' })
          continue
        }
        /**
         * pristine：入库之后一次都没被改过 → 归一到共同基准 `0`。
         * 改过的：**原样保留它的 `updated_at`**，那是真实的用户变更时间。
         */
        const pristine = r.createdAt === r.updatedAt
        const stamp = pristine ? 0 : r.updatedAt

        // 身份和时间戳都已经到位了 —— 再跑一次就是空转（幂等）
        if (r.uid === want && r.updatedAt === stamp) continue

        /**
         * 这个 canonical 身份已经被**别的行**占着了。
         *
         * 正常路径上不可能（序位逐个递增、`qtypes.key` 有唯一索引），
         * 但手工改过的库、导回的怪备份都可能造出来。
         * **保留原样、记一笔**：为了让迁移「成功」而擅自挑一个删掉另一个，
         * 是拿他的数据去换一次干净的升级。
         */
        const other = byUid.get(want) as { id: number } | undefined
        if (other && other.id !== r.id) {
          problems.push({
            table,
            id: r.id,
            want,
            why: `这个身份已经被第 ${other.id} 行占着 —— 保留原样，没有合并、没有删除`
          })
          continue
        }
        up.run(want, stamp, r.id)
      }
    }

    if (problems.length > 0) {
      db.prepare(
        `insert into settings (key, value, updated_at) values (?, ?, ?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
      ).run(BUILTIN_IDENTITY_KEY, JSON.stringify({ at: t, problems }), t)
    } else {
      db.prepare(`delete from settings where key = ?`).run(BUILTIN_IDENTITY_KEY)
    }
  }
}

export const v21: Migration = {
  version: 21,
  name: '墓碑：硬删掉的东西不许被旧同步包复活（R-3）',
  up(db) {
    /**
     * ★★ R-3 · 病根写在 `core/tombstone.ts` 头上，这里只建表。
     *
     * ── 两个 uid，不要搞混 ────────────────────────────────
     *
     *   `uid`        —— **墓碑自己**的跨设备身份，触发器生成。
     *                   有了它，墓碑才能像普通行一样被同步过去。
     *   `target_uid` —— **被终结的那一行**的 uid。判据用的是它。
     *
     * 名字这么排是有原因的：同步机制（`localRow` / `collectSince` /
     * 唯一索引 / 触发器）全都写死认 `uid` 这一列。墓碑要想不写一行特例地
     * 混进那套机制里，它自己的身份就必须叫 `uid`。
     *
     * ── 为什么不是给实体表加一列 `purged_at` ──────────────
     *
     * 因为那一行本身要被删掉。`deleted_at` 是**行上的可变状态**
     * （软删，可逆）；`purged_at` 是**行消失之后留下的独立事实**（不可逆）。
     * 两者不是同一件事的两个阶段。
     */
    db.exec(`
      create table if not exists tombstones (
        id         integer primary key autoincrement,
        uid        text,
        target_uid text    not null,
        kind       text    not null,
        purged_at  integer not null,
        created_at integer not null,
        updated_at integer not null
      );
      create unique index if not exists idx_tombstones_target on tombstones (target_uid, kind);
      create index if not exists idx_tombstones_purged on tombstones (purged_at);
    `)

    // uid 的唯一索引与触发器要在这里自己补 —— V9 遍历 SYNC_TABLES 时这张表还不存在
    db.exec(`update tombstones set uid = 'tombstones-' || lower(hex(randomblob(8))) where uid is null`)
    db.exec(`create unique index if not exists idx_tombstones_uid on tombstones (uid)`)
    db.exec(`
      create trigger if not exists trg_tombstones_uid after insert on tombstones
        when new.uid is null
      begin
        update tombstones set uid = 'tombstones-' || lower(hex(randomblob(8)))
         where rowid = new.rowid;
      end;
    `)

    /**
     * ★ 这张表**建立之前**删掉的东西没有墓碑，补不出来 ——
     * 库里已经不剩任何痕迹了。所以升级之后的保证是
     * 「从今往后删的都挡得住」，不是「以前删的也挡得住」。
     * 这一点必须说清楚，不能让人以为升一下级历史就干净了。
     */
  }
}

export const v22: Migration = {
  version: 22,
  name: '账本的撤销是一条事实，不是一次删除（R-3-e）',
  up(db) {
    /**
     * ★★ R-3-e · 「我改主意了」这句话要能传到另一台机器上。
     *
     * ── 病 ────────────────────────────────────────────────
     *
     * 他从垃圾箱里把一条表达捡回来，`forget()` 走的是
     * `delete from term_ledger` —— 撤销之后本地和「从来没记过」
     * **逐字节相同**，没有任何东西可以推给另一台设备。
     * 于是 B 上那条「以后别再收它」永久留着：他在 B 上重新分析同一篇文章，
     * 那条表达仍然进不来，而他刚刚才明确把它捡回来。
     *
     * 这和 R-3 是同一个形状（删掉之后不留痕迹），但**不能用同一副药**：
     * 墓碑说的是「这个身份被终结了」，不可逆；
     * 而这里的事实是「这条意图作废了」——他今天删、明天捡回来、
     * 后天又删，账本必须跟得上。
     *
     * ── 药：一列 ──────────────────────────────────────────
     *
     *   行不存在                    从来没处理过这个说法
     *   行在 · revoked_at is null   这条意图**当前有效**
     *   行在 · revoked_at = T       他在 T 撤回了这条意图
     *
     * 撤销从此是一次**普通的行更新**（改 `revoked_at` + `updated_at`），
     * 而 `term_ledger` 本来就在 `SYNC_TABLES` 里 ——
     * 它自己就会走过去，同步那一层一行代码都不用改。
     *
     * ── 这次迁移不碰什么 ──────────────────────────────────
     *
     * `norm` / `term` / `verdict` / `lecture_id` / `created_at` / `updated_at`
     * 一个字都不动。现存的行 `revoked_at` 默认 null，也就是「当前有效」——
     * 这正是它们本来的意思，不需要任何回填。
     *
     * ★ **升级之前已经被 DELETE 掉的那些撤销，补不回来。**
     * 本地已经不剩任何痕迹了。所以这条的保证是
     * 「从今往后撤的都传得过去」，不是「以前撤的也能补上」。
     * 和 V21 墓碑那句话是同一个道理，不要让人以为升一下级历史就干净了。
     */
    const cols = (db.prepare(`pragma table_info("term_ledger")`).all() as { name: string }[]).map(
      (c) => c.name
    )
    if (cols.length === 0) return // 表还不存在（老库回放），跳过
    if (cols.includes('revoked_at')) return
    db.exec(`alter table term_ledger add column revoked_at integer`)
    db.exec(`create index if not exists idx_ledger_live on term_ledger(norm, revoked_at)`)
  }
}

export const v23: Migration = {
  version: 23,
  name: '墓碑记下父实体的 id，好认出它的孩子（R-3-g）',
  up(db) {
    /**
     * ★★ R-3-g · 派生子行是按 **id** 指向父亲的（`review_logs.item_id = 1`），
     * 而墓碑原来只记了 `target_uid`。两边对不上号 ——
     * 拿到一条子行根本没法问出「你爹是不是那块碑」。
     *
     * 于是父实体被终结之后，云端老包里那些子行有两种下场（都实测过）：
     *   · 有外键的 → `FOREIGN KEY constraint failed` → 算失败 →
     *     **那一包永远不进 `applied`，永远重试**，同步永远停在「没有完全成功」
     *   · 没外键的（只有 `picks`）→ 直接写进来，成了看不见的孤儿
     *
     * 补这一列的代价接近于零：`hardDelete` 本来就是按 id 删的，那个数字就在手里。
     *
     * ── 老碑怎么办 ────────────────────────────────────────
     *
     * V23 之前立的碑没有 id，**事后也补不出来**（父行早就没了）。
     * 不去翻 `ops_log`、不去猜 —— 猜一个 id 出来可能挡掉别人的孩子。
     * 它们保持 `target_id = null`，**不参与父级拦截**，
     * 并且由数据体检报出来，不让「永远重试」变成一种没人管的常态。
     *
     * 实际影响接近于零：他那台机器现在是 v18，`tombstones` 表还不存在，
     * 升级会 v18 → v23 一次跑完 —— **结构上产生不出老碑**。
     */
    const cols = (db.prepare(`pragma table_info("tombstones")`).all() as { name: string }[]).map(
      (c) => c.name
    )
    if (cols.length === 0) return
    if (cols.includes('target_id')) return
    db.exec(`alter table tombstones add column target_id integer`)
    db.exec(`create index if not exists idx_tombstones_parent on tombstones (kind, target_id)`)
  }
}

export const v24: Migration = {
  version: 24,
  name: '挂进轮转中那一讲的新条目，立刻拿到认读卡（F-2-②-a）',
  up(db) {
    /**
     * ★★ F-2-②-a · 新条目进了一条**已经在轮转**的讲，却永远拿不到认读卡。
     *
     * ── 病 ────────────────────────────────────────────────
     *
     * `card_due_at` 的初始化只有一个入口：`startLearning`。而那颗按钮只在
     * `status='review'` 时渲染 —— 一条已经在 `training` 的讲**不会再进那道门**。
     * 于是：
     *
     *   training 的讲 + 新条目 → `card_due_at = null` → **永远不进认读队列**
     *
     * 实测三条路径全中：`addChunks`（我的收集）、`addItem`（手动加）、
     * 同步从对面收到。三条都是「新条目 1 条 · 拿到认读卡 0 条」。
     * （分析那条路不受影响：分析成功会把讲打回 `review`，他再点「开始学」。）
     *
     * 表现是**静默失效** —— 界面上那几条好好地列在那儿，就是永远轮不到它们。
     * 他零编程经验，发现时早就过去很久了。
     *
     * ── 为什么用触发器，不在四个插入点各调一次 ────────────
     *
     * `insert into item_lectures` 有四处（repo 两处、analyze 两处），
     * 再加上同步的 `writeRows` 也走同一句。V9 给 uid 用触发器时写过一句话，
     * 这里一字不差地适用：
     *
     * > 「用**触发器**而不是去改几十处 insert —— 漏掉一处的后果是
     * >   那张表的那些行永远同步不出去，而且**不报错**。
     * >   触发器管的是所有插入，包括以后新写的代码。」
     *
     * ── 为什么用 `new.created_at` 而不是「现在」 ─────────────
     *
     * ① 首次认读时间和这条关系产生的时间一致 —— 分析、我的收集、手动添加、
     *    同步导入四条路共享同一个语义。
     * ② **确定性**：同一条关系同步到另一台设备，那边的触发器算出**同一个值**，
     *    两台机器不需要为此传一次数据，也不会各算各的。
     *
     * ── 为什么只发给 `source='self'` ★★ ────────────────────
     *
     * 这一条是和 **F-03 审阅门**撞出来的，不是想当然定的。
     *
     * F-2-① 之后分析**全程不动 status** —— 也就是说，重新分析一条在轮转中的讲时，
     * AI 提取的条目插进来的那一刻，这一讲**还是 `training`**。
     * 不加这个条件的话，那些他**还没审阅**的提取结果会当场拿到认读卡，
     * 而 F-03 那道门的全部意义就是「让他先看一遍、删掉不要的，点了才进轮转」。
     *
     * 判据用 `source`：
     *   · `'self'`        他自己贴的 / 手动加的 —— **本来就是他挑的，不需要再审一遍**
     *   · `'ai'` / `'both'` AI 提取的 —— 要过 F-03 那道门，等他点「开始学」
     *
     * 同步过来的行照样管用：另一台机器上「我的收集」贴的那条 `source='self'`，
     * 到了这边只要这一讲在轮转中，一样立刻发卡。
     *
     * ⚠ 一处已知的模糊：**析出项**（从他自己的整句里拆出来的成分）也是 `'self'`，
     * 于是它们现在会在审阅之前拿到认读卡。留给他裁决要不要收紧。
     *
     * ── 它绝不碰什么 ──────────────────────────────────────
     *
     * `lectures.due_at` / `lectures.interval_days` / 老条目的 `card_*` /
     * `attempts` / `corrects` / `streak` / `production_state` /
     * `answers` / `review_logs` / `sessions` —— 一个字都不动。
     * 它只干一件事：**新条目第一次进轮转中的讲时，把认读排期从空补上**。
     *
     * 连 `items.updated_at` 也不动：那个值一动就意味着「这一行变了、要推出去」，
     * 而另一台设备的触发器会自己算出同样的结果 —— 传它是白传。
     * 更要紧的是 `new.created_at` 可能比 `items.updated_at` **旧**
     * （同步导入一条老关系时就是这样），写回去等于让时间倒流，
     * 那一行会掉到水位之下、再也推不出去。
     */
    db.exec(`
      create trigger if not exists trg_il_reading_card after insert on item_lectures
        when exists (
          select 1 from lectures l
           where l.id = new.lecture_id
             and l.status = 'training'
             and l.silent = 0
             and l.deleted_at is null
        )
      begin
        update items set card_due_at = new.created_at
         where id = new.item_id
           and card_due_at is null
           and card_silent = 0
           and deleted_at is null
           and source = 'self';
      end;
    `)
  }
}

export const v25: Migration = {
  version: 25,
  name: '「用本地的」这个决定要能存住、传出去、导不回去（R-4-F-a）',
  up(db) {
    /**
     * ★★ R-4-F-a · 他选过「用本地的」，这件事必须是一条**落库、可同步、
     * 导回也退不回去**的事实。判据在 `core/resolution.ts`，这里只建表。
     *
     * ── 病 ────────────────────────────────────────────────
     *
     * R-4-F 之后冲突不再劫持整条流水线，但他的裁决**只靠 `applied` 那张
     * 500 个包名的缓存兜着**。缓存不是事实：
     *
     *   · `applied` 溢出（他同步得多了就会）→ 老包重下重放
     *   · 新设备从头拉 → 那些包对它全是新的
     *   · 导回一份旧备份 → `applied` 跟着退回去
     *
     * 三条路都会让「被他拒绝的那一版」重新出现。而那时水位早已越过它，
     * `decideRow` 走的是最后那一格「两边都没新改动，取新的那个」——
     * 云端那版时间戳更新（他选本地时通常就是这样），于是 **take-remote**：
     * 他明确拒绝过的内容悄悄盖掉了他留下的内容，一句话都不说。
     * 这正是 D-201「不静默覆盖」要防的那件事，只是晚了几天发生。
     *
     * ── 语义：这不是「永久拒绝这个对象」────────────────────
     *
     * `rejected_up_to` = **到这个时刻为止**的远端版本他都明确拒绝过。
     * 之后对面再改一次（时间戳更新）→ 那是一次新的分歧 → 照常问他。
     * 写成「永久拒绝」的话，两台机器从此再也无法就这一行达成一致。
     *
     * ── 为什么这张表**没有 `id`** ★★ ───────────────────────
     *
     * 项目里别的表都是 `id integer primary key autoincrement`，这张没有。
     * 理由是实测出来的：两台机器各自第一次裁决，各自拿到 `id = 1`，uid 不同。
     * 同步过去时
     *
     *   insert into resolutions (id, uid, ...) values (1, '...', ...)
     *     on conflict(uid) do update set ...
     *   → UNIQUE constraint failed: resolutions.id
     *
     * `on conflict(uid)` 是**指定索引**的，撞在主键上它不接管。
     * 那一行于是永远失败 → 那一包永远不进 `applied` → 「没有完全成功」永久挂着。
     *
     * 这张表没有任何东西需要按 id 引用（没有外键、不进级联、界面不显示），
     * 它的身份本来就是 uid。去掉 id 列，整类问题不存在。
     * （`tombstones` / `term_ledger` 现在还暴露在同一个风险下 —— 已记 R-3-h，不在本轮。）
     *
     * ── uid 是**算出来的**，不是随机的 ──────────────────────
     *
     * `resolutions-<target_uid>`。两台机器对同一对象的裁决落在同一个 uid 上，
     * 同步时天然合并成一行，不会长出第二条、也不会撞唯一索引。
     * `kind`（它在哪张表）只作诊断与可读性，身份只认 `target_uid`。
     */
    db.exec(`
      create table if not exists resolutions (
        uid            text    primary key not null,
        target_uid     text    not null,
        kind           text    not null,
        rejected_up_to integer not null,
        created_at     integer not null,
        updated_at     integer not null
      );
      create unique index if not exists idx_resolutions_target
        on resolutions (target_uid, kind);
    `)

    /**
     * ★★ **单调不回退，只此一处。**
     *
     * 写入口有三个：本机裁决、同步收到别人的裁决、导回时的合并。
     * 三处各写一个 `max()` 的话，迟早有一处漏掉，而漏掉的表现是
     * **他的决定被悄悄改小** —— 没有任何地方看得出来。
     *
     * 所以规则放在**表**上：任何一条 INSERT 只要这个 target 已经有裁决，
     * 就地取 max 合并，然后 `raise(ignore)` 把这次插入整个跳过。
     * 通用的 `writeRows`（`insert ... on conflict(uid) do update set 全部列`）
     * 因此**没有机会**把 `rejected_up_to` 改小 —— 它连插入都没发生。
     *
     * 实测：现有 5、来 3 → 仍是 5；现有 5、来 99 → 推进到 99。
     */
    db.exec(`
      create trigger if not exists trg_resolutions_merge before insert on resolutions
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
    `)

    /**
     * ★ 这张表**升级之后是空的**，不猜历史。
     *
     * V25 之前的裁决只活在一次 `run('local')` 的参数里，从来没落过库 ——
     * 库里不剩任何痕迹，补不出来。和 R-3（墓碑）、R-3-e（账本撤销）
     * 的历史边界完全一致：保证的是「从今往后的裁决存得住」，
     * 不是「以前的裁决也追得回来」。
     */
  }
}

export const v26: Migration = {
  version: 26,
  name: '他设过的「今日练习条数」跟着换键一起搬过来（V-1 legacy data migration gap）',
  up(db) {
    /**
     * ★★ V-1 补课 · 2026-08-17
     *
     * ── 病 ────────────────────────────────────────────────
     *
     * V-1 之前，首页的 +/− 把条数写进 `settings['daily.target']`，
     * 而读的那一侧（`Study.dailyTarget()` → `ParamStore`）读的是
     * `settings['param.dailyTarget']` —— **两个键从不相交**。
     * 表现是他当场那一屏对、重开就回到 35。
     *
     * V-1 把写入改走 `ParamStore`，从此写读同源。但那只修好了**以后**：
     * 他机器上那一行 `daily.target = 95` 原地不动，新键从来没被创建过，
     * 于是升级之后读到的仍是默认 35 —— **他设过的数就这么没了，一声不响。**
     *
     * 真机验收第 3 项就是撞在这里（2026-08-17，`D:\Nyx\data\nyx.db`：
     * 全库只有 `daily.target = 95` 一个键，`param.dailyTarget` 不存在）。
     *
     * ── 语义 ──────────────────────────────────────────────
     *
     * 两个键是**同一个产品概念**。`param.dailyTarget` 是唯一真相，
     * `daily.target` 是修复前留下的 legacy storage —— **不是无效数据**。
     * 所以这是一次搬家，不是一条新需求。
     *
     * ── 四条规矩 ──────────────────────────────────────────
     *
     * 1. **canonical 已经有值 → 一个字都不动。** 他升级后又设过一次的话，
     *    那次才是他现在的意思；拿旧值盖掉它就是第二次静默丢失。
     * 2. **钳位走 `ParamStore.set`，不在这里抄一遍 1/500。** 判据只能有一份 ——
     *    这个项目反复死在「同一条规则写了两处，然后漂了」。
     *    （代价：日后 SPEC 改了上下限，这条迁移的行为跟着变。那是对的：
     *      搬进来的值本来就该按**当下**的规则算数。）
     * 3. **legacy 不是有限数 → 不搬。** `ParamStore.raw()` 对非有限值的态度
     *    就是「当没有」，这里保持一致 —— 否则会写进一行 `NaN`，
     *    读的时候又回落默认，等于凭空多出一条永远读不到的脏数据。
     * 4. **搬完删掉 legacy 行。** 留着它就是留下第二个「看起来像真相」的东西，
     *    早晚有人去读。值已经在 canonical 里，删的是副本不是数据。
     *    （只删这一行；`settings` 表和别的键一概不碰。）
     */
    const legacy = db.prepare(`select value from settings where key = 'daily.target'`).get() as
      | { value: string }
      | undefined
    if (!legacy) return

    const canonical = db
      .prepare(`select value from settings where key = 'param.dailyTarget'`)
      .get() as { value: string } | undefined
    if (canonical) return // 规矩 1

    /**
     * ★ 空串要**当场挡掉**，不能只靠 `Number.isFinite`。
     *
     * `Number('')` 是 `0`（`'  '` 也是），有限得很 —— 于是它会被钳成 1，
     * 他一打开发现今日练习变成「1 条」。这不是「按 canonical 规则处理」，
     * 这是凭空发明了一个他没设过的值。空 = 没设过，和没有这一行是一回事。
     * （回归用例：`legacy=""` 必须回落 35。这一条是被那条用例逼出来的。）
     */
    const text = String(legacy.value).trim()
    if (text === '') return
    const n = Number(text)
    if (!Number.isFinite(n)) return // 规矩 3：搬不动就不搬，留着 legacy 行给人查

    // 规矩 2：钳位与四舍五入完全复用设置页那条路，不在迁移里另写一份
    /**
     * ★★ Step 5A 改：**历史迁移不许依赖将来才有的东西。**
     *
     * 这一句原来是 `new ParamStore(db).set('dailyTarget', n)` —— 当时
     * `ParamStore` 写的是 `settings`，同源没问题。V29 把偏好搬进
     * `user_preferences` 之后，`ParamStore.set` 也跟着改了写入目标，
     * 于是**一条 v25 的老库跑到 V26 时会去写一张 V29 才建的表**：
     *     no such table: user_preferences
     * 老库根本升不上来。
     *
     * 所以这里改成按 V26 **那个年代的** schema 直接写 `settings`，
     * 钳位规则仍然从 `ParamStore` 的 SPEC 取（判据还是只有一份），
     * 之后由 V29 把它搬进偏好表。
     *
     * 一般规矩：**migration 只许用它自己那一版就已经存在的结构**，
     * 不许调会随时间改变行为的业务类。
     */
    const spec = PARAM_SPEC.find((x) => x.key === 'dailyTarget')
    if (!spec) throw new Error('V26：找不到 dailyTarget 的参数规格')
    const clamped = Math.max(spec.min, Math.min(spec.max, Math.round(n)))
    db.prepare(
      `insert into settings (key, value, updated_at) values ('param.dailyTarget', ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    ).run(String(clamped), Date.now())

    // 规矩 4：确认 canonical 真落地了，才删副本 —— 顺序反了就是数据丢失
    const written = db
      .prepare(`select value from settings where key = 'param.dailyTarget'`)
      .get() as { value: string } | undefined
    if (!written) throw new Error('V26：canonical 没写进去，不能删 legacy')
    db.prepare(`delete from settings where key = 'daily.target'`).run()
  }
}

export const v27: Migration = {
  version: 27,
  name: '体裁与题型改用 uid 作主键 —— 第二台设备才不会永远同步失败（R-3-h）',
  up(db) {
    /**
     * ★★ R-3-h · 自增 `id` 不能当跨设备身份（2026-08-17 真机双端验收撞出来）
     *
     * ── 病 ────────────────────────────────────────────────
     *
     * 实测：A 是他的机器，B 是一台全新装的。
     *
     *   B 首次启动 → `builtins` 自愈补回 4 条内置体裁，
     *                uid 是 canonical 的 `genres-builtin-1..4`，占了 id 1–4
     *   A 上那 4 条早被他改过 → `builtin=0`、uid 是随机的 `genres-6477…`
     *   同步过去 → `insert … on conflict(uid) do update`
     *              uid 不同 → 走 INSERT → **id=1 已被占** → 撞的是主键
     *
     *   `on conflict(uid)` 是**指定索引**的冲突处理，撞在主键上它不接管。
     *
     *     UNIQUE constraint failed: genres.id     ×4，**永久**
     *
     * 连跑 4 次同步：16 → 5 → 4 → 4 → 4。不收敛。后果三条：
     *   · 他改过的体裁永远到不了第二台设备
     *   · `problems` 永久非空，同步页永远挂着「有问题」
     *   · 那一包永远进不了 `applied` → 每次同步把 825 行重拉一遍、重失败一遍
     *
     * ── 这个病 V25 就写下来了 ────────────────────────────
     *
     * `resolutions` 表当初**故意不设 `id`**，注释里逐字描述了同一个机理，
     * 末尾一句「`tombstones` / `term_ledger` 还暴露在同一个风险下，已记 R-3-h」。
     * **当时漏点了 `genres` 和 `qtypes`** —— 而这两张恰恰是每台新设备
     * 都会自动播种的表，所以它们才是真正必炸的那两张。
     *
     * ── 药：uid 就是主键，`id` 整列去掉 ─────────────────────
     *
     * 不在同步层加「撞了就重编号」那种第二套身份分配 ——
     * 那等于同一条规则写两处，而这个项目已经在这上面栽过太多次。
     * 走 `resolutions` 验证过的那条路：**身份只有 uid 一个**。
     *
     * 敢整列去掉 `id`，是因为查过：**没有任何表存过 genres/qtypes 的 id**
     * （`pragma foreign_key_list` 零命中，列名扫描只有 `questions.qtype_sig`，
     *   那是题型 key 的签名文本，不是 id）。`id` 只活在
     * 「界面选中 → 传给主进程 → 当场用完」这一条链路上，从不落库。
     * 题型在业务上的身份本来就是 `key`（`questions.type` 存的就是它）。
     */
    /**
     * ★ DDL **写成字面量，不用变量拼表名**。
     *   `check:sql` 的尺子（`scripts/schema-from-migrations.mjs`）靠正则读这个文件
     *   推出「库该长什么样」。表名一旦是 `${table}__new` 那种模板，它就读不到，
     *   于是尺子仍然以为 genres 有 `id` 列 —— 一把量错的尺子比没有尺子更坏。
     *   共用的只有下面那个「搬完当场核对」的检查。
     */
    const guard = (table: 'genres' | 'qtypes', before: number, uidsBefore: string) => {
      const after = db.prepare(`select count(*) as n from "${table}"`).get() as { n: number }
      if (after.n !== before) throw new Error(`V27 搬 ${table} 少了行：${before} → ${after.n}`)
      const uidsAfter = db
        .prepare(`select uid from "${table}" order by uid`)
        .all()
        .map((r) => (r as { uid: string }).uid)
        .join('|')
      if (uidsAfter !== uidsBefore) throw new Error(`V27 搬 ${table} 之后 uid 对不上`)
    }
    const snapshot = (table: 'genres' | 'qtypes'): { n: number; uids: string } => {
      // uid 为空的先补上 —— 老库靠 after-insert 触发器填 uid，
      // 理论上不会有空的，但主键不许空，宁可多这一句
      db.exec(`update ${table} set uid = '${table}-' || lower(hex(randomblob(8))) where uid is null`)
      return {
        n: (db.prepare(`select count(*) as n from "${table}"`).get() as { n: number }).n,
        uids: db
          .prepare(`select uid from "${table}" order by uid`)
          .all()
          .map((r) => (r as { uid: string }).uid)
          .join('|')
      }
    }

    // ── genres ────────────────────────────────────────────────
    const g0 = snapshot('genres')
    db.exec(`
      create table genres__new (
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
      insert into genres__new (uid, name, prompt, is_default, builtin, sort, deleted_at, created_at, updated_at)
        select uid, name, prompt, is_default, builtin, sort, deleted_at, created_at, updated_at from genres;
      drop table genres;
      alter table genres__new rename to genres;
      create index if not exists idx_genres_sort on genres(sort);
    `)
    guard('genres', g0.n, g0.uids)

    // ── qtypes ────────────────────────────────────────────────
    const q0 = snapshot('qtypes')
    db.exec(`
      create table qtypes__new (
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
      insert into qtypes__new (uid, key, name, tier, brief, guide, prompt, enabled, canonical, builtin, sort, deleted_at, created_at, updated_at)
        select uid, key, name, tier, brief, guide, prompt, enabled, canonical, builtin, sort, deleted_at, created_at, updated_at from qtypes;
      drop table qtypes;
      alter table qtypes__new rename to qtypes;
      create index if not exists idx_qtypes_sort on qtypes(tier, sort, uid);
      create unique index if not exists idx_qtypes_key on qtypes(key);
    `)
    guard('qtypes', q0.n, q0.uids)

    db.exec(`drop trigger if exists trg_genres_uid`)
    db.exec(`drop trigger if exists trg_qtypes_uid`)
  }
}

export const v28: Migration = {
  version: 28,
  name: '七张表的跨设备身份改由业务事实算出来（C-1 · 两台各做同一件事不再撞车）',
  up(db) {
    /**
     * ★★ Step 2 · C-1（D-280）
     *
     * ── 病 ────────────────────────────────────────────────
     *
     * uid 是触发器随机生成的，而这七张表**还带着 uid 之外的唯一性**。
     * 两台设备各自产生同一件业务事实 → 两个不同的随机 uid + 同一个业务键
     * → `on conflict(uid)` 不命中 → INSERT → 撞唯一约束 → **那一行永久失败**，
     * 那一包永远不进 `applied`，每一次同步都重试。
     *
     * 七条轴（前五条在真 schema 的副本上逐条复现过，后两条是重新全扫时找出来的）：
     *
     *   item_lectures    PK(item_id, lecture_id)                两台把同一条挂进同一讲
     *   analysis_blocks  UNIQUE(item_id, block)                 两台各自生成同一块解析
     *   drafts           UNIQUE(session_id, question_id)        两台各自存同一道题的草稿
     *   tombstones       UNIQUE(target_uid, kind)   ★           **两台都删掉同一个东西**
     *   qtypes           UNIQUE(key)                            两台各建一个同名题型
     *   occurrences      —（本轮由确定性 uid 赋予）              同一材料重新分析一次
     *   term_ledger      UNIQUE(norm, verdict, coalesce(lecture_id,0))  两台都拒收同一个表达
     *
     * ── 药 ────────────────────────────────────────────────
     *
     * 身份由业务事实算出来。判据在 `core/identity.ts`，**这里不重写一份** ——
     * 触发器 SQL 和回填 SQL 都是从那份规格生成的，
     * 而 `identity.test.ts` 里有一条 TS ↔ SQL 对拍守着两者真的一致。
     *
     * ── 这一步碰什么、绝不碰什么 ★ ────────────────────────
     *
     * 碰：`uid`，以及这七张表的 uid 触发器。
     * **不碰 `updated_at`。** 这一条是想清楚的，不是省事：
     *   回填之后两台算出的是同一个 uid，本来就已经收敛了，不需要传播；
     *   而如果顺手把 `updated_at` 顶到迁移那一刻，A 和 B 迁移时间不同，
     *   同一行在两边都会「在水位之后改过」→ **每一行都变成一处冲突**，
     *   几百个弹窗等他裁决。不动它，这些行落在水位之下，两边各自安静收敛。
     * 也不碰任何业务字段 —— 下面的自检会逐表比对校验和。
     */

    const t0 = Date.now()

    /**
     * 每一步都标上「哪一步、哪张表」再抛。
     *
     * 迁移失败时使用者看到的是一句话加一次回滚 —— 那句话必须指得出位置，
     * 否则「升级失败」和「不知道为什么升级失败」是一回事。
     */
    const step = <T>(what: string, fn: () => T): T => {
      try {
        return fn()
      } catch (err) {
        throw new Error(`${what}：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    /** 这张表存在吗（老库可能还没建出来） */
    const has = (table: string): boolean =>
      (db.prepare(`pragma table_info("${table}")`).all() as unknown[]).length > 0

    const specs: IdentitySpec[] = IDENTITY_SPECS.filter((s) => has(s.table))

    /**
     * 业务字段的校验和 —— 除 `uid` 外的每一列拼起来。
     * 回填前后各算一次，用来证明「只动了 uid」。
     */
    const businessSum = (table: string): string => {
      const cols = (db.prepare(`pragma table_info("${table}")`).all() as { name: string }[])
        .map((c) => c.name)
        .filter((c) => c !== 'uid')
        .sort()
      const expr = cols.map((c) => `coalesce(cast("${c}" as text), '~')`).join(` || '#' || `)
      const rows = db.prepare(`select ${expr} as s from "${table}"`).all() as { s: string }[]
      return rows.map((r) => r.s).sort().join('#')
    }

    interface Snap {
      rows: number
      identities: number
      sum: string
    }
    const snapshot = (spec: IdentitySpec): Snap => ({
      rows: (db.prepare(`select count(*) as n from "${spec.table}"`).get() as { n: number }).n,
      identities: (
        db
          .prepare(
            `select count(*) as n from (select 1 from "${spec.table}" x group by ${spec.groupBy('x')})`
          )
          .get() as { n: number }
      ).n,
      sum: businessSum(spec.table)
    })

    // ══ ① 回填之前先体检：父行有没有 uid、天然身份有没有撞车 ══
    //
    // 使用者裁决（2026-08-18）：发现同一天然身份有多行 → **直接失败、回滚、报告冲突**。
    // 不合并、不删除、不保留第一条、不静默修复 —— 那些都是替他决定丢掉哪一份数据。
    const problems: string[] = []

    for (const spec of specs) {
      /**
       * 身份里引用了别人的 uid（`item_lectures` 要 items.uid 和 lectures.uid…）。
       * 父行没有 uid，算出来就是 NULL —— 与其让自检在最后一步含糊地红，
       * 不如在这里说清楚是哪一张表的哪几行。
       */
      const nulls = step(`体检 ${spec.table} · 算不算得出身份`, () =>
        db
          .prepare(`select count(*) as n from "${spec.table}" x where ${spec.sql('x')} is null`)
          .get() as { n: number }
      )
      if (nulls.n > 0) {
        const sample = db
          .prepare(`select rowid as r from "${spec.table}" x where ${spec.sql('x')} is null limit 5`)
          .all() as { r: number }[]
        problems.push(
          `${spec.table}：有 ${nulls.n} 行算不出跨设备身份 ${spec.says}` +
            `（多半是它引用的那一行还没有 uid）。样例 rowid：${sample.map((x) => x.r).join('、')}`
        )
      }

      const dup = step(`体检 ${spec.table} · 身份有没有撞车`, () =>
        db
        .prepare(
          `select ${spec.groupBy('x')} as _g, count(*) as n,
                  group_concat(x.rowid) as rowids, group_concat(x.uid) as uids
             from "${spec.table}" x
            group by ${spec.groupBy('x')}
           having n > 1
            limit 10`
        )
        .all() as { n: number; rowids: string; uids: string }[]
      )
      for (const d of dup) {
        problems.push(
          `${spec.table}：同一个业务身份 ${spec.says} 有 ${d.n} 行 —— ` +
            `rowid ${d.rowids}，uid ${d.uids}`
        )
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `不能把跨设备身份改成算出来的 —— 库里已经有对不上的数据：\n` +
          problems.map((p) => `  · ${p}`).join('\n') +
          `\n\n没有自动合并、也没有删任何一行（那等于替你决定丢掉哪一份）。` +
          `\n升级已经中止，数据库已经用升级前那份备份换回去了。` +
          `\n把这段连同日志发给 Claude Code。`
      )
    }

    // ══ ② 快照 ══
    const before = new Map<string, Snap>()
    for (const spec of specs) before.set(spec.table, step(`快照 ${spec.table}`, () => snapshot(spec)))

    // ══ ③ 回填 ══
    //
    // 新旧两种 uid 形态天然不相交（新的第二段是 `nat`，而随机那一路只有十六进制
    // 字符、V9 那一路第二段以数字开头、出厂那一路是 `builtin`），
    // 所以「新算出来的 uid 撞上另一行的旧 uid」不可能发生，一条 UPDATE 就够。
    for (const spec of specs) {
      step(`回填 ${spec.table}`, () =>
        db.prepare(`update "${spec.table}" as x set uid = ${spec.sql('x')}`).run()
      )
    }

    // ══ ④ 回填之后逐项验证 ══
    for (const spec of specs) {
      const b = before.get(spec.table)!
      const a = snapshot(spec)
      const uids = (
        db
          .prepare(`select count(distinct uid) as n from "${spec.table}" where uid is not null`)
          .get() as { n: number }
      ).n

      if (a.rows !== b.rows) throw new Error(`${spec.table}：回填之后行数变了（${b.rows} → ${a.rows}）`)
      if (a.identities !== b.identities) {
        throw new Error(`${spec.table}：业务身份数变了（${b.identities} → ${a.identities}）`)
      }
      if (uids !== a.rows) {
        throw new Error(
          `${spec.table}：${a.rows} 行只算出 ${uids} 个不同的 uid —— ` +
            `要么有身份撞车没被体检拦住，要么有行算出了空身份`
        )
      }
      if (a.sum !== b.sum) {
        throw new Error(`${spec.table}：回填顺手改了业务字段 —— 这一步只该动 uid`)
      }
    }

    // ══ ⑤ 换触发器 ══
    //
    // 触发器正文由 `core/identity.ts` 生成，和回填用的是同一个表达式。
    // 名字一个字不改 —— 结构指纹只算触发器名字（D-269），
    // 所以这一次**指纹纹丝不动**，语义变化由 `SYNC_PROTOCOL_VERSION` 1→2 表达。
    for (const spec of specs) {
      step(`换 ${spec.table} 的触发器`, () => {
        /**
         * ★ `uid` 是 NOT NULL 主键的表（V27 之后的 `qtypes`）**不建触发器**。
         *
         * 两条理由，缺一不可：
         *   · 建了也没用 —— `after insert when new.uid is null` 永远不会触发，
         *     NOT NULL 在那之前就把插入拒了。V27 正是因此把它删掉的。
         *   · 建了会**改结构指纹** —— 指纹算触发器名字（D-269），
         *     而 C-1 这一步的性质是「只改语义、不改结构」。多一个触发器，
         *     两台设备的握手就会因为结构不一致而互相拒收。
         *
         * 这几张表的 uid 由生产代码显式给（`QTypes.save()` 调 `qtypeUid(key)`），
         * 走的是同一份规格。
         */
        const uidCol = (db.prepare(`pragma table_info("${spec.table}")`).all() as {
          name: string
          notnull: number
        }[]).find((c) => c.name === 'uid')
        if (uidCol && uidCol.notnull === 1) return

        db.exec(`drop trigger if exists trg_${spec.table}_uid`)
        db.exec(uidTriggerSql(spec.table))
      })
    }

    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (27, 28, 'C-1 身份回填明细', ?, 1, ?, ?)`
    ).run(
      t0,
      specs.map((s) => `${s.table}=${before.get(s.table)!.rows}`).join(' '),
      Date.now()
    )
  }
}

/**
 * ★★★ V29 搬的那 22 把键 —— **冻成字面量**（T-2.12 / I-149，2026-09-07）
 *
 * ══ 病 ═══════════════════════════════════════════════════════
 *
 * 这里原来写的是 `for (const spec of PREF_SPECS)` —— 直接遍历**当前**的白名单。
 * 于是白名单一改，一条**已经写完、已经在使用者机器上跑过**的历史迁移
 * 行为就跟着改了。T-7.9 退役三把语音键的那天就真的发生了：V29 从此不再搬
 * `tts.cloud` / `tts.model` / `tts.voice`，而没有任何人改过 V29 一个字。
 * 这正是 D-216「编号迁移不回头改」要挡的东西 —— 只是那条规矩以前只管
 * 「别去编辑旧迁移」，管不住「旧迁移自己引用了会变的常量」。
 *
 * ══ 冻的是哪一份 ═════════════════════════════════════════════
 *
 * **是今天这一份**（2026-09-07 的 `PREF_SPECS` 展开值），不是 V29 刚写出来时那一份。
 * 差别就是退役的那三把：它们**不在**这份名单里，所以照旧留在 `settings` ——
 *   · 使用者的设置一个字没丢：`main/tts.ts` 读不到偏好表那一份时回头读 `settings`；
 *   · 而且更对：退役的键本来就不该被搬进一张**会同步**的表。
 * 换句话说：这次冻结**不改变今天的行为**，它只是把今天的行为钉死，
 * 让下一次改白名单不再顺手改掉一条历史迁移。
 *
 * ══ 从今往后 ═════════════════════════════════════════════════
 *
 * · 往 `core/prefs.ts::PREF_SPECS` 加一把新键 → V29 **不动**（它不在这份名单里）。
 *   新键要从 `settings` 搬家的话，写一条**新的**迁移，别回头改这里。
 * · 退役一把键 → V29 也不动。
 * · `kind` 一起冻：值的形状判断走 `checkPrefValueOf(spec, …)`，
 *   拿的是**这里这份 spec**，不回头查当前白名单。形状规则本身仍只有一份（core）。
 * · `scripts/check-sql.mjs` 里有一道闸守着：**迁移文件里不许出现
 *   `PREF_SPECS` / `PREF_KEYS`**，防止哪天有人顺手把遍历写回来。
 */
/**
 * ★ 导出**只为让用例看得见它**（T-2.12 补）。别在别处拿它当白名单用 ——
 *   它是一份**冻住的历史**，不是「现在跟着人走的有哪些」；后者永远是
 *   `core/prefs.ts::PREF_SPECS`。
 */
export const V29_PREFS: readonly PrefSpec[] = [
  { key: 'qtypes', kind: 'json-array', says: '产出练习勾了哪几种题型' },
  { key: 'practice_order', kind: 'json', says: '出题顺序（两层）' },

  { key: 'param.silenceStreak', kind: 'number', says: '静默所需连续正确次数' },
  { key: 'param.hardTrigger', kind: 'number', says: '进攻坚区的触发次数' },
  { key: 'param.graceAttempts', kind: 'number', says: '建立期长度' },
  { key: 'param.minSample', kind: 'number', says: '样本不足的阈值' },
  { key: 'param.readingSilenceDays', kind: 'number', says: '认读线静默阈值（天）' },
  { key: 'param.dailyTarget', kind: 'number', says: '今日练习默认条数' },
  { key: 'param.readingDailyCap', kind: 'number', says: '认读每日软上限' },

  { key: 'tts.accent', kind: 'text', says: '朗读口音' },
  { key: 'tts.rate', kind: 'number', says: '朗读语速' },
  { key: 'tts.sources', kind: 'json-array', says: '语音来源顺序' },
  { key: 'tts.sourcesEditedAt', kind: 'number', says: '语音来源顺序是他本人改的' },
  { key: 'tts.sourcesMigratedAt', kind: 'number', says: '语音来源顺序被迁移纠过一次' },
  { key: 'tts.provider.openai-compatible.voice', kind: 'text', says: 'OpenAI 兼容那家的音色' },
  { key: 'tts.provider.google-cloud.voice', kind: 'text', says: 'Google Cloud 那家的音色' },

  { key: 'ai.split', kind: 'bool', says: '长文自动分段' },
  { key: 'dict.default', kind: 'dict-uid', says: '默认词典（跨设备身份）' },

  { key: 'prompt.generate-questions', kind: 'text', says: '出题提示词（他改过的那份）' },
  { key: 'prompt.score-answer', kind: 'text', says: '判分提示词（他改过的那份）' },
  { key: 'prompt.lookup-search', kind: 'text', says: 'Lookup AI 搜索提示词（他改过的那份）' },
  { key: 'prompt.reading-card', kind: 'text', says: '认读牌面提示词（他改过的那份）' }
]

export const v29: Migration = {
  version: 29,
  name: '跟着人走的那些设置搬进自己的表，从此跨设备一致（F-07 · Step 5A）',
  // 偏好从 settings 搬走之后旧键要删 —— 那是有意的，不是掉行（见 open.ts 的自检）
  allowShrink: ['settings'],
  up(db) {
    /**
     * ★★ F-07 · `settings` 里混着四类东西，只有一类该跟着人走。
     *
     *   USER       他想要什么              → 搬进 user_preferences，进同步
     *   DEVICE     这台机器怎么实现        → 留在 settings
     *   SECRET     API key / 同步密钥      → 留在 settings，**永不上云**
     *   SYNC META  协议游标                → 留在 settings
     *
     * 判据在 `core/prefs.ts` 的白名单，两端共用；**但这条迁移搬哪几把键
     * 用的是下面冻住的 `V29_PREFS`**，不是当前白名单（T-2.12，见那份名单的头注）。
     *
     * ── 这条迁移的四条规矩 ──────────────────────────────────
     *
     *   1. **canonical 已经有了就不覆盖** —— 反向覆盖会拿老值盖掉新值
     *   2. 值必须过 `checkPrefValue`；不合法的**留在原地不动**并报出来，
     *      绝不「洗一下再塞进去」（洗错了的数他分辨不出来）
     *   3. 搬成功了才删旧键 —— 删了没搬进去就是数据丢失
     *   4. 幂等：再跑一次一个字都不变
     */
    db.exec(`
      create table if not exists user_preferences (
        uid         text    primary key not null,
        key         text    not null,
        value       text    not null,
        created_at  integer not null,
        updated_at  integer not null
      );
      create unique index if not exists idx_user_preferences_key on user_preferences (key);
    `)
    db.exec(uidTriggerSql('user_preferences'))

    const t = Date.now()
    const put = db.prepare(
      `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)
         on conflict(uid) do nothing`
    )
    const readOld = db.prepare(`select value from settings where key = ?`)
    const dropOld = db.prepare(`delete from settings where key = ?`)
    const hasNew = db.prepare(`select 1 as x from user_preferences where key = ?`)

    const moved: string[] = []
    const kept: string[] = []
    const bad: string[] = []

    for (const spec of V29_PREFS) {
      const old = readOld.get(spec.key) as { value: string } | undefined
      if (!old) continue

      // 规矩 1 · canonical 已经有了就不动它，旧键照样清掉（它已经没有意义了）
      if (hasNew.get(spec.key)) {
        dropOld.run(spec.key)
        kept.push(spec.key)
        continue
      }

      // 规矩 2 · 值不合法就**原地留着**，报出来让他看得见
      // ★ 拿**这里冻住的那份 spec** 判形状，不回头查当前白名单（见 V29_PREFS 头注）
      const v = checkPrefValueOf(spec, old.value)
      if (!v.ok) {
        bad.push(`${spec.key}（${v.why}）`)
        continue
      }

      put.run(prefUid(spec.key), spec.key, v.value, t, t)

      // 规矩 3 · 确认真的搬进去了，再删旧的
      const now = db.prepare(`select value from user_preferences where key = ?`).get(spec.key) as
        | { value: string }
        | undefined
      if (!now) throw new Error(`V29：${spec.key} 没写进偏好表，不能删旧键`)
      dropOld.run(spec.key)
      moved.push(spec.key)
    }

    db.prepare(
      `insert into migration_log (from_version, to_version, name, ran_at, ok, note, updated_at)
       values (28, 29, ?, ?, 1, ?, ?)`
    ).run(
      '偏好搬家明细',
      t,
      JSON.stringify({ moved, kept, bad }),
      t
    )

    /**
     * ★ 搬不动的那几项不让升级失败 —— 它们还原样躺在 `settings` 里，
     *   一个字没丢。但要留一条他看得见的记录：体检会把 migration_log
     *   里这一条端出来（`note` 里就是清单）。
     *
     * 为什么不像 V28 那样直接抛：V28 抛是因为**天然身份撞车**，
     * 那是数据本身自相矛盾，继续跑会合掉一份数据。
     * 这里只是某一项的值格式不对（比如他手改过库），
     * 让整个软件打不开是不成比例的 —— 那一项回到默认值，别的照常用。
     */
  }
}

/** 这一段按版本号顺序排好，交给 migrations.ts 拼成完整的 MIGRATIONS */
export const V20_V29: Migration[] = [
  v20,
  v21,
  v22,
  v23,
  v24,
  v25,
  v26,
  v27,
  v28,
  v29
]
