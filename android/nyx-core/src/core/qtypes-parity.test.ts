import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 题型规则的**两端对拍** · ⑤（2026-09-01）
 *
 * ── 为什么这里是两份，而别的地方我都上提了 ────────────────
 *
 * `purge` 和 `move-items` 都上提进了 core，两端共用一份。题型这一次**试过、没成**：
 * core 的库面是 **async**（Android 的 SQLite 走 Capacitor 桥，天生异步），
 * 而 Windows 的 `study.ts` 在**同步的出题路径里有 7 处** `this.qt.active()`。
 * 把它们改成 async 会波及整个 study 模块 —— 代价远大于收益，
 * 而且那条路径是产品的心脏。所以：
 *
 *   Windows  `main/db/qtypes.ts`（同步，better-sqlite3）
 *   Android  `core/qtypes-store.ts`（异步，两端库面）
 *
 * ★ 两份实现，**一套规则**。这道闸就是那个「一套」的机械保证 ——
 *   改了一边不同步改另一边，当场红。
 *
 * ── 为什么盯的是这几句话 ★★ ─────────────────────────────
 *
 * 盯的不是代码长得像不像，是**三条会静默失效的规则**：
 *
 * ① **不能把最后一种启用的停用掉**。★ 2026-09-08（D-478）· 这一条原来是
 *    「五个难度档不能删空」—— 档位机制取消后，判据从「每一档至少一种」
 *    收成「至少一种是启用的」。而 M-027「连续 3 次正确必然横跨 3 种题型」
 *    以前是档位的副产品，现在由 `core/qtype-plan.ts::preferDifferent` /
 *    `crossesEnoughTypes` **显式**保证（那两个另有用例）。
 * ② **至少留一种**。删光了产出练习整个跑不起来。
 * ③ **软删**。`questions.type` 存的是 `key`，硬删会让报告里的知识流向图断掉。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = readFileSync(join(HERE, 'qtypes-store.ts'), 'utf8')
const WIN = readFileSync(join(HERE, '..', 'main', 'db', 'qtypes.ts'), 'utf8')

/**
 * 护栏文案 —— **判据 2026-09-15 改了形态，不是放宽**（文案审查 R-05）。
 *
 * ══ 原来钉的是什么 ════════════════════════════════════════════
 * 「这两句话在两份文件里都一字不差地出现」。它守的是「两份实现说同一句话」，
 * 而**实现方式是让两份各写一遍字面** —— 那正是文案审查 R 那一组挑出来的毛病：
 * 同一句话散在多处，改词时必漏一处。
 *
 * ══ 现在钉的是什么 ════════════════════════════════════════════
 * 句子收进 core 的常量，Windows 那份**引它**。于是这道闸改成钉三件事：
 *   ① core 里那个常量还在，且那句话没被改哑；
 *   ② Windows 那份确实**引了**这个常量（不引 = 它多半又自己写了一份）；
 *   ③ ★ Windows 那份里**不许再出现那句字面** —— 这一条是新的，
 *      老那版拦不住「引了常量、旁边又抄了一句」。
 * ☞ 所以判据比原来严，不是松。
 */
const GUARD_CONSTS: [string, string][] = [
  ['KEEP_ONE_QTYPE', '至少要留一种题型 —— 删光了产出练习就出不了题。'],
  ['LAST_ENABLED_QTYPE', '就剩这一种是启用的。停用它，产出练习会出不了题 —— 先启用另一种，再停用它。']
]

/** 两份里都必须出现的写法 —— 形式不同会让行为不同 */
const SHAPES: [string, string][] = [
  ['软删（不是 delete from）', 'update qtypes set deleted_at'],
  ['身份由 key 算出来（D-280）', 'qtypeUid('],
  ['恢复出厂用 canonicalUid（R-4-G）', "canonicalUid('qtypes'"],
  ['列表按 sort, uid 排（档位取消后不再按 tier）', 'order by sort, uid'],
  ['只读没删的', 'where deleted_at is null']
]

describe('题型规则 · Windows 与 core 两份实现对拍（⑤）', () => {
  for (const [name, text] of GUARD_CONSTS) {
    it(`护栏只有 core 一份，Windows 引它：${text.slice(0, 18)}…`, () => {
      assert.ok(
        CORE.includes(`export const ${name}`),
        `core/qtypes-store.ts 里没有 \`${name}\` —— 那句护栏没了出处`
      )
      assert.ok(CORE.includes(text), `core 那份 \`${name}\` 的字变了，不再是：${text}`)
      assert.ok(
        WIN.includes(name),
        `main/db/qtypes.ts 没引 \`${name}\` —— 它多半又自己写了一份那句话`
      )
      assert.ok(
        !WIN.includes(text),
        `★★★ main/db/qtypes.ts 里又出现了那句**字面** —— 收成一处的全部意义就在于` +
          ` 屏上只有一个出处；引了常量、旁边又抄一句，比两边都抄还难发现`
      )
    })
  }

  for (const [what, needle] of SHAPES) {
    it(`两份的写法一致：${what}`, () => {
      assert.ok(CORE.includes(needle), `core/qtypes-store.ts 里没有 \`${needle}\``)
      assert.ok(WIN.includes(needle), `main/db/qtypes.ts 里没有 \`${needle}\``)
    })
  }

  it('★★ 档位机制取消后，两份都不许再出现 tier（D-478）', () => {
    for (const [what, src] of [['core/qtypes-store.ts', CORE], ['main/db/qtypes.ts', WIN]] as const) {
      /**
       * ★★ 2026-09-14 · 这条断言**以前是哑的**：`\b` 被吃成了字面退格字符
       *   （`/<BS>tier<BS>/`），永远不匹配，于是一直绿着、什么都没拦。
       *   修活之后它当场红了 —— 但查下来**错的是断言，不是代码**。
       *
       *   两份里的 `tier` 只有两种出现：一行注释，和
       *   `insert into qtypes (…, tier, …)` 的**列名表**（写常量 1）。
       *   而那正是 **D-216 逼着做的**：列 `not null` 且无默认值，不写就插不进去。
       *   原来那句「列留着（D-216）但代码不许再读写它」**自相矛盾** ——
       *   它禁掉了 D-216 要求的那件事。
       *
       * ★ 它真正要拦的是「**再拿 tier 当判据**」。所以先剥两样再扫：
       *     ① 注释 —— 注释正是记账的地方，扫中它等于罚人写清楚
       *       （这一手是同侪 Nyx-UI-Android 今天提的，它那边同一个坑）
       *     ② `insert into qtypes (…)` 的列名表 —— 那是写，不是读
       *   剩下还有 `tier`，那才是真的又把它当数据用了。
       */
      const bare = src
        .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
        .replace(/\/\/[^\n]*/g, ' ') // 行注释
        .replace(/insert\s+into\s+qtypes\s*\([^)]*\)/gi, ' ') // INSERT 的列名表
      assert.ok(
        !/\btier\b/.test(bare),
        `★★ ${what} 里把 tier 当数据用了 —— 档位机制取消了（D-478）。` +
          `列按 D-216 留着、插入时写常量 1 是对的；` +
          `但读它、按它排序、拿它分支都不行。`
      )
    }
  })

  it('★ 谁都不许硬删题型（delete from qtypes 一次都不许出现）', () => {
    for (const [name, src] of [['core', CORE], ['windows', WIN]] as const) {
      assert.ok(
        !/delete\s+from\s+qtypes/i.test(src),
        `${name} 里出现了硬删 —— 报告里的知识流向图会断掉`
      )
    }
  })
})
