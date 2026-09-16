/**
 * 按 SQLite 语法把一份 .sql 切成一条条语句 · ★★ Android Step 0（2026-08-24）
 *
 * ══ 为什么需要它 ★★★ ══════════════════════════════════════════
 *
 * `@capacitor-community/sqlite` 7.0.3 的 `execute()` 自带一个切分器，
 * 而那个切分器是坏的（UtilsSQLite.java:44）：
 *
 *     String stmts = statements.replace("end;", "END;");
 *     String[] arr = stmts.split(";\n");                   // 按 ";\n" 切
 *     ...
 *     lArray.set(idx - 1, lArray.get(idx - 1) + "; END");  // 只把 END 前【一段】粘回去
 *
 * `begin…end` 里**只有一条语句**的触发器能拼回来；**有两条的拼不回来** ——
 * 第一条被永远留在外面，变成一句没有 end 的残句：
 *
 *     Execute: incomplete input (code 1): , while compiling:
 *     CREATE TRIGGER trg_resolutions_merge ... begin update resolutions set ...;
 *
 * v33 的 29 个触发器里只有 `trg_resolutions_merge` 是双语句体，
 * 2026-08-24 真机第一次跑就是死在它身上（issues.md · A-1）。
 *
 * ══ 处理原则 ★★★ ══════════════════════════════════════════════
 *
 * **schema 一个字都不改。** 改的是搬运方式：这里切好，逐条走 `db.run()`，
 * 那条路不经过插件的切分器（`CapacitorSQLite.java` 里只有 `execute()` 调它），
 * 语句逐字进 `compileStatement()`。
 *
 * ══ 为什么住在 core ★★ ════════════════════════════════════════
 *
 * 它是**承重件**：Android 建库的正确性依赖它切得对。
 * 放在探针目录里，正式端就会各写一份 —— 两份判据，漂了没人知道，
 * 而漂掉的表现是「触发器少了一个」，不报错。
 * 纯字符串进、字符串数组出，没有任何平台依赖，天然过 `purity.test.ts`。
 *
 * ══ 为什么逐字符扫而不用正则 ══════════════════════════════════
 *
 * v33 里同时存在这两样，正则一碰就错：
 *   · `trg_occurrences_uid` 体内嵌着 `case … end` —— 光看 end 会提前收尾
 *   · 同一条里有 '\' '\p' 这类含反斜杠的字符串字面量 ——
 *     SQLite 的字符串里反斜杠**不是**转义符，只有 '' 是
 */

const isWordStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'

const isWord = (c: string): boolean => isWordStart(c) || (c >= '0' && c <= '9') || c === '$'

/**
 * 切成一条条可以单独执行的语句。
 *
 * 注释与空白**原样保留在语句内部**（只 trim 两端）—— 这里不做规范化，
 * 规范化是比对那一步的事（`schema-dump.ts::normalizeDdl`），两件事不要混。
 */
export function splitSql(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  /** 0 = 不在触发器体内。begin 进 1，体内每个 case 再 +1，每个 end -1，归 0 即收尾 */
  let depth = 0
  const n = sql.length

  while (i < n) {
    const c = sql[i] as string

    // -- 行注释
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') {
        cur += sql[i]
        i++
      }
      continue
    }

    // 块注释
    if (c === '/' && sql[i + 1] === '*') {
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        cur += sql[i]
        i++
      }
      cur += sql.slice(i, i + 2)
      i += 2
      continue
    }

    // '字符串' 与 "标识符" —— 里面的分号、begin、end 全部不算数
    if (c === "'" || c === '"') {
      const q = c
      cur += q
      i++
      while (i < n) {
        if (sql[i] === q && sql[i + 1] === q) {
          cur += q + q
          i += 2
          continue
        }
        if (sql[i] === q) {
          cur += q
          i++
          break
        }
        cur += sql[i]
        i++
      }
      continue
    }

    // 关键字
    if (isWordStart(c)) {
      let w = ''
      while (i < n && isWord(sql[i] as string)) {
        w += sql[i]
        i++
      }
      cur += w
      const W = w.toUpperCase()
      if (W === 'BEGIN' && depth === 0 && /create\s+trigger/i.test(cur)) depth = 1
      else if (W === 'CASE' && depth > 0) depth++
      else if (W === 'END' && depth > 0) depth--
      continue
    }

    // 只有 depth 归 0 时的分号才是语句边界
    if (c === ';' && depth === 0) {
      const s = cur.trim()
      if (s) out.push(s)
      cur = ''
      i++
      continue
    }

    cur += c
    i++
  }

  const tail = cur.trim()
  if (tail) out.push(tail)
  return out
}
