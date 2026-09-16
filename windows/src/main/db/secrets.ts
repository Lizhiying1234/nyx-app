import type { Database } from 'better-sqlite3'

/**
 * 秘密的存取边界 · ★★ Step 5B / D-291（2026-08-18）
 *
 * ── 病 ──────────────────────────────────────────────────────
 *
 * `ai.*.key` 和 `tts.key` 都过了 `safeStorage`，只有 `sync.secret` 是**明文**
 * 躺在 `settings` 里 —— 同一个库里两套标准（审计 F-07 记的那一条）。
 *
 * ── 为什么要一层边界，而不是直接在 sync 里调 safeStorage ────
 *
 * 业务层该说的是「给我同步密钥」，不是「给我 `safeStorage.decryptString(...)`」。
 * 散着调的话，Android 那一侧要改的就不是一个文件，而是每一处调用点 ——
 * 而每一处都可能漏掉一个分支（比如「解不开怎么办」）。
 *
 *     Windows  SecretStore → safeStorage（本文件）
 *     Android  SecretStore → Keystore（将来，本轮不做）
 *
 * ── 明文和密文怎么分 ★ ──────────────────────────────────────
 *
 * 密文带一个显式前缀。没有前缀的一律当明文 —— 这样「已经加密过的不要再加密一遍」
 * 是可判定的，V30 才谈得上幂等。
 * （`ai.*.key` 那一套是裸 base64、没有标记，所以它没法自证是否加密过；
 *   那是既有设计，这一轮不动它 —— 使用者 §11 明确禁止。）
 */

/** 密文的显式标记。改它等于换存储格式，要配一条新的 migration */
export const ENC_PREFIX = 'enc:v1:'

export const isEncrypted = (v: string): boolean => v.startsWith(ENC_PREFIX)

/**
 * 真正做加解密的那一层。
 *
 * 抽成可替换的对象**只为一件事**：让「加密失败」「解密失败」「解出来对不上」
 * 这三条路能被测试真的走一遍。它们是本轮最要紧的分支 ——
 * 走错了的后果是**他的同步密钥没了**，而那时候已经晚了。
 */
export interface Crypto {
  available(): boolean
  encrypt(plain: string): string
  decrypt(blob: string): string
}

/** Electron 那一份。`safeStorage` 在这里才被 import，别处一律不碰 */
export function electronCrypto(): Crypto {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { safeStorage } = require('electron') as typeof import('electron')
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt: (plain) => ENC_PREFIX + safeStorage.encryptString(plain).toString('base64'),
    decrypt: (blob) =>
      safeStorage.decryptString(Buffer.from(blob.slice(ENC_PREFIX.length), 'base64'))
  }
}

/**
 * 当前用哪一份。默认是 Electron 那份；测试可以换掉。
 *
 * ★ 用 getter 而不是模块级常量：`require('electron')` 在某些上下文里
 *   （纯 node 跑的测试）会炸，延迟到真的要用时再取。
 */
let current: Crypto | null = null
export function setCrypto(c: Crypto | null): void {
  current = c
}
export function crypto(): Crypto {
  return current ?? electronCrypto()
}

export class SecretUnavailable extends Error {
  constructor(what: string) {
    super(
      `这台机器上的系统凭据不可用，${what}没法加密保存。\n` +
        `为安全起见**不明文保存**（D-220）—— 明文躺在数据库里，任何能读到那个文件的东西都能拿走它。`
    )
    this.name = 'SecretUnavailable'
  }
}

const SYNC_SECRET = 'sync.secret'

/**
 * 秘密的唯一入口。业务层只跟它打交道。
 */
export class SecretStore {
  constructor(private db: Database) {}

  private raw(key: string): string | null {
    const r = this.db.prepare(`select value from settings where key = ?`).get(key) as
      | { value: string }
      | undefined
    return r?.value ?? null
  }

  private put(key: string, value: string): void {
    const t = Date.now()
    this.db
      .prepare(
        `insert into settings (key, value, updated_at) values (?, ?, ?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, t)
  }

  /**
   * 同步密钥的明文。没配过返回空串。
   *
   * ★ 解不开时返回空串而不是抛：和 `resolveSlot` 对 AI key 的态度一致 ——
   *   让上层走「还没配」那条**明确的**失败态（「连不上桶」会给出人话与下一步），
   *   而不是在一个谁也没想到的地方炸出一句解密异常。
   */
  getSyncSecret(): string {
    const v = this.raw(SYNC_SECRET)
    if (!v) return ''
    if (!isEncrypted(v)) return v // 还没迁移（V30 之前的库），按明文用
    try {
      return crypto().decrypt(v)
    } catch {
      return ''
    }
  }

  /**
   * 写同步密钥。**只写密文，永远不重新产生明文。**
   *
   * @throws {SecretUnavailable} 系统凭据不可用时。不 fallback 到明文 ——
   *         那等于把「安全」悄悄降级成「看起来安全」。
   */
  setSyncSecret(plain: string): void {
    const s = plain.trim()
    if (!s) return // 空 = 不动已存的那把（和 AI key 同一套规矩）
    if (!crypto().available()) throw new SecretUnavailable('同步密钥')
    this.put(SYNC_SECRET, crypto().encrypt(s))
  }

  /** 配没配过 —— 界面只问这个，永远拿不到密钥本身 */
  hasSyncSecret(): boolean {
    return !!this.raw(SYNC_SECRET)
  }

  /** 库里那一行现在是不是密文 —— 迁移与测试用 */
  syncSecretIsEncrypted(): boolean {
    const v = this.raw(SYNC_SECRET)
    return v !== null && isEncrypted(v)
  }
}

export interface MigrateResult {
  /** 'none' 没配过 · 'already' 已经是密文 · 'migrated' 这次搬的 */
  state: 'none' | 'already' | 'migrated'
}

/**
 * ★★ 明文 → 密文。**验得回来才删明文。**
 *
 * 顺序是这条迁移的全部内容：
 *
 *     读明文 → 加密 → 写进去 → **再解一次** → 和原文逐字比 → 才算数
 *
 * 任何一步不成就抛，整条迁移回滚，**明文原样留着**。
 * 「加密完就假设成功、直接删明文」是这里唯一不能犯的错 ——
 * 犯了他就再也连不上自己的云端，而且没有任何东西能把密钥找回来。
 *
 * @throws 任何一步失败
 */
export function migratePlaintextSyncSecret(db: Database): MigrateResult {
  const store = new SecretStore(db)
  const row = db.prepare(`select value from settings where key = ?`).get(SYNC_SECRET) as
    | { value: string }
    | undefined
  const plain = row?.value ?? ''

  if (!plain) return { state: 'none' } // 没配过 —— 无事可做，也不要求系统凭据可用
  if (isEncrypted(plain)) return { state: 'already' } // 幂等：已经是密文就不再动它

  const c = crypto()
  if (!c.available()) {
    throw new Error(
      '系统凭据不可用，没法把同步密钥加密保存。**明文一个字都没有删**。\n' +
        '在这台机器上登录一次系统账户、或修好凭据服务之后再打开 Nyx。'
    )
  }

  const blob = c.encrypt(plain)
  if (!isEncrypted(blob)) throw new Error('加密结果没有带标记 —— 不敢当成密文写进去')

  // 先写密文
  const t = Date.now()
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(SYNC_SECRET, blob, t)

  // ★★ 再解一次，逐字比。这一步就是「不许丢密钥」那条保证本身
  const back = store.getSyncSecret()
  if (back !== plain) {
    throw new Error(
      `同步密钥加密之后解不回原样（长度 ${plain.length} → ${back.length}）—— ` +
        `整条升级已回滚，你的密钥原样还在。`
    )
  }
  return { state: 'migrated' }
}
