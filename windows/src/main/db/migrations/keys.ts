/**
 * 迁移里用到的键名 · T-4.6 拆分（2026-09-06）
 *
 * 从 migrations.ts 原样搬来。V20 的正文用它，`audit.ts` 也用同一个 ——
 * 放在这里是为了避开「vNN 反过来 import migrations.ts」那种循环。
 * migrations.ts 仍然把它转出，老的引用点一个字不用改。
 */

/** V20 归一时没敢动的那些 —— 体检要读它（键名放这里，audit.ts 也用同一个） */
export const BUILTIN_IDENTITY_KEY = 'builtin.identity.problems'
