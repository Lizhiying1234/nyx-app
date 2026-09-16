/**
 * 数据安全通知 · D-373（Q-06 = B）
 *
 * 手机通知**只发两类**：① 待上传积压（有孤本数据且连续多日未同步成功）
 * ② 同步连续失败。**不发学习提醒 / 到期提醒 / 成绩类任何内容** ——
 * 「不催」哲学（D-100/D-028）原样生效：**通知保护的是数据，不是自律**
 * （与 D-249 同一精神）。可整体关闭。
 *
 * 判据来处：pending / lastAt / failStreak 全是同步引擎 status() 里的数
 * （failStreak 是 core 引擎自己数的，两端同一份）；这里只做「要不要说话」。
 * 检查时机：开库那一刻 + 练完自动上传之后 —— 手机只在被用着的时候产生孤本，
 * 所以「用的时候查」就是诚实的覆盖面；后台定时是另一件事（D-347 Windows 先行）。
 */
import { registerPlugin } from '@capacitor/core'
import { syncEngine } from './sync.ts'
import type { Db } from './types.ts'

interface NyxNotifyPlugin {
  state(): Promise<{ granted: boolean }>
  ensurePermission(): Promise<{ granted: boolean }>
  post(o: { id: number; title: string; body: string }): Promise<{ ok: boolean; why?: string }>
  cancelAll(): Promise<void>
}
const NyxNotify = registerPlugin<NyxNotifyPlugin>('NyxNotify')

export const NOTIFY_KEY = 'notify.dataSafety'
const DAY = 24 * 60 * 60 * 1000

/** 总开关（本机 settings —— 通知偏好跟着这台手机走）。默认开：它保护的是数据 */
export async function notifyEnabled(db: Db): Promise<boolean> {
  const r = await db.get(`select value from settings where key = ?`, [NOTIFY_KEY])
  return r?.['value'] !== '0'
}

export async function setNotifyEnabled(db: Db, on: boolean): Promise<void> {
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [NOTIFY_KEY, on ? '1' : '0', Date.now()]
  )
  // 关了开关还留着旧警报是骗人 —— 收回来（收不动也不挡关开关）
  if (!on) await NyxNotify.cancelAll().catch(() => {})
}

/** 积压要几天才说话 · 连败要几次才说话 · 同类多久最多说一次 */
export const BACKLOG_AFTER_DAYS = 3
export const FAIL_AFTER = 3
const REPEAT_EVERY = DAY

export interface SafetyInput {
  kind: string
  pending: number
  lastAt: number
  failStreak: number
}

export interface SafetyMsg {
  id: number
  title: string
  body: string
  /** 去重键（settings）—— 同类一天最多一条 */
  key: string
}

/**
 * 纯判据：这一刻该说什么。
 * `lastSaid` 是两类各自上次说话的时刻（0 = 没说过）。
 */
export function dataSafetyVerdict(
  st: SafetyInput,
  now: number,
  lastSaid: { backlog: number; fail: number }
): SafetyMsg[] {
  const out: SafetyMsg[] = []
  if (st.kind === 'off') return out // 还没配同步 —— 他没开始用，不该亮红（引擎同款态度）

  // ① 积压：有孤本 + 上次成功已是多日前。从没成功过的头几天不算积压 ——
  //   那由 ② 连败盯着（配好了跑不通，很快就攒满三次）
  const stale = st.lastAt > 0 && now - st.lastAt >= BACKLOG_AFTER_DAYS * DAY
  if (st.pending > 0 && stale && now - lastSaid.backlog >= REPEAT_EVERY) {
    const days = Math.floor((now - st.lastAt) / DAY)
    out.push({
      id: 1,
      key: 'notify.backlogAt',
      title: '这台手机上的记录还没备份走',
      body:
        `${st.pending} 行学习记录只存在这台手机上，距上次同步成功已 ${days} 天 —— ` +
        `同步成功前它们是孤本。打开 Nyx，设置 → 同步 → 现在同步。`
    })
  }

  // ② 连败
  if (st.failStreak >= FAIL_AFTER && now - lastSaid.fail >= REPEAT_EVERY) {
    out.push({
      id: 2,
      key: 'notify.failAt',
      title: '同步连着失败了',
      body:
        `已经连续 ${st.failStreak} 次没同步成功。学习记录在同步成功前是孤本 —— ` +
        `打开 Nyx 看设置 → 同步里的问题说明。`
    })
  }
  return out
}

async function said(db: Db, key: string): Promise<number> {
  const r = await db.get(`select value from settings where key = ?`, [key])
  return Number(r?.['value'] ?? 0) || 0
}

/**
 * 查一次、该说就说。任何一步失败都吞掉 —— 提醒失败不能影响正事
 * （它只是提醒；数据本身有同步问题清单兜着，R-4-D）。
 * 返回这次发出去的条数（③ 档验收看数字）。
 */
export async function checkDataSafety(db: Db): Promise<number> {
  try {
    if (!(await notifyEnabled(db))) return 0
    const st = await syncEngine(db).status()
    const now = Date.now()
    const msgs = dataSafetyVerdict(
      { kind: st.kind, pending: st.pending, lastAt: st.lastAt, failStreak: st.failStreak },
      now,
      { backlog: await said(db, 'notify.backlogAt'), fail: await said(db, 'notify.failAt') }
    )
    if (msgs.length === 0) return 0
    if (!(await NyxNotify.state()).granted) return 0 // 权限没给 —— 开关行会如实显示
    let sent = 0
    for (const m of msgs) {
      const r = await NyxNotify.post({ id: m.id, title: m.title, body: m.body })
      if (!r.ok) continue
      sent += 1
      await db.run(
        `insert into settings (key, value, updated_at) values (?, ?, ?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [m.key, String(now), now]
      )
    }
    return sent
  } catch {
    return 0
  }
}

export const notifyPermission = {
  state: (): Promise<{ granted: boolean }> => NyxNotify.state(),
  ensure: (): Promise<{ granted: boolean }> => NyxNotify.ensurePermission()
}

// ③ 档验收通道（同 globalThis.nyx 的纪律：不看界面，看变量）
;(globalThis as Record<string, unknown>)['nyxNotify'] = { checkDataSafety, dataSafetyVerdict }
