/**
 * check:guide-ids · 页面内引导的 id 只有一份名单（Z-5，2026-09-15）
 *
 * ══ 病 ══════════════════════════════════════════════════════
 * 第二层引导（D-484）靠一个 id 把「屏上哪一块」和「说哪句话」接起来。
 * 这条接线**两头都不会报错**：
 *   · 屏上写了一个名单里没有的 id  → 那一条**永远不出**，静悄悄没有；
 *   · 名单里加了一条没人引用的 id  → 那句话**永远弹不出来**，也静悄悄没有。
 * `08c9c52` 差点就漏了一条。两端共用同一份 `PAGE_GUIDES`（Android 经 submodule
 * 拿同一个文件），所以这道闸守的是两端。
 *
 * ══ 判据 ════════════════════════════════════════════════════
 *   ① 渲染层出现的每个引导 id（`data-guide` · `askGuide(` · `shouldShowGuide(`）
 *      都在 `src/core/onboarding.ts` 的 `PAGE_GUIDES` 里；
 *   ② `PAGE_GUIDES` 里每个 id 都**同时有触发点和目标**；缺任一边的写进下面的
 *      `PENDING`，**只许缩短**。
 *
 * ══ ★★★ T-5（2026-09-15）· 为什么必须**成对**判，而不是「被引用过」就算 ══
 * 这道闸第一版（Z-5，我写的）判的是「id 在名单里 ＋ 被引用过」。
 * 而 `askGuide('assist-lecture')` 就算一次引用 —— 于是一条
 * **有触发、全仓没有任何 `data-guide` 目标**的引导，闸是**绿的**，
 * 而它在任何人、任何库、任何时候都**永远不会出现**：
 * `PageGuide` 量不到目标就走 `onmiss` 静默放弃，屏上一声不响。
 * 使用者 2026-09-15 报「页内引导没出现」，查下去才挖出这一条。
 *
 * ★ 一条引导要活着，需要**两头都在**：谁来问（触发）· 指着哪儿（目标）。
 *   闸只钉其中一半，就等于给另一半发了通行证。
 * ★ 同族的话已经说过两次（Z-7 的「覆盖面由文件名正则决定而没人核」）：
 *   **闸的判据比它该管的事窄，而没有任何东西在核对这件事。**
 *
 * ★ 名单**从 core 读，不在这里手抄**：手抄的那一份当天就会烂
 *   （`tests/guides.ts` 头注记着这件事真发生过）。
 * ★ **不扫注释**（共用 `lib/strip-comments.mjs`）：注释里提一嘴某个 id 不算引用，
 *   否则「这一条还有人用」会被一句说明骗过去 —— 这一轮栽过三次的同一个坑。
 * ★ 扫的是 `src/renderer`：`data-guide` 是屏上的东西。主进程不出引导。
 *
 * ══ 它**不**看什么 ═══════════════════════════════════════════
 * 不判那句 `says` 写得好不好，也不判这一条该不该出（那是产品的事）。
 * 只回答「两头接上了没有」。
 *
 * 用法：node scripts/check-guide-ids.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripSource } from './lib/strip-comments.mjs'

const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..').split(BS).join('/')

/**
 * 名单里有、但**两头没配齐**的 id。**只许缩短**。
 * ★ 每一条都要写清：**缺哪一边 · 归谁 · 哪天进来的**。
 *   不写的话，下一个人只知道「它被放行了」，不知道该去补什么、该找谁。
 * ★ 往里加之前先想清楚：是「这一屏还没做」（可以进来），
 *   还是「这一条已经不要了」（那就从 `PAGE_GUIDES` 里删掉，别放这儿养着）。
 */
const PENDING = [
  /**
   * ★ 2026-09-15 空了一次：`assist-lecture` 本来就有目标，只是**经 prop 传**
   *   （`<PathPicker guide="assist-lecture">` → 组件内 `data-guide={guide}`），字面 grep 是 0。
   *   A 把它改成字面写在那一行上，这道闸随即报「两头配齐了，从 PENDING 拿掉」—— 于是拿掉。
   * ★ 这道闸**只认字面**（主控 2026-09-15 裁）：经 prop 传的一律不认，让代码迁就闸。
   *   理由不是闸懒，是**只有作者读得懂的标记等于没有** —— 下一个人 grep 一次就该看见它。
   */
  /**
   * `capture-entry`（覆盖面清单第 14 条）· **缺两边** · 归 A · 2026-09-15 进来。
   *
   * ★★ 卡在一个**判据冲突**上，不是忘了接：
   *   清单把它的「屏」写成「右键取词」，而 Windows 上**没有这一屏** ——
   *   它说的那件事（「在别的软件里选中一段英文按右键，就能收进 Nyx」）
   *   是 Assist 这个功能，而 Assist 的配置页 **已经有 `assist-lecture` 了**。
   *   同一页放两条违反 CR-3 的「每页 ≤ 1 件」，那条规矩是使用者自己定的。
   * ★ A 提的三种出路（等主控裁，D-413）：
   *   甲 放 Settings › Assist 的**总开关**那一行，把 `assist-lecture` 降级并进那一条里说
   *      —— 一页仍然一条，但要改一条已经交付的引导；
   *   乙 认「Assist 这一页值两条」，就地放开 CR-3 —— 要使用者点头；
   *   丙 这一条不做，从 `PAGE_GUIDES` 里删掉 —— 它讲的东西在**第一层第 2 步**已经讲过一次
   *      （「在任何程序里划中一个词…」），可能本来就不必再讲第二遍。
   *   ★ A 倾向**丙**：判准问「第一次容易不理解吗」，而这件事第一层已经正面讲过。
   */
]

/**
 * ★★★ **这一端根本没有那一屏** —— 永久名单，和上面那张 `PENDING` 是两回事。
 *
 * ══ 为什么要两张，不能合成一张 ═════════════════════════════════
 * `PENDING` 说的是「**还没做**」：它有寿命，只许缩短，每条写清缺哪边 / 归谁 / 哪天。
 * 这一张说的是「**不会做**」：`PAGE_GUIDES` 是两端共用的一份名单（core，D-238），
 * 而两端的屏**本来就不一样** —— 使用者 2026-09-15 裁「只做自己有的屏」。
 * 合成一张的话，一条永远不会补上的条目会一直挂在「待补」里，
 * 而**「待补 N 条」这个数字从此不再是欠账** —— 那正是这道闸唯一在报的数。
 *
 * ══ 一条进来要满足什么 ════════════════════════════════════════
 *   · `id` 在 `PAGE_GUIDES` 里（不在就该从那份名单删掉，不是放这儿养着）；
 *   · `why` 写清**这一端为什么没有那一屏** —— 要指得出出处（他哪天裁的 / 哪条决议）。
 *     「暂时没做」不是理由，那是 `PENDING`。
 *   · 不许同时出现在 `PENDING` 里 —— 两张名单说的是相反的事。
 *
 * ══ 它怎么变红 ════════════════════════════════════════════════
 * 名单里的 id **一旦在这一端的屏上长出触发点或目标，当场红**：
 * 那说明这一端已经有那一屏了，条目该拿掉。
 * ☞ 这一条是这张名单的全部价值 —— 否则它就是个「以后没人管」的白名单，
 *   和这一轮反复撞的那种假绿一模一样。
 *
 * ── Windows 这一端现在是空的，但机制先立着 ────────────────────
 * 已核过、**将来要进来**的一条（等 A 把 id 加进 `PAGE_GUIDES` 再落）：
 *   · Assist 那颗「模式开关星」—— Windows 没有这个控件。
 *     `Bubble.svelte` 头注抄着他的原话：「桌面悬浮图标本身**不负责在 Point 和
 *     Glance 之间切换**，只负责当前所选模式的开 / 关」，模式在设置里选。
 * 已核过、**不进这张名单**的一条：
 *   · 练习里那颗「需要提示」（按下去记一次认读失败、把那张卡的间隔打回，D-138）——
 *     Windows **有**（`Practice.svelte` 那颗 `data-testid="hint"`），该挂靶子。
 */
const NOT_ON_THIS_END = [
  {
    id: 'assist-star',
    why:
      'Windows 没有「模式开关星」这个控件。`Bubble.svelte` 头注抄着使用者的原话：' +
      '「桌面悬浮图标本身**不负责在 Point 和 Glance 之间切换**，只负责当前所选模式的开 / 关」——' +
      '模式在设置里选，桌面上那颗球不是模式开关；`Stars.svelte` 是纯装饰（aria-hidden）。' +
      '出处：使用者 2026-09-14 晚给 Bubble 的原话 · B 2026-09-15 核 · 主控当日裁「只做自己有的屏」。' +
      '★ 另一半原因是**够不着**：那颗球是一个置顶的独立窗口，而引导浮层挂在主窗口上，' +
      '就算把靶子挂上去也量不到 —— 和查词卡外面那张同一个形状。'
  }
]

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name).split(BS).join('/')
    if (e.isDirectory()) walk(full, out)
    else if (/[.](svelte|ts)$/.test(e.name)) out.push(full)
  }
  return out
}

const mod = await import(pathToFileURL(join(ROOT, 'src/core/onboarding.ts')).href)
const known = new Set(mod.PAGE_GUIDES.map((g) => g.id))

/**
 * 两头分开认，**都只认字面量**。
 * ★ `data-guide={guide}` 那种透传拿不到字面量 —— 它的真身在传值那一处：
 *   传字面量会被认到；传变量就等于没接，而没接本来就该被 ② 挑出来。
 */
/** 指着哪儿 —— 屏上那个被圈出来的元素 */
const TARGET = [
  /data-guide="([a-z0-9-]+)"/g,
  /data-guide=[{][^}]*['"]([a-z0-9-]+)['"][^}]*[}]/g
]
/** 谁来问 —— 页面说「我这儿碰到 X 了」 */
const TRIGGER = [
  /askGuide[(]s*['"]([a-z0-9-]+)['"]/g,
  /shouldShowGuide[(]s*['"]([a-z0-9-]+)['"]/g
]

const targets = new Map()
const triggers = new Map()
for (const f of walk(join(ROOT, 'src/renderer'))) {
  const src = stripSource(readFileSync(f, 'utf8'), f)
  const rel = f.slice(ROOT.length + 1)
  for (const [res, into] of [[TARGET, targets], [TRIGGER, triggers]]) {
    for (const re of res) {
      for (const m of src.matchAll(re)) if (!into.has(m[1])) into.set(m[1], rel)
    }
  }
}
/** 两头合起来 —— ① 用它判「屏上写的 id 名单里有没有」 */
const used = new Map([...targets, ...triggers])

const bad = []
for (const [id, where] of used) {
  if (!known.has(id)) {
    bad.push(
      `屏上写着引导 id「${id}」（${where}），而 PAGE_GUIDES 里没有它` +
        ` —— 那一条永远不会出现，而且不会报错`
    )
  }
}
const allowed = new Map(PENDING.map((p) => [p.id, p]))
/** ★ 成对判：缺哪一边就说哪一边，别只说「没接上」—— 那句话不告诉人该去补什么 */
const pairOf = (id) => ({ t: triggers.has(id), g: targets.has(id) })
const notHere = new Map(NOT_ON_THIS_END.map((p) => [p.id, p]))
for (const id of known) {
  const { t, g } = pairOf(id)
  if (t && g) continue
  if (allowed.has(id)) continue
  if (notHere.has(id)) continue
  const lack = !t && !g ? '触发点和目标都没有' : !g ? '有触发点、**没有目标**' : '有目标、**没人触发**'
  bad.push(
    `PAGE_GUIDES 里的「${id}」${lack} —— 它永远不会出现，而且不会报错。` +
      ` 两头都补上，或者写进 PENDING（要写清缺哪边 / 归谁 / 哪天）`
  )
}
for (const p of PENDING) {
  if (!p || typeof p.id !== 'string') { bad.push('PENDING 里有一条没写 id'); continue }
  for (const k of ['lack', 'who', 'since', 'why']) {
    if (!p[k]) bad.push(`PENDING 的「${p.id}」少写了「${k}」—— 放行必须说清缺哪边、归谁、哪天、为什么`)
  }
  if (!known.has(p.id)) bad.push(`PENDING 里的「${p.id}」已经不在 PAGE_GUIDES 里了，删掉这一条`)
  else {
    const { t, g } = pairOf(p.id)
    if (t && g) {
      bad.push(
        `PENDING 里的「${p.id}」两头都配齐了（触发 ${triggers.get(p.id)} · 目标 ${targets.get(p.id)}）` +
          ` —— 从 PENDING 里拿掉。放行名单只许缩短`
      )
    }
  }
}

for (const p of NOT_ON_THIS_END) {
  if (!p || typeof p.id !== 'string') {
    bad.push('NOT_ON_THIS_END 里有一条没写 id')
    continue
  }
  if (!p.why) {
    bad.push(
      `NOT_ON_THIS_END 的「${p.id}」没写 why ——` +
        ' 这张名单是永久的，不写理由等于永久开一个没人记得为什么的口子'
    )
  }
  if (!known.has(p.id)) {
    bad.push(
      `NOT_ON_THIS_END 里的「${p.id}」已经不在 PAGE_GUIDES 里了 ——` +
        ' 删掉这一条（名单上没有的 id，这张表不该替它留位）'
    )
    continue
  }
  if (allowed.has(p.id)) {
    bad.push(
      `「${p.id}」同时在 PENDING 和 NOT_ON_THIS_END 里 ——` +
        ' 两张名单说的是相反的事（还没做 / 不会做），只能选一张'
    )
  }
  const { t, g } = pairOf(p.id)
  if (t || g) {
    const has = t && g ? `触发点（${triggers.get(p.id)}）和目标（${targets.get(p.id)}）` :
      g ? `目标（${targets.get(p.id)}）` : `触发点（${triggers.get(p.id)}）`
    bad.push(
      `NOT_ON_THIS_END 里的「${p.id}」在这一端的屏上已经有${has} ——` +
        ' 说明这一端现在有那一屏了，把它从这张名单里拿掉（两头配齐）'
    )
  }
}

if (bad.length > 0) {
  console.error('✖ check:guide-ids —— ' + bad.length + ' 条')
  console.error(bad.map((b) => '  ' + b).join(NL))
  console.error('')
  console.error('★ 名单只有一份：src/core/onboarding.ts 的 PAGE_GUIDES（Android 经 submodule 用同一份）。')
  process.exit(1)
}

const paired = [...known].filter((id) => triggers.has(id) && targets.has(id)).length
console.log(
  'check:guide-ids　' +
    known.size +
    ' 条引导 id · 触发与目标**都配齐**的 ' +
    paired +
    ' 条（触发 ' +
    triggers.size +
    ' · 目标 ' +
    targets.size +
    '）· 待补 ' +
    PENDING.length +
    ' 条' +
    /**
     * ★ 每个数**紧跟自己的明细**。上一版我把这个数插在 PENDING 的明细前面，
     *   摘要读出来是「这一端没有那一屏的 1 条：capture-entry（缺两边都缺…）」——
     *   明细挂到了另一个数后面，**报出来的话是错的**。数和它的注脚要贴在一起。
     */
    (PENDING.length ? '（' + PENDING.map((p) => `${p.id} 缺${p.lack}，${p.who}`).join(' · ') + '）' : '') +
    ' · 这一端没有那一屏的 ' +
    NOT_ON_THIS_END.length +
    ' 条' +
    (NOT_ON_THIS_END.length ? '（' + NOT_ON_THIS_END.map((p) => p.id).join(' · ') + '）' : '')
)
