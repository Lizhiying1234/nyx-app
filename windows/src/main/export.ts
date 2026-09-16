import { SILENCE_FILTER_NAME } from '@core/silence.ts'
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import {
  ledgerKeepsCurrent,
  mergeApplied,
  mergePurgedAt,
  mergeRejectedUpTo,
  mergeWatermark,
  mergeWipedAt,
  parseApplied,
} from "@core/restore-merge.ts";
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeBackup } from "./db/backup.ts";
import {
  afterWipe,
  PRESERVED_SYNC_KEYS,
  type SyncMetaSnapshot,
} from "@core/sync-metadata.ts";
import { verifyNyxDb } from "./db/verify-db.ts";

/**
 * 导回走到「已经关了当前库、但还没换成新库」那一小段才失败 · C-1
 *
 * 数据是安全的（`nyx.db` 原封不动），但主进程手里的连接已经关了 ——
 * 调用方必须据此重启，否则之后每一次操作都在一个关掉的连接上报错。
 * 单独一个类型，是为了让调用方能**分辨**这一种失败，而不是当成普通报错吞掉。
 */
export class RestoreAborted extends Error {
  readonly dbClosed = true;
  constructor(message: string) {
    super(message);
    this.name = "RestoreAborted";
  }
}

/**
 * 导出与导回 · D-102 / D-232
 *
 * 「只做两种：**完整备份**（含两条线进度、原文出处、攻坚记录、静默状态，**可原样导回**）
 *  与**可读笔记**（Markdown / PDF）。**不做 .apkg**。」
 *
 * 不做 Anki 格式的理由（D-102 / D-103）：Nyx 的核心机制 Anki 一样都装不下 ——
 * 一张 Anki 卡只有正反面，而原文出处（D-057）、主动/被动（D-023）、
 * lecture 归属（D-089）它一条都不满足。而且一旦两边都练，进度分叉，统计从此不准。
 */
export class Exporter {
  constructor(private db: Db) {}

  /** 完整备份：一个可以原样导回的 .db 文件。 */
  backupTo(dest: string): string {
    if (existsSync(dest)) rmSync(dest);
    this.db.prepare("vacuum into ?").run(dest);
    return dest;
  }

  /**
   * 导回 · D-232 / C-1
   * 「导回是**覆盖**，不是合并。**导回前先备份当前库**，等于给使用者一次反悔机会。」
   *
   * ── 原来这一步是怎么危险的 ────────────────────────────────
   *
   * 老流程：备份当前 → **关掉当前库** → 删 `-wal/-shm` → 直接覆盖 `nyx.db` → 重启。
   * 注释写着「不是 Nyx 的库就别覆盖」，而代码检查的是**当前这个库还活不活着** ——
   * 来源文件一个字节都没看过。
   *
   * 他在文件对话框里选错一个 `.db`，好数据当场被盖掉，重启后 `openDatabase`
   * 打不开，走 `fatal()` 弹框退出 —— **软件从此起不来**。
   * 安全备份确实在 `data/backups`，但要他自己去找、改名、放回去。
   *
   * ── 新流程：验源 → 备份 → 写临时 → 验临时 → 原子替换 ────────
   *
   * 关键是**顺序**：在来源被证明可用之前，当前库一个字节都不动、也不关。
   * 临时文件写在 `nyx.db` 同一个目录（同一个卷），`rename` 才可能是原子的 ——
   * 跨盘的 rename 会退化成「拷贝 + 删除」，那就没有原子性可言了。
   *
   * 临时文件**写完还要再验一遍**：磁盘满、拷到一半断电、杀毒软件把内容改了，
   * 这些都只在拷贝之后才看得出来。验源不能替代验副本。
   *
   * ★ 唯一一段「已经关了库但还没换成」的窗口，是 `close()` 到 `rename()` 之间。
   *   那一段里 `nyx.db` 原封不动 —— 所以失败的最坏结果是「要重启一次」，不是丢数据。
   *   这一点由 `RestoreAborted.dbClosed` 报给调用方，让它去重启。
   */
  /**
   * ★★ R-3-f · 把当前库里**已经发生过的事**并进临时库。
   *
   * 四类，四条规则，**方向各不相同** —— 判据全在 `core/restore-merge.ts`：
   *
   *   墓碑          并集，同一块取 `max(purged_at)`   宁可多挡，不可复活
   *   账本行        按 `updated_at` 取新的那一行       撤销可以来回翻，不能并集
   *   `wipedAt`     `max`                              他按过「清空云端」，那件事发生过
   *   `watermark`   **`min`** ★                        取 max 会静默丢数据，见注释
   *   `applied`     并集                               它是缓存，不是事实
   *
   * 整段在**临时库**上一个事务里做完 —— 当前库只被读，一个字都不写。
   */
  private mergeIrreversible(tmpPath: string): void {
    const cur = this.db;
    const tmp = new Database(tmpPath);
    try {
      tmp.pragma("foreign_keys = ON");
      tmp.transaction(() => {
        // ── ① 墓碑：并集，同一块取较晚的 purged_at ──────────────
        const tombs = cur
          .prepare(
            `select uid, target_uid as targetUid, kind, target_id as targetId,
                    purged_at as purgedAt, created_at as createdAt, updated_at as updatedAt
               from tombstones`,
          )
          .all() as {
          uid: string;
          targetUid: string;
          kind: string;
          /** ★ R-3-g · 这一列**必须跟着搬**，丢了就成了认不出下级的老碑 */
          targetId: number | null;
          purgedAt: number;
          createdAt: number;
          updatedAt: number;
        }[];
        const findTomb = tmp.prepare(
          `select id, purged_at as purgedAt, target_id as targetId
             from tombstones where target_uid = ? and kind = ?`,
        );
        const upTomb = tmp.prepare(
          `update tombstones set purged_at = ?, target_id = ?, updated_at = ? where id = ?`,
        );
        /**
         * **不带 `id` 插入。** 那是本地自增主键，两份库各排各的，
         * 照抄过去会撞主键。行的身份是 `uid`，那个要原样带走。
         */
        const insTomb = tmp.prepare(
          `insert into tombstones (uid, target_uid, kind, target_id, purged_at, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const t of tombs) {
          const had = findTomb.get(t.targetUid, t.kind) as
            | { id: number; purgedAt: number; targetId: number | null }
            | undefined;
          if (!had) {
            insTomb.run(
              t.uid, t.targetUid, t.kind, t.targetId, t.purgedAt, t.createdAt, t.updatedAt,
            );
            continue;
          }
          const want = mergePurgedAt(t.purgedAt, had.purgedAt);
          /**
           * ★ R-3-g · 两边都有这块碑，但可能只有一边记了 `target_id`
           * （一边是 V23 之前立的）。有就补上 —— **只补，不覆盖成 null**。
           */
          const fillId = had.targetId === null && t.targetId !== null ? t.targetId : had.targetId;
          if (want !== had.purgedAt || fillId !== had.targetId) {
            upTomb.run(want, fillId, Date.now(), had.id);
          }
        }

        // ── ② 账本：按 updated_at 取新的那一行 ─────────────────
        const rows = cur
          .prepare(
            `select uid, norm, term, verdict, scope, lecture_id as lectureId, note,
                    revoked_at as revokedAt, created_at as createdAt, updated_at as updatedAt
               from term_ledger`,
          )
          .all() as {
          uid: string;
          norm: string;
          term: string;
          verdict: string;
          scope: string;
          lectureId: number | null;
          note: string | null;
          revokedAt: number | null;
          createdAt: number;
          updatedAt: number;
        }[];
        const findRow = tmp.prepare(
          `select id, updated_at as updatedAt from term_ledger
            where norm = ? and verdict = ? and coalesce(lecture_id, 0) = coalesce(?, 0)`,
        );
        const upRow = tmp.prepare(
          `update term_ledger set term = ?, note = ?, revoked_at = ?, updated_at = ? where id = ?`,
        );
        const insRow = tmp.prepare(
          `insert into term_ledger (uid, norm, term, verdict, scope, lecture_id, note,
                                    revoked_at, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const lecOk = tmp.prepare(`select 1 as x from lectures where id = ?`);
        for (const r of rows) {
          const had = findRow.get(r.norm, r.verdict, r.lectureId) as
            | { id: number; updatedAt: number }
            | undefined;
          if (had) {
            // 当前那一行更新才覆盖；备份更新就原样留着备份的
            if (ledgerKeepsCurrent(r.updatedAt, had.updatedAt)) {
              upRow.run(r.term, r.note, r.revokedAt, r.updatedAt, had.id);
            }
            continue;
          }
          /**
           * 只有当前库有这一行。挂在某一讲上的（`scope='lecture'`）
           * 而那一讲不在这份备份里 —— 跳过：外键会挡，
           * 而且那个范围在恢复出来的库里本来就没有意义。
           * （现存代码里没有任何一处会写 lecture 范围的账，这是防御性的。）
           */
          if (r.lectureId !== null && !lecOk.get(r.lectureId)) continue;
          insRow.run(
            r.uid, r.norm, r.term, r.verdict, r.scope, r.lectureId, r.note,
            r.revokedAt, r.createdAt, r.updatedAt,
          );
        }

        /**
         * ── ③ 裁决：并集，同一条取较晚的 `rejected_up_to` · ★★ R-4-F-a ──
         *
         * 「用本地的」是他按下去的决定，导回一份旧备份不能把它当成没发生 ——
         * 退回旧值等于让那段时间里被拒绝的远端版本重新可收，
         * 下一次同步就悄悄盖掉他留下的内容（正是 R-4-F-a 要消灭的那件事）。
         *
         * ★ 和墓碑共用框架、不共用语义：这里调的是 `mergeRejectedUpTo`，
         * 不是 `mergePurgedAt`。两条规则碰巧都取 max，但失效条件完全不同。
         *
         * V25 之前的备份里没有这张表 —— 那就是「备份里没有任何裁决」，
         * 当前库里的原样保留，一条都不会丢。
         */
        try {
          const res = cur
            .prepare(
              `select uid, target_uid as targetUid, kind, rejected_up_to as rejectedUpTo,
                      created_at as createdAt, updated_at as updatedAt
                 from resolutions`,
            )
            .all() as {
            uid: string;
            targetUid: string;
            kind: string;
            rejectedUpTo: number;
            createdAt: number;
            updatedAt: number;
          }[];
          const findRes = tmp.prepare(
            `select rejected_up_to as rejectedUpTo from resolutions
              where target_uid = ? and kind = ?`,
          );
          const upRes = tmp.prepare(
            `update resolutions set rejected_up_to = ?, updated_at = ?
              where target_uid = ? and kind = ?`,
          );
          const insRes = tmp.prepare(
            `insert into resolutions (uid, target_uid, kind, rejected_up_to, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?)`,
          );
          for (const r of res) {
            const had = findRes.get(r.targetUid, r.kind) as
              | { rejectedUpTo: number }
              | undefined;
            if (!had) {
              insRes.run(r.uid, r.targetUid, r.kind, r.rejectedUpTo, r.createdAt, r.updatedAt);
              continue;
            }
            const want = mergeRejectedUpTo(r.rejectedUpTo, had.rejectedUpTo);
            if (want !== had.rejectedUpTo) upRes.run(want, Date.now(), r.targetUid, r.kind);
          }
        } catch {
          /* 两边有一边还没有这张表（V25 之前的库）—— 那就没有裁决可合并 */
        }

        // ── ④⑤⑥ 三个同步状态键 ────────────────────────────────
        const get = (db: Db, key: string): string | null =>
          (db.prepare(`select value from settings where key = ?`).get(key) as
            | { value: string }
            | undefined)?.value ?? null;
        const put = (key: string, value: string): void => {
          tmp
            .prepare(
              `insert into settings (key, value, updated_at) values (?, ?, ?)
                 on conflict(key) do update set value = excluded.value,
                                                updated_at = excluded.updated_at`,
            )
            .run(key, value, Date.now());
        };

        const num = (v: string | null): number => Number(v ?? "0") || 0;
        put(
          "sync.wipedAt",
          String(mergeWipedAt(num(get(cur, "sync.wipedAt")), num(get(tmp, "sync.wipedAt")))),
        );
        put(
          "sync.watermark",
          String(
            mergeWatermark(num(get(cur, "sync.watermark")), num(get(tmp, "sync.watermark"))),
          ),
        );
        put(
          "sync.applied",
          JSON.stringify(
            mergeApplied(
              parseApplied(get(cur, "sync.applied")),
              parseApplied(get(tmp, "sync.applied")),
            ),
          ),
        );
      })();
    } finally {
      tmp.close();
    }
  }

  async restoreFrom(
    src: string,
    dbPath: string,
    backupDir: string,
    targetVersion: number,
  ): Promise<{ safetyBackup: string }> {
    // ── ① 验来源。**当前库在这一步完全没被碰过** ──────────────
    const v = verifyNyxDb(src, targetVersion);
    if (!v.ok) throw new Error(`这份文件不能用来导回：\n${v.problem}`);

    // ── ② 给当前这份留退路 ────────────────────────────────────
    const safety = makeBackup(this.db, backupDir, "before-restore");

    /**
     * ── ③ 写临时文件，**放在 nyx.db 旁边** ────────────────────
     * 同一个卷，`rename` 才走得了 NTFS 的原子替换。
     * 顺手清掉上次失败留下的残骸 —— 不清的话它们会一直堆着。
     */
    const dir = dirname(dbPath);
    for (const f of readdirSync(dir)) {
      if (/^nyx\.restore-\d+\.tmp\.db$/.test(f)) {
        try {
          rmSync(join(dir, f));
        } catch {
          /* 上一次的残骸删不掉不该挡住这一次 */
        }
      }
    }
    const tmp = join(dir, `nyx.restore-${Date.now()}.tmp.db`);
    try {
      copyFileSync(src, tmp);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 拷都没拷成，多半也没这个文件 */
      }
      throw new Error(
        `写临时文件失败，什么都没有改动：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── ④ 验临时副本。磁盘满 / 拷到一半，只有这一步看得出来 ──────
    const v2 = verifyNyxDb(tmp, targetVersion);
    if (!v2.ok) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 留着也只是个临时文件，下次开头会清 */
      }
      throw new Error(`拷贝出来的副本有问题，已经取消，你的数据没有改动：\n${v2.problem}`);
    }

    /**
     * ── ★★ ⑤ R-3-f · 把当前库的**不可逆事实**并进临时库 ────────
     *
     * 导回可以把「现在是什么样」恢复到过去，
     * **但不能把「发生过什么」当成没发生。**
     * 判据在 `core/restore-merge.ts`（四条规则方向不一样，必须能单独红）。
     *
     * 这一步**只在临时库上做**，当前库到这里为止一个字节都没被碰过 ——
     * 所以它失败了就和上面那两道验证一样：删掉临时文件、抛错、
     * 当前库原封不动（C-1 已验收的那条保证）。
     */
    try {
      this.mergeIrreversible(tmp);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 下次导回开头会清 */
      }
      throw new Error(
        `合并「已经发生过的事」时失败，已经取消，你的数据没有改动：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // ── ⑥ 再验一次。合并那一步万一写坏了，只有这里看得出来 ──────
    const v3 = verifyNyxDb(tmp, targetVersion);
    if (!v3.ok) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 同上 */
      }
      throw new Error(`合并之后的副本有问题，已经取消，你的数据没有改动：
${v3.problem}`);
    }

    /**
     * ── ⑦ 换。到这里才关当前库 ────────────────────────────────
     *
     * `close()` 是干净关闭：better-sqlite3 会把 WAL 合并进主文件并删掉 `-wal/-shm`。
     * 所以接下来删残留是安全的 —— **而且必须删**：留着旧 `-wal`，
     * SQLite 下次打开会拿它去「恢复」这份新库，那才是真的会把数据搞坏。
     */
    this.db.close();
    for (const suffix of ["-wal", "-shm"]) {
      try {
        if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
      } catch {
        /* 删不掉也继续：rename 会覆盖主文件，残留的 -wal 由下一步再试 */
      }
    }

    /**
     * Windows 上 `rename` 走 MoveFileEx + REPLACE_EXISTING，是原子替换。
     * 但**杀毒软件会短暂持有目标文件的句柄**，这时报 EPERM/EBUSY。
     * 重试几次是这里唯一实际有效的办法 —— 退避 120ms，一共约 0.7 秒。
     */
    let lastErr: unknown = null;
    for (let i = 0; i < 6; i++) {
      try {
        renameSync(tmp, dbPath);
        return { safetyBackup: safety };
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    // 换不成。`nyx.db` 还是原来那份（rename 失败不会动目标），但库已经关了
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 下次导回开头会清 */
    }
    throw new RestoreAborted(
      `没能替换数据库文件（多半是被杀毒软件或另一个程序占用着）：` +
        `${lastErr instanceof Error ? lastErr.message : String(lastErr)}\n` +
        `你的数据**没有被改动**，Nyx 重启之后照常可用。`,
    );
  }

  /**
   * 可读笔记 · Markdown。
   * 「人类可读版本」—— 拿去别处看、打印、存档都行，**不是**用来导回的。
   */
  /**
   * 可读笔记的 Markdown · D-102 / I-096
   *
   * 「导出的文件是不是也要整理以及注意一下版式和格式呢」—— 要。
   * 上一版是把库里的东西按 id 顺序倒出来：区块标题是 `grammar` / `nuance` 这类
   * 原始英文键名，练习题的 JSON 也一起倒进去了，读起来像日志不像笔记。
   *
   * 这一版的取舍：
   *   · **先分讲，再分主动 / 被动** —— 这是整套方法的核心区分，笔记里必须看得见
   *   · 区块用**中文小标题、固定顺序**，顺序照着详情页（先看懂，再拿分寸）
   *   · **练习素材不进笔记**（suspect / chunks）—— 笔记是拿来读的，不是拿来考的
   *   · 讲多于一个时给目录；条数、层次、静默数放在开头一行，一眼知道这份有多重
   *   · 出处用引用块，条目之间用 `---` 断开 —— 长文档滚起来才有节奏
   */
  notesMarkdown(lectureIds?: number[], itemIds?: number[]): string {
    const NL = String.fromCharCode(10);
    const where: string[] = ["i.deleted_at is null"];
    const args: number[] = [];
    if (lectureIds?.length) {
      where.push(`exists (select 1 from item_lectures il2 where il2.item_id = i.id
                     and il2.lecture_id in (${lectureIds.map(() => "?").join(",")}))`);
      args.push(...lectureIds);
    }
    // I-097 · 也支持「就导我勾中的这几条」
    if (itemIds?.length) {
      where.push(`i.id in (${itemIds.map(() => "?").join(",")})`);
      args.push(...itemIds);
    }
    const items = this.db
      .prepare(
        `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer, i.kind,
                i.production_state as st, i.streak, i.attempts, i.corrects,
                (select l.name from item_lectures il join lectures l on l.id = il.lecture_id
                  where il.item_id = i.id and il.is_owner = 1 limit 1) as lecture
           from items i where ${where.join(" and ")}
          order by lecture, i.layer desc, i.term collate nocase`,
      )
      .all(...args) as {
      id: number;
      term: string;
      gloss: string;
      glossZh: string;
      layer: string;
      kind: string;
      st: string;
      streak: number;
      attempts: number;
      corrects: number;
      lecture: string | null;
    }[];

    const occ = this.db.prepare(
      `select quote, para from occurrences where item_id = ? order by id limit 3`,
    );
    const blk = this.db.prepare(
      `select block, content from analysis_blocks where item_id = ? order by id`,
    );

    const ST: Record<string, string> = {
      new: "未开始",
      training: "训练中",
      hard: "攻坚区",
      silent: SILENCE_FILTER_NAME,
    };

    /**
     * 区块的中文标题与**固定顺序**。顺序照着详情页：先看懂这一句，再拿分寸。
     * 不在这张表里的区块一律不导 —— 那些是练习素材（suspect / chunks），
     * 笔记是拿来读的。
     */
    const BLOCKS: [string, string][] = [
      ["inSentence", "这一句里"],
      // 合并之前写下的老行照旧导出，一个字不丢（D-468）
      ["meaning", "它在这句里做什么"],
      ["barriers", "会绊住你的地方"],
      ["sense", "字面义与引申义"],
      ["type", "属于哪一类知识点"],
      ["structure", "结构"],
      ["verbs", "动词吃什么结构"],
      ["pattern", "句型"],
      ["collocations", "常见搭配"],
      ["slots", "可替换的位置"],
      ["family", "同族词"],
      ["background", "背景"],
      ["register", "语域"],
      ["nuance", "分寸"],
      ["pragmatics", "语用功能"],
      ["variation", "语域之间怎么变"],
      ["examples", "例句"],
      ["rewrites", "改写"],
      ["proper", "专有名词"],
      ["diagnosis", "为什么反复错"],
    ];

    // 按讲分组，讲内先主动后被动
    const byLecture = new Map<string, typeof items>();
    for (const it of items) {
      const k = it.lecture ?? "未归属";
      if (!byLecture.has(k)) byLecture.set(k, []);
      byLecture.get(k)!.push(it);
    }

    const active = items.filter((i) => i.layer === "B").length;
    const silent = items.filter((i) => i.st === "silent").length;

    const out: string[] = [
      `# Nyx 笔记`,
      ``,
      `${new Date().toLocaleDateString("zh-CN")} 导出 · 共 **${items.length}** 条` +
        `（主动 ${active} · 被动 ${items.length - active} · ${SILENCE_FILTER_NAME} ${silent}）`,
      ``,
      `> 这是**可读笔记**，不是备份。要迁移数据请用「完整备份」那个 .db 文件（D-102）。`,
      ``,
    ];

    if (items.length === 0) {
      out.push(`范围内还没有知识点。`, ``);
      return out.join(NL);
    }

    // 目录 —— 只有多于一讲时才值得给
    if (byLecture.size > 1) {
      out.push(`## 目录`, ``);
      for (const [lec, group] of byLecture) {
        out.push(`- [${lec}](#${this.anchorOf(lec)}) · ${group.length} 条`);
      }
      out.push(``);
    }

    for (const [lec, group] of byLecture) {
      out.push(`---`, ``, `## ${lec}`, ``);
      for (const layer of ["B", "A"] as const) {
        const part = group.filter((i) => i.layer === layer);
        if (part.length === 0) continue;
        out.push(
          `### ${layer === "B" ? "写作层" : "理解层"} · ${part.length} 条`,
          ``,
          layer === "B"
            ? `> 要练到能写出来的。`
            : `> 只求看懂 —— 不进产出训练（D-023）。`,
          ``,
        );
        for (const it of part) {
          out.push(`#### ${it.term}`, ``);
          if (it.gloss)
            out.push(
              `${it.gloss}${it.glossZh ? `　·　${it.glossZh}` : ""}`,
              ``,
            );
          out.push(
            `\`${it.kind}\`　\`${ST[it.st] ?? it.st}\`` +
              (it.attempts > 0
                ? `　练过 ${it.attempts} 次 · 对 ${it.corrects} 次`
                : "　还没练过"),
            ``,
          );

          // M-012 · 原文出处是知识点身份的一半，导出当然要带上
          const qs = occ.all(it.id) as { quote: string; para: number | null }[];
          for (const q of qs) {
            out.push(
              `> ${q.quote}${q.para ? `　（第 ${q.para} 段）` : ""}`,
              ``,
            );
          }

          const have = new Map(
            (blk.all(it.id) as { block: string; content: string }[]).map(
              (b) => [b.block, b.content],
            ),
          );
          for (const [key, title] of BLOCKS) {
            const raw = have.get(key);
            if (!raw) continue;
            const body =
              raw.trim().startsWith("[") || raw.trim().startsWith("{")
                ? this.flatten(raw)
                : raw.trim();
            if (body) out.push(`**${title}**　${body}`, ``);
          }
        }
      }
    }

    out.push(
      `---`,
      ``,
      `*写作层是要练到能写出来的；理解层只求看懂。`,
      `「${SILENCE_FILTER_NAME}」= 通过了全部检验、不再排进练习，不是被删掉。*`,
      ``,
    );
    return out.join(NL);
  }

  /** Markdown 目录用的锚点。中文标题在多数阅读器里按「小写 + 去空格」生成 */
  private anchorOf(t: string): string {
    return t
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\w一-龥-]/g, "");
  }

  /** 区块里存的可能是 JSON，导出成 Markdown 时压平成一行人话。 */
  private flatten(raw: string): string {
    try {
      const v = JSON.parse(raw) as unknown;
      if (Array.isArray(v)) {
        return v
          .map((x) =>
            typeof x === "string"
              ? x
              : typeof x === "object" && x
                ? Object.values(x as Record<string, unknown>)
                    .filter(Boolean)
                    .join(" — ")
                : String(x),
          )
          .join("；");
      }
      if (typeof v === "object" && v) {
        return Object.values(v as Record<string, unknown>)
          .filter(Boolean)
          .join(" — ");
      }
      return String(v);
    } catch {
      return raw;
    }
  }

  /**
   * 导出**某一支**的笔记 · I-047
   * 整库那份走 `writeNotes`；这里是「这个项目 / 这个单元 / 这一讲」。
   * 复用同一套 Markdown 生成 —— 一份实现，格式不会分叉（D-102）。
   */
  /** I-097 · 只导勾中的这几条。和整库、按支导出共用同一套 Markdown（D-102 一份实现） */
  writeItemNotes(
    dest: string,
    name: string,
    itemIds: number[],
  ): { path: string; bytes: number } {
    const md = this.notesMarkdown(undefined, itemIds).replace(
      "# Nyx 笔记",
      `# ${name}`,
    );
    writeFileSync(dest, md, "utf8");
    return { path: dest, bytes: Buffer.byteLength(md, "utf8") };
  }

  writeScopedNotes(
    dest: string,
    name: string,
    lectureIds: number[],
  ): { path: string; bytes: number } {
    if (lectureIds.length === 0) {
      const md = `# ${name}\n\n这一支下面还没有 Lecture，没有可导出的东西。\n`;
      writeFileSync(dest, md, "utf8");
      return { path: dest, bytes: Buffer.byteLength(md, "utf8") };
    }
    const md = this.notesMarkdown(lectureIds).replace(
      "# Nyx 笔记",
      `# ${name}`,
    );
    writeFileSync(dest, md, "utf8");
    return { path: dest, bytes: Buffer.byteLength(md, "utf8") };
  }

  /**
   * 清空全部学习数据 · I-051
   *
   * 使用者要「从头再测一遍」。这是**不可逆**的，所以三道保险：
   *   ① 动手之前先做一份完整备份，路径报回去
   *   ② 只清业务数据 —— **设置一律不动**（AI key、同步配置、词典、朗读、机制参数）
   *      否则「重来一遍」变成「重新配一遍软件」
   *   ③ 整个包在一个事务里，中途失败什么都不会改
   */
  wipeStudyData(
    backupDir: string,
    /**
     * I-068 · 连设置一起清。
     * 默认不清 —— 「重来一遍」不该变成「重新配一遍软件」。
     * 但使用者明确说「api 和云端服务的链接还都在那里」，
     * 所以要能选：勾了就连 AI key、同步配置、朗读、词典排序一起清空。
     */
    alsoSettings = false,
  ): { backup: string; cleared: Record<string, number> } {
    const backup = makeBackup(this.db, backupDir, "before-wipe");

    /**
     * ★ I-102 · 清哪些表，**从库里问，不要手抄一张名单**。
     *
     * 手抄的那一版留下了两个坑，而且是同一个坏设计的两张脸：
     *   · `item_events`（V10 新加的表）**忘了写进名单** → 外键挡住 `delete from items`
     *     → 31 条知识点原样留下
     *   · `materials` 排在 `analysis_jobs` 前面 → 同样被外键挡住
     * 而每张表都是 `try { … } catch {}`，**失败被吞掉，看起来像成功** ——
     * 使用者说的「数据没有全部清除」就是这么来的。
     *
     * 改成反过来：**列出所有表，扣掉要保留的那几张，其余一律清**。
     * 将来再加表，默认就在清空范围内 —— 忘记维护名单的后果从「悄悄留下数据」
     * 变成「多清一张新表」，前者是数据泄漏，后者顶多是清得更干净。
     *
     * 顺序问题一并解决：整个过程里把外键关掉。反正是**全清**，
     * 谁先谁后不影响结果，也不会留下悬空引用。
     */
    const KEEP_ALWAYS = ["migration_log"];
    // 这几张是「设置」，只有 alsoSettings 才动
    const SETTINGS_TABLES = [
      "settings",
      "tutors",
      "dictionaries",
      "prompt_presets",
      "profile_facts",
    ];
    const all = (
      this.db
        .prepare(
          `select name from sqlite_master where type='table' and name not like 'sqlite_%'`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const tables = all.filter(
      (t) => !KEEP_ALWAYS.includes(t) && !SETTINGS_TABLES.includes(t),
    );
    const cleared: Record<string, number> = {};

    /**
     * ★★ Step 1C · 同步身份与不可逆事实，**在删之前抄下来**。
     * 判据（哪几个键、值怎么算）在 `core/sync-metadata.ts`，两条清空路径共用。
     */
    const before: SyncMetaSnapshot = {};
    for (const k of PRESERVED_SYNC_KEYS) {
      const r = this.db.prepare(`select value from settings where key = ?`).get(k) as
        | { value: string }
        | undefined;
      before[k] = r?.value ?? null;
    }

    const fkWasOn =
      (this.db.pragma("foreign_keys", { simple: true }) as number) === 1;
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        for (const t of tables) {
          const n = (
            this.db.prepare(`select count(*) as n from "${t}"`).get() as {
              n: number;
            }
          ).n;
          // **不再吞异常**：一张表清不掉就整体回滚，让人当场看见，
          // 而不是留下一半数据、报一句「已清空」
          this.db.prepare(`delete from "${t}"`).run();
          if (n > 0) cleared[t] = n;
        }
        // 自增号也归零，重来一遍的编号从 1 开始
        this.db.prepare(`delete from sqlite_sequence`).run();

        /**
         * I-068 ·「我看见 api 和云端服务之前所设的链接还都在那里。」
         *
         * 默认保留设置是有理由的（「重来一遍」不该变成「重新配一遍软件」），
         * 但那应该是**他的选择**，不是我替他决定。勾了就连设置一起清 ——
         * 连同导师、词典、提示词预设、个人档案，那些也都是「配过的东西」。
         * `sync.wipedAt` 例外 —— 那是墓碑，清掉等于把云端老数据放回来。
         */
        if (alsoSettings) {
          /**
           * ★★ Step 1C · D-273 · 保留哪几个键，判据在 `core/sync-metadata.ts`。
           *
           * 这里原来只写了 `key != 'sync.wipedAt'` —— 记得留碑是对的，
           * 但 `sync.device` 也一起被删了：换个编号之后，这台机器就不再认得
           * 自己以前推的包，会把自己删掉的东西从云端拉回来。
           * 现在两条清空路径（这里和 `factory-reset.ts`）用同一份清单。
           */
          const guard = PRESERVED_SYNC_KEYS.map((k) => `'${k}'`).join(", ");
          for (const t of SETTINGS_TABLES) {
            const keep = t === "settings" ? `where key not in (${guard})` : "";
            const n = (
              this.db
                .prepare(`select count(*) as n from "${t}" ${keep}`)
                .get() as { n: number }
            ).n;
            this.db.prepare(`delete from "${t}" ${keep}`).run();
            if (n > 0) cleared[t] = n;
          }
        }

        /**
         * ★ 同步状态**不能清**，只能往前推。（放在最后 —— 上面清 settings 时会连它一起删）
         *
         * 一开始这里写的是 `delete sync.watermark / sync.applied`，注释还写着
         * 「不然云端的老数据又拉回来」—— **正好写反了，而且真的把数据拉回来了**：
         *   · `sync.applied` 记的是「云端哪些包我已经应用过」。删掉它，
         *     那些包全部重新变成没见过的，下次同步原样再拉一遍。
         *   · `sync.watermark` 归零，本地每一行都算「改过」，又会全部推上去。
         * 使用者清完数据重传同一份材料，58 句全被判成「以前收集过」，就是这么来的。
         *
         * 正确做法是把水位推到**现在**：清空之后本地没有待推的行，
         * 云端已经见过的包也仍然算见过。
         *
         * ★★ Step 1C · 这一段现在走 `core/sync-metadata.ts::afterWipe` ——
         * 「水位推到现在」「碑只增不减」「编号不换」三条是同一件事的三个面，
         * 分开写就会像上面那样只对一半。
         */
        const put = this.db.prepare(
          `insert into settings (key, value, updated_at) values (?, ?, ?)
             on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        );
        const keep = afterWipe(before, Date.now());
        const at = Date.now();
        for (const k of PRESERVED_SYNC_KEYS) {
          if (k === "sync.device" && keep[k] === "") continue;
          put.run(k, keep[k], at);
        }
      })();
    } finally {
      if (fkWasOn) this.db.pragma("foreign_keys = ON");
    }

    /**
     * ★ 清完自检（同 D-216 的迁移自检思路）。
     *
     * 「清空」是使用者**看不见过程**的操作 —— 他只能看见一句「已清空」。
     * 所以不能靠「没抛异常」当成功：真出问题时（外键挡住、名单漏了表），
     * 表现正好是「说清空了、数据还在」。这里再数一遍，对不上就当场说出来。
     */
    const left: string[] = [];
    for (const t of tables) {
      const n = (
        this.db.prepare(`select count(*) as n from "${t}"`).get() as {
          n: number;
        }
      ).n;
      if (n > 0) left.push(`${t}(${n})`);
    }
    if (left.length > 0) {
      throw new Error(
        `清空没做干净 —— 这几张表里还有数据：${left.join("、")}
` +
          `清空前的完整备份在：${backup}
` +
          `数据没有丢，但请把这条报给开发者：清空名单或外键顺序有问题。`,
      );
    }

    return { backup, cleared };
  }

  writeNotes(dest: string): { path: string; bytes: number } {
    const md = this.notesMarkdown();
    writeFileSync(dest, md, "utf8");
    return { path: dest, bytes: Buffer.byteLength(md, "utf8") };
  }
}
