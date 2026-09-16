/**
 * 设备编号防撞的**平台面** · F-009（2026-09-01）
 *
 * 判据在 `core/device-rebind.ts`（两端同一份）；这里只做三件平台的事：
 *   ① 问原生要本机标识（`NyxDevice.hardwareId()` → ANDROID_ID，它不跟着备份走）
 *   ② 按判据往 `settings` 里写
 *   ③ 把「换号了」这句话交回去，让开库那一层如实说出来（D-409）
 *
 * ── 为什么这件事必须在开库之后、同步之前做 ────────────────
 *
 * 编号是在**第一次同步**时铸的（`core/sync/engine.ts::deviceId`）。
 * 从备份恢复过来的库里已经有一个号了，如果不在同步前把它换掉，
 * 第一次同步就会用旧机器的号推包 —— 两台同号，各自跳过对方的全部包，
 * 而且两边都显示「同步成功，收到 0 行」。
 *
 * ★ 这一层**绝不许把开库带崩**：插件不在（浏览器里跑）、取不到标识、
 *   settings 写不进去，一律退化成「什么都没发生」。防撞失效的后果是
 *   回到今天的状态，而开库失败的后果是整个 App 打不开。
 */
import { planRebind } from '../core-link.ts'
import { registerPlugin } from '@capacitor/core'
import type { Db } from './types.ts'

interface NyxDevicePlugin {
  hardwareId(): Promise<{ id: string }>
}
const NyxDevice = registerPlugin<NyxDevicePlugin>('NyxDevice')

const HW_KEY = 'sync.deviceHw'
const FORMER_KEY = 'sync.formerDevices'

async function readSetting(db: Db, key: string): Promise<string> {
  const r = await db.get(`select value from settings where key = ?`, [key])
  return String(r?.['value'] ?? '')
}

async function writeSetting(db: Db, key: string, value: string): Promise<void> {
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()]
  )
}

/**
 * 开库之后跑一次。返回一句要告诉使用者的话（没事发生就是 null）。
 *
 * ★ 换号时**旧号不是丢掉，是退休**：它推过的包仍然要跳过
 *   （`core/sync/session.ts::planTodo` 的 `formerDevices`），
 *   否则恢复之后第一次同步会把自己过去所有的包重下一遍。
 */
export async function bindDevice(db: Db): Promise<string | null> {
  try {
    const { id } = await NyxDevice.hardwareId()

    let formerDevices: string[] = []
    try {
      const raw = (await readSetting(db, FORMER_KEY)).trim()
      const v: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(v)) formerDevices = v.filter((x): x is string => typeof x === 'string')
    } catch {
      /* 坏了就当没有 —— 后果是多下一些包，不是同步失败 */
    }

    const action = planRebind({
      hardwareId: String(id ?? ''),
      knownHardwareId: await readSetting(db, HW_KEY),
      device: await readSetting(db, 'sync.device'),
      formerDevices
    })

    if (action.kind === 'none') return null

    if (action.kind === 'remember') {
      await writeSetting(db, HW_KEY, action.hardwareId)
      return null
    }

    /**
     * ★ 写的顺序有讲究：**先退休旧号，再把当前号清掉**。
     *   反过来的话，中途断电会留下「号没了、也没进历史」的库 ——
     *   那台机器会重下自己过去所有的包。
     */
    await writeSetting(db, FORMER_KEY, JSON.stringify(action.formerDevices))
    await db.run(`delete from settings where key = 'sync.device'`)
    await writeSetting(db, HW_KEY, action.hardwareId)
    return action.message
  } catch {
    // 插件不在（浏览器）、原生报错、库写不进去 —— 一律当没发生过
    return null
  }
}
