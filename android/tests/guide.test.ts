/**
 * ══ GD · 页面内功能引导（第二层 · 使用者 2026-09-15 第二～六条）★ ═══
 *
 * 判据全在 core（`PAGE_GUIDES` / `shouldShowGuide` / `parseGuideSeen`）。
 * 这一组盯本端接线，四件事各有一种**安静的**坏法：
 *
 *   ① 记号写错表 —— 写进 `user_preferences` 就跟着同步走，
 *      于是「在电脑上看过了」让这台手机永远见不到它。两边都不报错。
 *   ② `version` +1 之后**重弹了全部**而不是只重弹那一条 ——
 *      使用者第六条明写「不是重新把整个软件从头介绍一遍」。
 *   ③ `data-guide` 上的 id **拼错**或不在 core 名单里 ——
 *      `shouldShowGuide` 对认不出的 id 一律 false：那一条**永远不出，而且不报错**。
 *      core 的注释点名说这一条「Android 已经把 practice-settle 写进真机了，差点真发生」。
 *   ④ B-8（进度条）Android **不做** —— 它得是「写明不做」，不是「漏做」。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUIDE_SEEN_KEY, PAGE_GUIDES, shouldShowGuide } from '../src/core-link.ts'
import { clearGuideSeen, guideSeen, markGuideSeen } from '../src/db/guide.ts'
import { builtDb, cleanup } from './helpers.ts'

after(cleanup)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 本仓源码里所有 `data-guide="..."`（含文件，给报错时指路用） */
function markers(): { id: string; file: string }[] {
  const out: { id: string; file: string }[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'nyx-core') continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.svelte') || p.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/data-guide="([^"]+)"/g)) {
          out.push({ id: m[1]!, file: p.slice(ROOT.length + 1).replace(/\\/g, '/') })
        }
      }
    }
  }
  walk(join(ROOT, 'src'))
  return out
}

describe('GD · 页面内功能引导（接线）', () => {
  it('GD-1 · 新库：一条都没看过 → 名单里每一条都该出', async () => {
    const f = builtDb()
    const seen = await guideSeen(f.db)
    assert.deepEqual(seen, {}, '★ 空库里不该有这一行')
    for (const g of PAGE_GUIDES) {
      assert.equal(shouldShowGuide(seen, g.id, g.version), true, `★ ${g.id} 该出却说不出`)
    }
  })

  it('GD-2 · 看过一条 → 只有那一条不再出，其余照出', async () => {
    const f = builtDb()
    await markGuideSeen(f.db, 'vault-hard', 1)
    const seen = await guideSeen(f.db)

    assert.equal(shouldShowGuide(seen, 'vault-hard', 1), false, '★ 看过了还出 —— 他会被同一句话反复打扰')
    for (const g of PAGE_GUIDES.filter((x) => x.id !== 'vault-hard')) {
      assert.equal(
        shouldShowGuide(seen, g.id, g.version),
        true,
        `★★ 看过一条把 ${g.id} 也带没了 —— 那是「整套只出一次」，不是他要的`
      )
    }
  })

  it('★★ GD-3 · 内容 +1 → **只有那一条**重出一次（使用者第六条）', async () => {
    const f = builtDb()
    // 七条全看过（各记当时的 version）
    for (const g of PAGE_GUIDES) await markGuideSeen(f.db, g.id, g.version)
    const seen = await guideSeen(f.db)
    for (const g of PAGE_GUIDES) {
      assert.equal(shouldShowGuide(seen, g.id, g.version), false, `★ ${g.id} 看过了还出`)
    }

    // 其中一条的内容变了（version +1）
    const bumped = PAGE_GUIDES[0]!
    assert.equal(
      shouldShowGuide(seen, bumped.id, bumped.version + 1),
      true,
      '★★ 内容改了却不重弹 —— 使用者第六条要的正是这一件'
    )
    for (const g of PAGE_GUIDES.filter((x) => x.id !== bumped.id)) {
      assert.equal(
        shouldShowGuide(seen, g.id, g.version),
        false,
        `★★★ ${g.id} 跟着一起重弹了 —— 那就是「把整个软件从头介绍一遍」，他明写不要`
      )
    }
  })

  it('GD-4 · 记号进 settings，不进同步表（换台设备该重看）', async () => {
    const f = builtDb()
    await markGuideSeen(f.db, 'lookup-save', 1)

    const dev = await f.db.get(`select value from settings where key = ?`, [GUIDE_SEEN_KEY])
    assert.ok(dev?.['value'], '★ 不在 settings 里')
    const synced = await f.db.all(`select key from user_preferences where key like ?`, ['%guide%'])
    assert.deepEqual(
      synced,
      [],
      '★★ 它进了同步表 —— 「在电脑上看过了」会让这台手机永远见不到这几句话'
    )
  })

  it('GD-5 · 「把页面引导重新打开」→ 名单里每一条又都出', async () => {
    const f = builtDb()
    for (const g of PAGE_GUIDES) await markGuideSeen(f.db, g.id, g.version)
    await clearGuideSeen(f.db)
    const seen = await guideSeen(f.db)
    assert.deepEqual(seen, {})
    for (const g of PAGE_GUIDES) assert.equal(shouldShowGuide(seen, g.id, g.version), true)
  })

  it('GD-6 · 坏值当没看过，不抛（这一层只是多说一句话，不该把页面弄挂）', async () => {
    const f = builtDb()
    for (const bad of ['', '[]', '不是 JSON', '{"vault-hard":"一"}']) {
      await f.db.run(
        `insert into settings (key, value, updated_at) values (?, ?, ?)
           on conflict(key) do update set value = excluded.value`,
        [GUIDE_SEEN_KEY, bad, Date.now()]
      )
      const seen = await guideSeen(f.db)
      assert.equal(
        shouldShowGuide(seen, 'vault-hard', 1),
        true,
        `★ ${JSON.stringify(bad)} 没被当成「没看过」`
      )
    }
  })

  /**
   * ★★★ GD-7 · 屏上那几个标记的 id **必须在 core 名单里**。
   *
   * 拼错一个字母的后果：`shouldShowGuide` 返回 false → 那一条**永远不出**，
   * 而 `check` 绿、`npm test` 绿、屏上也不会说什么。core 的注释点名说
   * 「Nyx-UI-Android 已经把 practice-settle 写进真机了，这一条差点真发生」。
   */
  it('★★★ GD-7 · 每个 data-guide 的 id 都在 core 名单里（拼错=永远不出且不报错）', () => {
    const ids = new Set(PAGE_GUIDES.map((g) => g.id))
    const found = markers()
    assert.ok(found.length > 0, '★ 一个标记都没有 —— 第二层根本没接上')
    for (const m of found) {
      assert.ok(
        ids.has(m.id),
        `★★★ ${m.file} 上的 "${m.id}" 不在 core 的 PAGE_GUIDES 里 —— 那一条永远不出，而且不报错`
      )
    }
  })

  /**
   * ★★ GD-8 · Android 这边**有几个靶子**、以及**哪一个是故意不做的**。
   *
   * `project-progress`（表 B 的 B-8，进度条）：**2026-09-15 使用者裁「两端都删」** ——
   * 本仓项目行上本来就只有条数、没有比例展示，D-348 也禁止「已静默总数」这类统计。
   * 所以这里钉的是「本仓不许给它加靶子」；名单那一侧由 A 在 core 删（8 → 7），
   * 我跟指针时带上。★ 名单删掉之后这条断言仍然成立，**不用改** ——
   *   它问的是「本仓有没有给它加标记」，不是「core 名单里有没有它」。
   * `practice-settle`（B-5）：D 在 `Practice.svelte` 加好并合回了（`6fda856`），
   * 2026-09-15 D 的会话下线后这一处转给本会话盯 —— 见 GD-10。
   */
  /**
   * ★★★ GD-9 · **一次页面停留只出一条**（2026-09-15 真机上抓到的）。
   *
   * 收掉一条 → 遮罩那层从 DOM 摘掉 → **那本身就是一次 childList 变动** →
   * 立刻扫出第二条弹上来。真机上的样子是「点掉一句又冒一句」，
   * 而那一下点 Tab 其实点在了第二条的遮罩上 —— 它被顺手点没了、他一眼没看见，
   * 记号却记下了「看过」。使用者第四条明写「不能变成长篇教程」。
   *
   * ★ `guide.svelte.ts` 是 `.svelte.ts`（带 runes），node 用例导不进来，所以钉源码形状。
   * ★ 先剥注释再看 —— 上面这段说明里就有 `paused` 两个字（今天第五次栽在这上面）。
   */
  it('★★★ GD-9 · 收掉之后要等他走到别处才出下一条（源码形状）', () => {
    const strip = (t: string): string =>
      t.replace(/\/\*[^]*?\*\//g, ' ').replace(/^[ 	]*\/\/.*$/gm, ' ')
    const st = strip(readFileSync(join(ROOT, 'src/ui/lib/guide.svelte.ts'), 'utf8'))
    assert.ok(/close\(\)[^]*?paused = true/.test(st), '★★ 收掉时没挂起 —— 第二条会立刻接着弹')
    assert.ok(/scan\([^]*?this\.paused/.test(st), '★★ 扫的时候没看挂起标记 —— 挂了也没用')
    assert.ok(/resume\(\)/.test(st), '★ 没有解挂的路 —— 那就变成「一辈子只出一条」')

    const app = strip(readFileSync(join(ROOT, 'src/ui/App.svelte'), 'utf8'))
    assert.ok(
      app.includes('guide.resume()'),
      '★★ 没人在导航变化时解挂 —— 走到别的页面也不再出，第二层等于只出一条'
    )
  })

  /**
   * ★★★ GD-10 · 结算屏那个靶子**在结算块上**，不在别处（2026-09-15 D 下线后转本会话）。
   *
   * 为什么要单独钉「在哪一块」而不只是「有没有」：
   *   `practice-settle` 那句话是「答案按四档评，第 3 档以上才算这一次正确」——
   *   它讲的是**判分这件事**。挂到作答区（`{#if !result}` 那半）上的话，
   *   他会在**还没答**的时候被告知「你答对了没」，指着的东西和说的话对不上。
   *   而这种错**四门一道都不会红**：属性放哪儿都编译得过、用例也照样绿。
   *
   * ★ 判据取「这个标记与 `class="verdict"` 在同一个标签上」——
   *   结算块就是 `.verdict`（`db/practice.ts::settleLectures` 那条路的屏上落点）。
   * ★ 先剥注释再看：这个文件头和 `Practice.svelte` 的注释里都写着这个 id。
   */
  it('★★★ GD-10 · practice-settle 挂在结算块（.verdict）上，不在作答区', () => {
    const src = readFileSync(join(ROOT, 'src/ui/views/Practice.svelte'), 'utf8')
      .replace(/<!--[^]*?-->/g, ' ')
      .replace(/\/\*[^]*?\*\//g, ' ')
    const hits = [...src.matchAll(/data-guide="practice-settle"/g)]
    assert.equal(hits.length, 1, `★ 结算屏上这个标记出现了 ${hits.length} 次 —— 该正好一次`)
    assert.ok(
      /<div class="verdict" data-guide="practice-settle">/.test(src),
      '★★★ 标记不在 `.verdict` 那一块上 —— 那句话讲的是判分，挂到作答区就是指着一个东西说另一件事'
    )
  })

  /**
   * ★★★ GD-11 · 引导句里不许用「」点名按钮（D-489 ④ · 与 Windows V-4 同一条）。
   *
   * ══ 它拦什么 ═══════════════════════════════════════════════
   * 按钮名归**那一屏**管，两端本来就不同名 —— 同一句引导在 Windows 说「收下」，
   * 而 Android 那颗按钮叫「收进 Atlas ›」。句子点了名，**按钮一改名它就开始说假话**，
   * 而说假话这件事没有任何东西会报错。
   *
   * ★ 连带把「」整个禁掉，不只禁按钮名：一句 ≤ 30 字的引导里加一对引号，
   *   十有八九就是在点名屏上的某个控件。
   * ★ 判据读的是 **core 的名单**（两端同一份），所以这道闸在两端都能拦同一件事；
   *   Windows 那份在 `src/core/onboarding.test.ts`。
   */
  it('★★★ GD-11 · 引导句里不许用「」点名按钮（按钮改名不该让它说假话）', () => {
    for (const g of PAGE_GUIDES) {
      assert.equal(
        g.says.includes('「'),
        false,
        `★★★ 「${g.id}」那句话里用「」点了名：${g.says}
` +
          '  引导句只说「做完这一下会怎样」—— 按钮叫什么由那一屏自己负责，' +
          '两端的按钮本来就不同名（这一端那颗是「收进 Atlas ›」）'
      )
    }
  })

  it('★★ GD-8 · 本端该有的靶子一个不少；写明不做的一个都没有', () => {
    const have = new Set(markers().map((m) => m.id))
    /**
     * ★★ 覆盖面清单 §二 落地之后（2026-09-15 · core 名单 7 → 17）本端该有的十三条。
     *   ☞ 这张表**不是**「core 名单减去几条」那样算出来的 —— 算出来的表永远自洽，
     *     写错了也不会红。它是逐屏点过的：每一条都在这一端真有那一屏。
     */
    const mine = [
      'lookup-save',
      'assist-lecture',
      'sidebar-tree',
      'vault-learned',
      'vault-hard',
      'practice-settle',
      'lecture-split',
      'trash-tiers',
      'prompt-area',
      'item-analysis',
      'capture-entry',
      'today-recommend',
      'practice-hint-cost'
    ]
    for (const id of mine) assert.ok(have.has(id), `★ 少了靶子：${id}`)

    /**
     * ★★★ 这一端**做不了**的那几条（`NOT_ON_THIS_END`，永久名单）。
     *   逐条不是同一种「不做」：
     *     `today-paste`    没有贴材料的入口（D-311 / D-299）
     *     `filestudy-modes` 没有文件学习那条线（D-311）
     *     `report-layers`   不做报告（D-247）
     *     `assist-star`     ★ **做不了，不是没做**：桌面那颗星是原生 StarView，
     *                       跑在 TYPE_ACCESSIBILITY_OVERLAY 的独立窗口里，
     *                       不在 App 的 WebView 里 —— 第二层扫的是 document，够不着。
     *   ☞ 真给它们加了靶子，`check:guide-ids` 第 ⑤ 条也会当场红
     *     （「永久不做」和「做了」不可能同时是真的）。这里再钉一道，
     *     是因为那道闸只在 `npm run check` 里跑，而这一条跟着 `npm test` 跑。
     */
    for (const id of ['today-paste', 'filestudy-modes', 'report-layers', 'assist-star']) {
      assert.ok(
        !have.has(id),
        `★★★ 这一端给「${id}」加了靶子 —— 它在 NOT_ON_THIS_END 里写着这一端没有那一屏；` +
          '要么这一屏真做出来了（把它从名单里拿掉），要么这个靶子是指空的'
      )
    }

    assert.ok(
      !have.has('project-progress'),
      '★★ 本仓给进度条加了靶子 —— 手机上没有那根条（D-348 也不许补），指着它说话就是指空；' +
        '而且 2026-09-15 使用者已裁「两端都删」'
    )
    assert.ok(
      PAGE_GUIDES.some((g) => g.id === 'practice-settle'),
      '★ core 名单里没有 practice-settle —— 和 D 约定的 id 对不上了'
    )
    assert.ok(have.has('practice-settle'), '★ 结算屏那个靶子没了 —— 见 GD-10')
  })

  /**
   * ★★★ GD-12 · 遮罩上**没有**关闭那条路（编号：合并时与 D 的 GD-11 撞了号，本条让位）（I-192，使用者 2026-09-15 裁「甲」，两端同规）。
   *
   * 这条闸看的是什么：真机上量到的那一步 —— 清表进 Vault，第一条对着「攻坚区」弹出来，
   * 往上一行「全部」点一下，结果是**引导没了、页面也没跳**（那一下被遮罩吃掉），
   * 而 `ui.guide.seen` 已经记成看过。**一次打偏的点 = 这条在这台机上永远不再出现**。
   * 「进页面即出」之后，出现的时刻正压在手指已经在往别处去的那一拍上，所以这不是小概率。
   *
   * 两半都要钉，少一半就等于没钉：
   *   ① 遮罩那层身上不许有任何事件处理器 —— 有 = 又能「点外关」了
   *   ② 遮罩那层不许 `pointer-events:none` —— 有 = 那一下**穿透**下去，
   *      他点「全部」真的会跳走，引导被留在一个已经不存在的页面上
   * 并且要证明「还有别的路能关」，否则把两条路一起删光也能让上面两条绿。
   *
   * ★ 先剥注释：这个文件的注释里就写着「故意没有 onclick」和「点遮罩」，不剥必假绿。
   */
  it('★★★ GD-12 · 点遮罩不关也不穿透，只认「知道了」+ 返回键', () => {
    const raw = readFileSync(join(ROOT, 'src/ui/lib/Guide.svelte'), 'utf8')
    const src = raw.replace(/<!--[^]*?-->/g, ' ').replace(/\/\*[^]*?\*\//g, ' ')

    const tag = src.match(/<div[^>]*gd-wrap[^>]*>/)
    assert.ok(tag, '★ 找不到遮罩那一层（`gd-wrap`）—— 判据落空了，先看这个文件改成什么样了')
    assert.ok(
      !/\son[a-z]+\s*=/.test(tag[0]),
      '★★★ 遮罩那层身上又有事件处理器了 —— 「点外关」加回来了。' +
        '一次打偏的点就会把这条引导永久记成看过，而他一个字没看见（I-192）'
    )

    const css = readFileSync(join(ROOT, 'src/ui/styles/mobile.css'), 'utf8')
    const rule = css.match(/\.gd-wrap\s*\{[^}]*\}/)
    assert.ok(rule, '★ 样式表里没有 `.gd-wrap` 这条规则了')
    assert.ok(
      !/pointer-events\s*:\s*none/.test(rule[0]),
      '★★★ 遮罩改成不吃点击了 —— 那一下会穿透下去真的跳走页面，比关掉还糟'
    )

    assert.ok(
      /知道了[^]*?<\/button>|guide\.close\(\)/.test(src),
      '★ 「知道了」那条路没了'
    )
    assert.ok(
      /registerBack\([^]*?guide\.close\(\)/.test(src),
      '★★ 返回键那条路没了（D-393）—— 两条都没了的话，这个框就关不掉了'
    )
  })
})
