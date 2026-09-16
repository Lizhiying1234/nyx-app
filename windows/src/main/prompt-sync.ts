import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import promptHistory from './prompt-history.json' with { type: 'json' }

/**
 * 升级时怎么处理使用者那份提示词 · I-113
 *
 * ── 问题是怎么暴露的 ──────────────────────────────────────
 *
 * D-213 说提示词是文件、使用者可以自己改；I-106 把他改的那份挪到 `data/prompts/`，
 * 出厂那份只当种子，**升级一个字不动他那份** —— 保护他的编辑，方向是对的。
 *
 * 但装完新版之后一查：他的 `analyse-item.md` 还带着 12 处 `hold sway`
 * （I-108 那个污染源），`generate-questions.md` 里没有 `{{TYPES}}`，
 * `tutor-chat.md` 里没有 Enlighten/Quest。
 * 也就是说：**这几轮改提示词的工作，对他全部落空，而且不报错。**
 * 题型复选框会点、会存，就是不生效 —— 最难查的那一类。
 *
 * ── 判据 ────────────────────────────────────────────────
 *
 * 核心矛盾是「不能覆盖他的编辑」和「不能留一份跑不起来的提示词」。
 * 用两条判据把它拆开：
 *
 *   ① **他动过没有** —— 播种时记下当时的内容指纹。
 *      现在的文件和指纹一致 = 他没动过 → 直接更新，他不会有任何损失。
 *   ② **这份还能不能用** —— 出厂版里有哪些 `{{占位符}}`，他那份必须都有。
 *      缺了就是**结构上跑不起来**：代码会去填一个不存在的位置，
 *      结果就是那个功能悄悄失效。
 *
 * 组合起来：
 *
 * | 指纹 | 占位符齐 | 做什么 |
 * |---|---|---|
 * | 一致（没动过） | — | 直接更新 |
 * | 不一致（他改过） | 齐 | **不动**，只提示「出厂有新版」 |
 * | 不一致（他改过） | 缺 | 他那份**另存**到 `_旧版本/`，装上新的，并说清楚 |
 * | 没有记录 | 齐 | 不动，把当前内容记成基线 |
 * | 没有记录 | 缺 | 同「改过且缺」——另存 + 更新 |
 *
 * **一个字都不删。** 就算判定要换掉，也是先另存再覆盖 ——
 * 我删过他 22 本词典，这条边界不再靠自觉。
 */

/**
 * 全部历史出厂版的指纹（`scripts/prompt-history.mjs` 从 git 里生成）。
 *
 * 判「他动过没有」本来只靠播种时记的指纹，但**老版本没记** ——
 * 装完新版一跑，11 份都被判成「他改过」而不敢动，
 * 其中就有还带着 12 处 hold sway 污染的 analyse-item.md。
 * 判据太保守的代价，是那些改进对他全部落空。
 *
 * 他那份的指纹只要出现在这份历史里，就说明它是某一版的**原样出厂内容** ——
 * 他没动过，可以放心更新。
 */
const HISTORY = promptHistory as Record<string, string[]>

const sha = (s: string): string => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)

/** 一份提示词里用到的全部 `{{占位符}}` */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))]
}

export interface PromptSyncResult {
  updated: string[]
  /** 他改过、而且还能用 —— 只提示，不动 */
  kept: string[]
  /** 他改过、但结构上跑不起来 —— 另存后换新的 */
  replaced: { file: string; savedTo: string }[]
  /**
   * ★ 已经退役的：他目录里有，而这一版**不再带**了（2026-09-03）
   *
   * 从哪来的：一个功能被删掉之后，它的提示词从仓库里删了，
   * 但**他 `data/prompts` 里那份是一次性播种的，谁也不会去动它** ——
   * 于是留在那儿，看着像还有用。
   * 实测他库里就有三份：`drill-check.md` `drill-more.md`（小操练）·
   * `pick-materials.md`（精选材料）。
   *
   * ★★★ **只报，不删。** 这个文件顶上那条规矩「一个字都不删」
   *   （理由是我删过他 22 本词典）在这里同样成立 ——
   *   他可能在里面写过自己的东西，而「反正没用了」不是我替他删的理由。
   */
  retired: string[]
  notes: string[]
}

export interface SeedStore {
  get(file: string): string | null
  set(file: string, hash: string): void
}

/**
 * @param shipped 出厂那份目录
 * @param live    他真正在用的那份目录（`data/prompts`）
 * @param store   指纹存哪儿（走 settings 表，跟着备份和同步走）
 */
export function syncPrompts(shipped: string, live: string, store: SeedStore): PromptSyncResult {
  const out: PromptSyncResult = { updated: [], kept: [], replaced: [], notes: [], retired: [] }
  if (!existsSync(shipped)) return out
  mkdirSync(live, { recursive: true })

  const shippedNames = new Set(
    readdirSync(shipped).filter((x) => x.toLowerCase().endsWith('.md'))
  )

  /**
   * ★ 他目录里有、这一版不带的 —— 退役的提示词。
   * `_旧版本` 这类子目录不算（`readdirSync` 会把目录名也列出来，
   * 但它们不以 .md 结尾，上面的过滤已经挡掉）。
   */
  if (existsSync(live)) {
    for (const f of readdirSync(live)) {
      if (!f.toLowerCase().endsWith('.md')) continue
      if (!shippedNames.has(f)) out.retired.push(f)
    }
  }

  for (const f of readdirSync(shipped)) {
    if (!f.toLowerCase().endsWith('.md')) continue
    const src = join(shipped, f)
    const dst = join(live, f)
    const shippedText = readFileSync(src, 'utf8')

    if (!existsSync(dst)) {
      copyFileSync(src, dst)
      store.set(f, sha(shippedText))
      out.updated.push(f)
      continue
    }

    const liveText = readFileSync(dst, 'utf8')
    if (sha(liveText) === sha(shippedText)) {
      // 已经是最新的了
      store.set(f, sha(shippedText))
      continue
    }

    const recorded = store.get(f)
    const liveHash = sha(liveText)
    const untouched =
      (recorded !== null && recorded === liveHash) ||
      // 没有记录时退到历史出厂版：指纹在里面 = 这就是某一版的原样内容
      (HISTORY[f] ?? []).includes(liveHash)

    if (untouched) {
      copyFileSync(src, dst)
      store.set(f, sha(shippedText))
      out.updated.push(f)
      continue
    }

    // 到这里说明：他改过，或者我们不知道（老版本没记指纹）
    const need = placeholders(shippedText)
    const has = placeholders(liveText)
    const missing = need.filter((p) => !has.includes(p))

    if (missing.length === 0) {
      out.kept.push(f)
      // 没有记录的话，把当前内容记成基线 —— 下次升级才判断得了
      if (recorded === null) store.set(f, sha(liveText))
      continue
    }

    /**
     * 结构上跑不起来：代码要填的位置在他那份里不存在。
     * 留着 = 那个功能悄悄失效且不报错。所以换掉，**但先另存**。
     */
    const backupDir = join(live, '_旧版本')
    mkdirSync(backupDir, { recursive: true })
    const stampName = f.replace(/\.md$/i, '') + '-' + new Date().toISOString().slice(0, 10) + '.md'
    const savedTo = join(backupDir, stampName)
    writeFileSync(savedTo, liveText, 'utf8')
    copyFileSync(src, dst)
    store.set(f, sha(shippedText))
    out.replaced.push({ file: f, savedTo })
    out.notes.push(
      `${f}：你改过的那份缺了 ${missing.map((m) => '{{' + m + '}}').join('、')}，` +
        `新功能会用到它们。已换成新版，你原来那份存在 ${savedTo}`
    )
  }

  if (out.updated.length > 0) out.notes.unshift(`提示词更新了 ${out.updated.length} 份`)
  if (out.kept.length > 0) {
    out.notes.push(`这些是你改过的，没动：${out.kept.join('、')}（出厂有新版，想换自己对照着改）`)
  }
  return out
}
