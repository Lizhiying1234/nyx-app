/**
 * 钉住一条：**回收站的天数不许写死在屏上的句子里**（2026-09-13）
 *
 * ── 为什么需要 ──────────────────────────────────────────────
 * 使用者 2026-09-13 交办「回收站 30 天改 10 天」。那个数住在 core
 * （`TRASH_DAYS`），一行就能改完 —— 可本仓当时有 **13 处**把「30 天」
 * 写死在界面文案里。只改常量的话：**常量说 10、屏上说 30**，
 * 而错的那一份正对着他的眼睛（D-412 文案必须说真话）。
 *
 * ★ 这类漂移的可怕之处在于**它不会红**：类型对、用例绿、界面照常显示，
 *   只是那句话是假的。所以只能靠一道专门盯文案的闸。
 * ★ core 连句子一起给了（`TRASH_KEEP_TEXT` / `TRASH_PURGE_TEXT`），
 *   所以正确写法是取常量，不是「记得同步改」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRASH_DAYS, TRASH_KEEP_TEXT } from '../src/core-link.ts'

const BLOCK = /\/\*[\s\S]*?\*\//g
const LINE = /^\s*\/\/.*$/gm
const DIGIT_MINUS_FLOOR = /\d+\s*-\s*Math\.floor/g


const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 这一行是不是「把回收站天数写死在句子里」。
 *
 * ★ 判据是**两个条件同时成立**：出现「数字 + 天」**而且**同一行还在谈
 *   回收站这件事。只扫「数字 + 天」会把「近 30 天」这类日期范围判红 ——
 *   而**一个会误报的闸，第一次误报之后就会被下一个人加进白名单，然后失效**
 *   （TOK-2 记着同一笔账）。Windows 那边有过真实反例：样式一览里
 *   一颗 `<button>近 30 天</button>`，那是日期范围，和保留期毫无关系。
 */
function hardcodedTrashDays(line: string): boolean {
  if (!/[0-9]+\s*天/.test(line)) return false
  return /回收站|恢复|反悔|清除|删除|保留|契约|躺/.test(line)
}

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) svelteFiles(p, out)
    else if (e.name.endsWith('.svelte')) out.push(p)
  }
  return out
}

describe('TRASH · 回收站天数只许从 core 取（2026-09-13）', () => {
  it('① 屏上的句子里不许出现写死的天数', () => {
    const bad: string[] = []
    for (const f of svelteFiles(join(ROOT, 'src/ui'))) {
      const lines = readFileSync(f, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        const t = line.trim()
        // 注释里提历史是应该的（那正是记账的地方）
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('<!--')) return
        if (!hardcodedTrashDays(line)) return
        bad.push(`${f.slice(ROOT.length + 1)}:${i + 1} ${t.slice(0, 70)}`)
      })
    }
    assert.deepEqual(
      bad,
      [],
      '★ 这些地方把回收站天数写死在句子里了 —— 常量一改它们就成了假话：\n  ' + bad.join('\n  ')
    )
  })

  it('★ ② 闸本身不许误报 —— 日期范围那类「N 天」是无辜的', () => {
    assert.ok(!hardcodedTrashDays('<button>近 30 天</button>'), '★ 把日期范围判红了')
    assert.ok(!hardcodedTrashDays('最近 7 天查了 491 次'), '★ 把统计口径判红了')
    assert.ok(hardcodedTrashDays('移到回收站，30 天内可以恢复。'), '★ 漏了真该红的')
    assert.ok(hardcodedTrashDays('已删除 1 条 · 回收站放 30 天'), '★ 漏了真该红的')
    assert.ok(hardcodedTrashDays('删掉的东西会在这里躺 10 天 —— 反悔来得及。'), '★ 漏了真该红的')
    assert.ok(hardcodedTrashDays('这次打开按 30 天契约清除了 3 行'), '★ 漏了真该红的')
    /**
     * ★★ 这一句是同侪（Windows）把这张表抄过去之后**第一次跑就抓到的漏**：
     *   他那边 Trash.svelte 空态写的是「删除的项目会在这里保留 30 天。」——
     *   有数字、有「天」，却一个我原来列的词都不沾（它说的是「删除」「保留」，
     *   不是「回收站 / 恢复 / 清除 / 契约 / 躺」）。所以词表补了这两个。
     *   ☞ 我这边眼下没有这种说法（grep 过，0 命中），补的是**判据的漏**，不是现有的红。
     */
    assert.ok(hardcodedTrashDays('删除的项目会在这里保留 30 天。'), '★ 漏了真该红的（同侪抓到的那一句）')
  })

  it('③ core 那两个常量确实跟着 TRASH_DAYS 走', () => {
    assert.ok(TRASH_KEEP_TEXT.includes(String(TRASH_DAYS)), '★ 句子和天数对不上了')
  })
})

describe('TRASH · 天数也不许写死在**算术**里（2026-09-14 真机上抓到的）', () => {
  /**
   * ★★ 上一轮只扫了「句子」。真机上打开回收站看见的是：
   *     标题「放 10 天，之后自动清除」 · 每一行「删于 09-10 · 还剩 26 天」
   *   两个数字同屏打架，而 26 是按 30 天算的 —— 那一行其实 6 天后就没了。
   *   `VaultTrash.svelte` 已经 import 了 TRASH_DAYS（标题那句在用），
   *   只有 `daysLeft` 的算式还写着 30。
   * ★ **数字漂进代码比漂进文案更难看见**：文案还有人读，算式没人会去数。
   */
  const root = new URL('../', import.meta.url)
  const src = readFileSync(new URL('src/ui/views/VaultTrash.svelte', root), 'utf8')
    .replace(BLOCK, '')
    .replace(LINE, '')

  it('倒计时用的是常量，不是写死的数', () => {
    assert.ok(
      src.includes('TRASH_DAYS - Math.floor'),
      '★ 倒计时没在用 TRASH_DAYS —— 屏上会和标题那句打架'
    )
  })

  it('★ 剥掉注释之后，文件里不许再有「某个数 - Math.floor」', () => {
    // ★ 剥注释：上面那段说明里就写着「26」「30」「10 天」，不剥的话闸会扫中自己。
    const bad = src.match(DIGIT_MINUS_FLOOR)
    assert.deepEqual(bad, null, `★ 还有写死的天数在算术里：${(bad || []).join(', ')}`)
  })
})
