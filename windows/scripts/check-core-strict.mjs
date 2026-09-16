/**
 * check:core-strict · **core 在 Android 那套编译器设置下也得编得过**（T-9.16 · 2026-09-08）
 *
 * ── 它抓的是哪一种事故 ────────────────────────────────────
 *
 * `src/core/` 两端共用同一份源码（D-238 / D-365），Android 经 submodule 消费。
 * 而两仓的 `tsconfig` 不一样：**那边开着 `noUncheckedIndexedAccess`，本仓没开**。
 * 于是本仓 `check` 绿、`gate` 绿、`verify` 绿，同一份 core 在对面**编译不过**。
 *
 * 2026-09-08 真踩到（T-9.13）：`core/dedup/plan.ts::pickCanonical` 末尾
 * `return [...items].sort(…)[0]` —— 在那条设置下类型是 `DedupItem | undefined`，
 * 而函数声明返回 `DedupItem`。本仓这边**一个字都不会报**，
 * 要等另一个仓的另一个人第一次 import 它才炸。
 *
 * PLAN HEALTH RULES 那句「Windows gate 绿 ≠ core 在 Android 编得过」，
 * 靠人记着是守不住的（这个项目为「靠记得」翻过好几次车）。所以做成一道闸。
 *
 * ── 判据 ──────────────────────────────────────────────────
 *
 * 拿 `tsconfig.core-strict.json` 把 `src/core` 的**生产代码**再编一遍，零错误才算过。
 * 排除 `*.test.ts` 的理由写在那份 tsconfig 的文件头里（一句话：Android 编不到它们，
 * 算进来是假红）。
 *
 * ★ 有意不做的：不判「代码该怎么写」。同一件事有好几种写法能过
 *   （解构后判 `undefined` · `?? 兜底` · 先 `find` 再判），选哪种是写的人的事。
 *   这道闸只回答一句：**这份 core，对面编得过吗。**
 *
 * 用法：node scripts/check-core-strict.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const NL = String.fromCharCode(10)
const CONF = 'tsconfig.core-strict.json'

if (!existsSync(CONF)) {
  console.error(`✗ check:core-strict　找不到 ${CONF} —— 判据没了，这道闸就是摆设`)
  process.exit(1)
}

/**
 * ★ `shell: true`：Node 18.20+ 起不经 shell 直接执行 `.cmd` 会失败
 *   （`gate-android.mjs` / `build-if-stale.mjs` 头上都记着这一笔）。
 */
const r = spawnSync(`npx tsc --noEmit -p ${CONF}`, { shell: true, encoding: 'utf8' })
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()

if (r.status === 0) {
  console.log(
    `✓ check:core-strict　src/core 的生产代码在 noUncheckedIndexedAccess 下零错误` +
      `（= Android 那套设置；用例文件按 ${CONF} 头注排除）`
  )
  process.exit(0)
}

console.error(`${NL}✗ check:core-strict　core 在 Android 那套编译器设置下编不过：${NL}`)
console.error(out)
console.error(
  `${NL}  ── 这是什么意思 ────────────────────────────────────────` +
    `${NL}  本仓的 check / gate 会照样全绿 —— 因为本仓没开 noUncheckedIndexedAccess。` +
    `${NL}  但 src/core 是**两端共用的同一份源码**，Android 那边开着它：` +
    `${NL}  这样的写法一旦合进去，那边下一次提 nyx-core 指针就**编译不过**（T-9.13 真踩过）。` +
    `${NL}` +
    `${NL}  ── 怎么办 ──────────────────────────────────────────────` +
    `${NL}  · \`arr[0]\` / \`arr.at(0)\` 的类型在那边是 \`T | undefined\`。` +
    `${NL}    **别用 \`!\`**（那是「我保证不会」），也别指望 \`arr.length\` 的判断能收窄它 ——` +
    `${NL}    TS 没有这条推理。把值取出来再判 \`undefined\`（解构 / find / ?? 兜底都行）。` +
    `${NL}  · 参照 \`src/core/dedup/plan.ts::pickCanonical\`：解构出 head、判 undefined、` +
    `${NL}    再 reduce —— 判据一个字没改，只是换了个编译器认得的写法。`
)
process.exit(1)
