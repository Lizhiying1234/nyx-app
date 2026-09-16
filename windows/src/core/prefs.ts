import { natUid } from './identity.ts'

/**
 * 用户偏好 · ★★ Step 5A / F-07 / D-290（2026-08-18）
 *
 * ── 判据：USER 还是 DEVICE ──────────────────────────────────
 *
 *   USER   —— 「他想要什么」        跟着人走，进同步
 *   DEVICE —— 「这台机器怎么实现」  跟着机器走，不同步
 *
 * 不要用「他大概希望跨设备一致吧」当判据（使用者 2026-08-18 明确否掉了这条）。
 * 举例：
 *   · 「语速 1.2×」是他想要的      → USER
 *   · 「用哪个 TTS 后端 / 哪个 AI endpoint」是这台机器怎么实现 → DEVICE
 *
 * 判据不清时看一句话：**换一台设备，这一项应该自动恢复吗？**
 * 应该 → USER；应该重新配一遍 → DEVICE。
 *
 * ── 为什么必须搬出 `settings` ────────────────────────────────
 *
 * `settings` 里混着四类东西：偏好、设备状态、秘密、协议游标。
 * 整张表同步会把 API key 推上云；整张表不同步（现状）则他在电脑上
 * 设的「今日 95 条」「勾了这 10 种题型」换台设备全变回默认，
 * 而他不会想到去手机上再勾一遍。
 *
 * 所以把**只有 USER 那一类**拆出去，单独一张带 uid / updated_at 的表，
 * 进 `SYNC_TABLES`。其余三类原地不动。
 *
 * ── 只能有一个真相 ★★ ──────────────────────────────────────
 *
 * 迁移完成之后 `settings` 里那几个旧键**必须删掉**。
 * 留着 = 双写 = 这个项目已经付过好几次学费的「两份判据」：
 * 读的时候读哪一份？改的时候改哪一份？漂了之后谁说了算？
 * `db-safety` 里有一条扫源码 + 扫真库的用例守着这一点。
 */

/** 一项偏好的规格 */
export interface PrefSpec {
  /** 键名。**和它在 `settings` 里的旧名字一模一样** —— 迁移时 1:1，不用记映射 */
  key: string
  /** 值的形状。迁移和写入都按它校一遍 */
  kind: 'json-array' | 'number' | 'bool' | 'text' | 'json' | 'dict-uid'
  /** 一句话说清它是什么 —— 报错和文档都用它 */
  says: string
}

/**
 * ★★ 会跟着人走的全部偏好。**这份清单就是判据本身。**
 *
 * 不在这份清单里的键一律进不了 `user_preferences`
 * （`checkPrefKey` 会拒），所以「顺手往里塞一个」这条路是堵死的。
 */
import { PROMPT_PREF_SPECS } from './prompt-overrides.ts'
import { QUIZ_PREF_SPECS } from './quiz-rules.ts'

export const PREF_SPECS: readonly PrefSpec[] = [
  { key: 'qtypes', kind: 'json-array', says: '产出练习勾了哪几种题型' },
  { key: 'practice_order', kind: 'json', says: '出题顺序（两层）' },

  { key: 'param.silenceStreak', kind: 'number', says: '练成所需连续正确次数' },
  { key: 'param.hardTrigger', kind: 'number', says: '进攻坚区的触发次数' },
  { key: 'param.graceAttempts', kind: 'number', says: '建立期长度' },
  { key: 'param.minSample', kind: 'number', says: '样本不足的阈值' },
  { key: 'param.readingSilenceDays', kind: 'number', says: '认读线练成阈值（天）' },
  { key: 'param.dailyTarget', kind: 'number', says: '今日练习默认条数' },
  { key: 'param.readingDailyCap', kind: 'number', says: '认读每日软上限' },
  /**
   * ★★ 一次给一条知识点出几道题（使用者 2026-09-08：「一次性出几道可以自己设定，
   * 弄到设置里面自己设定」；D-478 取消档位那一轮）。
   *
   * ★ 归 USER：「我一次要练几道」是**他想要的**，不是这台机器怎么实现 ——
   *   换台设备该自动恢复。
   * ★★ 说清楚是**两件事**（2026-09-15 核过，别再合成一句「手机没有练习设置页」）：
   *   · Android **有**题型页（Settings › PROMPTS ›「题型」→ 编辑 Dialog）；
   *   · **但这一个键在手机上没有入口** —— 那个 Dialog 只有 `guide` / `prompt` 两个框，
   *     `param.questionsPerItem` 只被 `db/practice.ts` 读。所以它靠同步跟着电脑的值走。
   *   合成一句的话，下一个人会以为「手机上什么都设不了」，而题型那一整页都在那儿。
   * ★ 出厂值与上下限在 core 一处（`core/qtype-plan.ts::DEFAULT_QUESTIONS_PER_ITEM`
   *   / `clampQuestionsPerItem`），两端同一份。
   */
  { key: 'param.questionsPerItem', kind: 'number', says: '一次给一条知识点出几道题' },

  /**
   * ★★ 认读牌面：他勾了哪几面、什么顺序（D-479，使用者 2026-09-08）。
   *
   * ★ 归 USER：「我要用哪几种考法」是**他想要的**，换台设备该自动恢复。
   *   出题规则那一份走既有的 `prompt.reading-card`（改义为规则正文）。
   * ★ 形状与出厂值在 core 一处（`core/reading-face.ts::parseFacePrefs` / `READING_FACES`），
   *   两端同一份 —— 「同一份偏好两台机器算出同一份提示词」靠的是这个。
   */
  { key: 'reading.faces', kind: 'json-array', says: '认读牌面勾了哪几面（有序）' },
  /**
   * ★★★ 「五份整段提示词 → 牌面 + 规则」那次一次性迁移的记号**不在这里** ——
   *   它是 DEVICE，存在 `settings` 里（`main/reading-faces.ts`）。
   *
   *   2026-09-08 它在这份白名单里待过一天，`smoke:sync` 的 S7 当场红：
   *   这一行是「第一次读认读状态就无条件写一次」，而偏好行的 uid 由键名算出来 ——
   *   两台机器算出**同一个 uid、各写各的时间戳** = 必然冲突，输掉那一版按 D-438
   *   进 `ops_log`，`sync.applied` 溢出后重放老包再判一次，**重放改变了状态**。
   *   按上面那句判据问「换一台设备该自动恢复吗」：不该 —— 新机器自己判一次，
   *   判不出来它本来就什么都不动。**记号跟着机器走。**
   */

  /**
   * ★★ 语音 · D-466（使用者 2026-09-07「语音设置简化」）—— **只剩四把**。
   *
   * ── 两把开关 ────────────────────────────────────────────
   *
   * 「我要不要词典音 / 系统音」是**他想要的东西**，不是「这台机器怎么实现」——
   * 换一台设备这两项应该自动恢复，所以按本文件开头那句判据归 USER，进同步。
   * 出厂**都是开**（`core/voice/types.ts::DEFAULT_SWITCHES`），
   * 「哪本词典装在哪、系统 TTS 起没起」才是 DEVICE，在 core 里叫 `availability`，
   * 是**事实**，压根不进偏好。
   *
   * ── 跟着退役的那一串（**只读不删**，D-216）────────────────
   *
   *   `tts.sources` · `tts.sourcesEditedAt` · `tts.sourcesMigratedAt`
   *   `tts.provider.<id>.voice` · `tts.cloud` · `tts.model` · `tts.voice`
   *   （以及 `settings` 里的 `tts.<id>.baseUrl` 与安全存储里的 `tts.<id>.key`）
   *
   * 它们是「云端 + 多厂商 + 来源排序」那个世界的产物，D-466 把那条线整条撤了。
   * 库里那几行**不动**（只增不删），只是不在白名单里了 —— `checkPrefKey` 从此拒写。
   * 没有回填：两档语音出厂都是开的，旧值里没有任何一个字对得上新的两把开关。
   */
  { key: 'tts.dictionary', kind: 'bool', says: '用不用词典自带的原生发音' },
  { key: 'tts.system', kind: 'bool', says: '用不用设备自带的系统语音' },
  { key: 'tts.accent', kind: 'text', says: '朗读口音' },
  { key: 'tts.rate', kind: 'number', says: '朗读语速' },

  /**
   * ★★ 出题规则的七个选项（D-482，使用者 2026-09-15「全部按照推荐的来」）。
   *
   * ★ 归 USER：按本文件开头那句判据问「换一台设备，这一项应该自动恢复吗」——
   *   「我要怎么被考」**应该**。
   * ★ 手机**也有**产出练习的设置页（Settings › PROMPTS ›「题型」→ 编辑；
   *   Nyx-UI-Android 2026-09-15 核出来的）—— 那四个键两端都有人改，靠同步收敛。
   *   在那之前这里写着「手机没有」，**错了不会红**，所以特意写清出处。
   * ★ 形状与出厂值在 core 一处（`core/quiz-rules.ts`），两端同一份 ——
   *   「同一份偏好两台机器拼出同一份提示词」靠的是这个。
   */
  ...QUIZ_PREF_SPECS,

  { key: 'ai.split', kind: 'bool', says: '三组 AI 配置分不分开' },

  /**
   * ★★ 默认词典 · D2.1（2026-08-19 他改的裁决）
   *
   * ── 它为什么从 DEVICE 变成 USER ────────────────────────────
   *
   * 旧裁决「`dict.default` 属 DEVICE」成立的前提是**它存的是本机 id** ——
   * `31` 这个数在另一台机器上什么都不是。
   * D1/D2 之后身份模型变了：现在存的是 `dictUid`，
   * 同一本词典在任何机器、任何路径、任何文件名下都是同一个字符串。
   * 前提没了，结论跟着变。
   *
   * ── 边界要划清 ────────────────────────────────────────────
   *
   *   USER    「他想用哪本词典」        → 这一项，跟着人走
   *   DEVICE  `ifo_path` / `enabled` / `sort_order` / 资源 / 缓存 / 本机 id
   *
   * ── 第二台设备上怎么处理 ★ ─────────────────────────────────
   *
   *   本机有同一个 uid  → 恢复成默认
   *   本机没有          → 用现有 fallback，**绝不回写**
   *                       （他哪天把那本词典拷过来，就该自己回去）
   */
  { key: 'dict.default', kind: 'dict-uid', says: '默认用哪本词典（跨设备身份 dictUid）' },

  /**
   * ★★ 使用者改过的提示词（⑤ · 2026-09-01）—— **两端读同一份**。
   *   只覆盖两端共用的那两条；优先级 = 改过的 → 磁盘 md → 内置副本。
   *   判据与名单在 `core/prompt-overrides.ts`。
   *   ★ 存这里而不是 settings：改过的提示词**必须跟着人走** ——
   *     否则同一个 Nyx 在两台机器上出的题不一样、判分标准也不一样，
   *     而两边都说得通、都不报错。
   */
  ...PROMPT_PREF_SPECS
]

export const PREF_KEYS: readonly string[] = PREF_SPECS.map((s) => s.key)

/**
 * 这一项在屏上叫什么 —— **设置页的标签从这儿取**（R-03，2026-09-15）。
 *
 * `main/params.ts` 以前自己写一份 `label`，和这里的 `says` 逐字相同：
 * 「今日练习默认条数」「一次给一条知识点出几道题」两句各写两遍。
 * ★ 认不出的键**直接抛**，不返回空串：标签空掉是屏上一格白，
 *   他看见的是一个没有名字的输入框，而日志里什么都没有。
 */
export function prefSays(key: string): string {
  const hit = PREF_SPECS.find((s) => s.key === key)
  if (!hit) throw new Error(`prefSays：白名单里没有「${key}」`)
  return hit.says
}
export const prefSpecOf = (key: string): PrefSpec | undefined => PREF_SPECS.find((s) => s.key === key)

/**
 * ★★ 一眼看上去像秘密的键。
 *
 * 判据故意宽：**宁可误伤一个偏好，也不要漏掉一把 key。**
 * 误伤的后果是「这一项不同步，他手动配一次」；
 * 漏掉的后果是**他的 API key 上了云**，而且他永远不会知道。
 *
 * 这不是唯一一道闸 —— `PREF_SPECS` 白名单本身已经堵死了；
 * 这一条是第二道，防的是「将来有人往白名单里加了个带 key 的项」。
 */
const SECRETISH = /(^|[._-])(key|secret|token|password|passwd|credential|apikey)([._-]|$)/i

export function looksLikeSecret(key: string): boolean {
  return SECRETISH.test(key)
}

export type PrefKeyCheck = { ok: true } | { ok: false; why: string }

/** 这个键能不能进 `user_preferences` */
export function checkPrefKey(key: unknown): PrefKeyCheck {
  if (typeof key !== 'string' || key.trim() === '') return { ok: false, why: '偏好的键名是空的' }
  if (looksLikeSecret(key)) {
    return { ok: false, why: `「${key}」看起来是一把密钥 —— 秘密永远不进偏好表，也永远不上云（D-220）` }
  }
  if (!prefSpecOf(key)) {
    return {
      ok: false,
      why: `「${key}」不在偏好清单里。跟着人走的项要先写进 core/prefs.ts 的 PREF_SPECS —— ` +
        `不在清单里的多半属于 DEVICE（这台机器怎么实现），那种留在 settings`
    }
  }
  return { ok: true }
}

/**
 * 偏好的跨设备身份。
 *
 * ★ 走的是 Step 2 那套 canonical identity（`natUid`），不是手拼字符串 ——
 *   同一套转义、同一套无歧义证明。两台设备改同一项偏好时落在同一个 uid 上，
 *   `on conflict(uid)` 正常接管，不会长出两行再撞唯一索引。
 */
export const prefUid = (key: string): string => natUid('user_preferences', [key])

export type PrefValueCheck = { ok: true; value: string } | { ok: false; why: string }

/**
 * 值合不合法 —— 迁移和写入共用同一条判据。
 *
 * ★ 空字符串一律拒。`Number('')` 是 0，而 0 会被 `ParamStore` 钳成合法值 ——
 *   V26 就是被这一条逼出来的（他设的 95 差点变成 1）。
 */
export function checkPrefValue(key: string, raw: unknown): PrefValueCheck {
  const spec = prefSpecOf(key)
  if (!spec) return { ok: false, why: `「${key}」不在偏好清单里` }
  return checkPrefValueOf(spec, raw)
}

/**
 * 同一条判据，但**规格由调用方给**（T-2.12 / I-149）。
 *
 * ── 为什么要有这一版 ────────────────────────────────────────
 *
 * 已经写完的**历史迁移**不该跟着当前白名单走（D-216「编号迁移不回头改」）：
 * V29 现在拿的是自己冻住的那份键单（`migrations/v20-v29.ts`），
 * 于是它也不能再用 `checkPrefValue(key, …)` —— 那一句会回头查
 * **今天的** `PREF_SPECS`，白名单一改，一条写完的迁移就跟着改了。
 *
 * ★ 拆成两个函数而不是在迁移里抄一份形状判断：抄一份就是两个真相，
 *   哪天「什么算合法的 number」改了，两边会分家而且不报错。
 *   形状规则本来就该只有一份 —— **会漂的是白名单，不是形状。**
 */
export function checkPrefValueOf(spec: PrefSpec, raw: unknown): PrefValueCheck {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  if (text.trim() === '') return { ok: false, why: `${spec.says}：值是空的` }

  switch (spec.kind) {
    case 'number': {
      const n = Number(text)
      if (!Number.isFinite(n)) return { ok: false, why: `${spec.says}：${text} 不是一个数` }
      return { ok: true, value: String(n) }
    }
    case 'bool': {
      if (text !== '0' && text !== '1') return { ok: false, why: `${spec.says}：${text} 不是 0 或 1` }
      return { ok: true, value: text }
    }
    case 'json-array': {
      try {
        const v: unknown = JSON.parse(text)
        if (!Array.isArray(v)) return { ok: false, why: `${spec.says}：不是一个数组` }
        return { ok: true, value: JSON.stringify(v) }
      } catch {
        return { ok: false, why: `${spec.says}：不是合法的 JSON` }
      }
    }
    case 'json': {
      try {
        JSON.parse(text)
        return { ok: true, value: text }
      } catch {
        return { ok: false, why: `${spec.says}：不是合法的 JSON` }
      }
    }
    case 'text':
      return { ok: true, value: text }

    /**
     * ★★ 词典的跨设备身份。判据比 `text` 严得多，理由很具体：
     *
     *   **存成本机 id（`31`）是这一整条决议要消灭的东西。**
     *   它在另一台机器上指向另一本词典 —— 而且不报错、不报警，
     *   他只会发现「换台设备之后默认词典莫名其妙变了一本」。
     *
     * 所以数字、空串、随手编的字符串一律拒；只认
     * `dictUid()` 产出的那个形状（`dictionaries-nat-…`）。
     * 反向验收里有一条专门删掉这一段，看用例会不会红。
     */
    case 'dict-uid': {
      if (!text.startsWith(DICT_UID_PREFIX)) {
        return {
          ok: false,
          why:
            `${spec.says}：「${text.slice(0, 40)}」不是词典的跨设备身份。` +
            '存本机 id 会让另一台设备指到另一本词典上去，而且什么都不报。'
        }
      }
      return { ok: true, value: text }
    }
  }
}

/**
 * 词典身份的前缀 —— `natUid('dictionaries', …)` 产出的形状。
 * ★ 写死在这里而不是 import `dict/identity.ts`：那边是词典模块的事，
 *   这边只需要认出「这是不是一个词典身份」。两处一起改的可能性为零
 *  （改了前缀等于换了全部 21 本的身份，那有 `identity.test.ts` 第 ④ 段拦着）。
 */
const DICT_UID_PREFIX = 'dictionaries-nat-'

/**
 * ★★ 数组类偏好**整项是一个值**，不拆成多条同步实体（使用者 §9 / §10）。
 *
 * A 勾了 `[a,b]`、B 勾了 `[b,c]`，逐元素合并出来的 `[a,b,c]` **两边都不认** ——
 * 那不是任何人做过的决定。所以冲突粒度就是整个 key，走现有的 LWW / 裁决机制，
 * 不新发明第三套合并算法（`core/sync-merge.ts` 拒绝逐字段合并是同一个理由）。
 *
 * 这个常量只为让那条规则有个能被测试引用的名字。
 */
export const ARRAY_PREFS_MERGE_WHOLE = true
