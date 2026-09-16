import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitSql } from './sql-split.ts'

/**
 * A-1 的判据 · ★★（2026-08-24）
 *
 * 这一条守的不是「切分器写得漂亮」，是「Android 上建出来的库不缺东西」。
 * 所以最要紧的两条用例是：
 *   ① 拿**真的 v33.sql** 切，双语句体触发器必须整条出来
 *   ② **负对照**：照抄插件那套坏切法，必须红 —— 不红就说明用例没在验它以为在验的东西
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function latestSchema(): { version: number; sql: string } {
  const versions = readdirSync(join(REPO, 'schema'))
    .map((f) => /^v(\d+)\.sql$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
  const version = Math.max(...versions)
  return { version, sql: readFileSync(join(REPO, 'schema', `v${version}.sql`), 'utf8') }
}

/**
 * ★ 插件 7.0.3 的切法，逐行照抄 `UtilsSQLite.java:44`。
 * 它在这里的唯一用途是**当负对照** —— 证明上面那些用例真的在量东西。
 */
function brokenSplitLikePlugin(sql: string): string[] {
  const stmts = sql.replace(/end;/g, 'END;')
  const arr = stmts.split(';\n')
  const out: string[] = []
  for (const raw of arr) {
    const s = raw.trim()
    if (!s) continue
    if (/;\s*END$/i.test(out[out.length - 1] ?? '')) {
      out.push(s)
      continue
    }
    if (/\bEND$/.test(s) && out.length > 0) out[out.length - 1] += '; END'
    else out.push(s)
  }
  return out
}

describe('splitSql · A-1', () => {
  it('真的 v33.sql：每条语句都是完整的（begin 与 end 配平）', () => {
    const { version, sql } = latestSchema()
    const parts = splitSql(sql)
    assert.ok(parts.length > 100, `v${version} 只切出 ${parts.length} 条，太少了`)

    for (const s of parts) {
      if (!/create\s+trigger/i.test(s)) continue
      // 触发器必须自带收尾的 end；数一遍 begin/case/end 是否配平
      const words = s.toUpperCase().match(/[A-Z_]+/g) ?? []
      let depth = 0
      for (const w of words) {
        if (w === 'BEGIN' || w === 'CASE') depth++
        else if (w === 'END') depth--
      }
      assert.equal(depth, 0, `触发器没切完整（begin/end 不配平）：\n${s.slice(0, 160)}`)
    }
  })

  it('★ 双语句体的 trg_resolutions_merge 整条出来 —— A-1 死在它身上', () => {
    const { sql } = latestSchema()
    const hit = splitSql(sql).filter((s) => /trg_resolutions_merge/i.test(s))
    assert.equal(hit.length, 1, `应该恰好一条，实际 ${hit.length} 条`)
    const s = hit[0] as string
    assert.match(s, /create\s+trigger/i)
    assert.match(s, /\bend\s*$/i, '结尾不是 end —— 这正是 A-1 的病征')
    // 体内确实有两条语句（否则这条用例挑错了对象）
    assert.ok(
      (s.match(/;/g) ?? []).length >= 2,
      '这个触发器体内不足两条语句，用例挑错了对象'
    )
  })

  it('★★ 负对照：插件那套坏切法在同一份 schema 上必须失败', () => {
    const { sql } = latestSchema()
    const bad = brokenSplitLikePlugin(sql)
    const hit = bad.filter((s) => /trg_resolutions_merge/i.test(s))
    const whole = hit.find((s) => /\bend\s*$/i.test(s.trim()))
    assert.equal(
      whole,
      undefined,
      '★ 坏切法居然也切对了 —— 那说明这组用例没有在验 A-1，换个对象重写'
    )
  })

  it('case…end 嵌在触发器体内，不提前收尾', () => {
    const sql = `
      create trigger t after insert on x begin
        update x set k = case when new.a is null then 'p' else 'q' end;
        update x set n = n + 1;
      end;
      create table y (id integer);
    `
    const parts = splitSql(sql)
    assert.equal(parts.length, 2, `应切成 2 条，实际 ${parts.length}：\n${parts.join('\n--\n')}`)
    assert.match(parts[0] as string, /^create trigger/i)
    assert.match(parts[1] as string, /^create table y/i)
  })

  it("字符串里的分号和 end 不算数（SQLite 只有 '' 是转义）", () => {
    const parts = splitSql(`insert into t values ('a;b', 'end', 'c\d');\nselect 1;`)
    assert.equal(parts.length, 2)
    assert.match(parts[0] as string, /'a;b'/)
  })

  it('双写引号 —— 里面那个分号仍然不算边界', () => {
    const parts = splitSql(`insert into t values ('it''s; fine');\nselect 2;`)
    assert.equal(parts.length, 2)
  })

  it('注释里的分号不算边界', () => {
    const parts = splitSql(`-- a; b\nselect 1;\n/* c; d */\nselect 2;`)
    assert.equal(parts.length, 2)
  })

  it('末尾没有分号也不丢最后一条', () => {
    assert.equal(splitSql('select 1;\nselect 2').length, 2)
  })

  it('空白与纯注释不产出空语句', () => {
    assert.deepEqual(splitSql('  \n\n  '), [])
    assert.equal(splitSql(';;;\nselect 1;').length, 1)
  })
})
