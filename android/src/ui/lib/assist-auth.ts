/**
 * ══ Assist 授权状态 → 屏幕上说哪句话（T-6.7）════════════════════
 *
 * ── 为什么要有这个文件 ★★★ ─────────────────────────────────
 *
 * 使用者报的是：「为什么每次打开 Nyx 都要重新去系统设置放行？」
 * 2026-09-06 在他的机器上量出来的根因**不在 Nyx**：
 *
 *     adb shell am force-stop com.nyx.android
 *     → settings get secure enabled_accessibility_services  变成 null
 *     → dumpsys accessibility 的 Bound / Enabled services    全空
 *
 * 而 `am kill`（系统内存回收）**不会**掉，正常开关 App 也不会掉。
 * 也就是说：**是「强制停止」那一类事件（一键清理 · 上滑杀后台 · 重装）
 * 让 Android/ColorOS 撤销了无障碍授权**，Nyx 只是如实报告。
 *
 * 代码层面没有合法的修法（写 `enabled_accessibility_services` 要
 * `WRITE_SECURE_SETTINGS`，普通 App 拿不到；而使用者也明说了
 * **不是要绕过系统授权机制**）。所以这一轮能做的是把话说清楚。
 *
 * ── 那就更要说对 ────────────────────────────────────────────
 *
 * 把它抽成纯函数，是因为这里最容易犯的错是**把「系统撤销了」说成「你关了」**：
 * 两件事在界面上长得一样（都是「Assist 不工作」），可对他的意义完全相反 ——
 * 一个是他自己的决定，一个是系统在他背后做的事。说错了他会以为是自己弄的。
 *
 * 所以两个概念在这里也是分开的两个入参：
 *   `wanted`  他自己的意愿（`settings['assist.enabled']`，只有他拨开关才变）
 *   `granted` 系统此刻放没放行（每次现问 `Settings.Secure`，不缓存）
 */

export interface AssistAuth {
  /** 系统此刻放行了吗。`null` = 问不到（网页端调试没有原生面） */
  granted: boolean | null
  /** 他自己要不要开（`settings['assist.enabled']`） */
  wanted: boolean
}

export interface AssistSay {
  /** 状态行那一句 */
  says: string
  /** 给不给「去系统里放行 Nyx」 */
  showGrant: boolean
  /** 给不给「减少这种情况」（跳到 Nyx 自己的系统页：耗电管理 / 自启动） */
  showKeepAlive: boolean
  /** 掉授权的原因那一句 —— 只有在系统没放行时才有 */
  why: string | null
}

/**
 * ★ 这一句是这一轮的重点：**说事实，不猜是谁干的，也不说成他关了**。
 *   「只能在系统里再开一次」是实话 —— 不给他一个我们其实做不到的承诺。
 */
/**
 * ★★ 2026-09-13 · 这句话以前**漏掉了最要紧的那一半**。
 *
 * 使用者报：「每次关闭 Nyx 再重新打开后，都再次要求我去系统里放行」。
 * 真机逐种关法量过（PJE110 / ColorOS）：
 *   回桌面（HOME）              → 授权还在
 *   am kill（进程被杀）          → 授权还在，进程自己还起得回来
 *   **最近任务里把卡片上滑丢掉** → `enabled_accessibility_services` 变 null
 *   一键清理（Close）           → 同上
 * 也就是说：**他平时「关掉」App 的那个动作，在这台 ROM 上就是「强制停止」。**
 * 而 Android 的规矩是「应用被强制停止 → 关掉它的无障碍服务」，
 * **应用没有任何办法给自己重新授权**（那要 WRITE_SECURE_SETTINGS，
 * 只有系统签名和 adb 拿得到）—— 所以这不是 Nyx 能修的 bug，
 * 能修的是**把话说清楚**：以前只说「强制停止」，他不会把那四个字
 * 和自己每天做的那个上滑动作联系起来。
 */
const WHY_REVOKED =
  '在最近任务里划掉 Nyx（或一键清理），等于强制停止 —— Android 会跟着撤销无障碍授权。' +
  '这是系统行为，只能到系统设置里重新打开。'

export function assistSay(a: AssistAuth): AssistSay {
  // ① 他自己关的 —— 那就什么都不劝，也不提授权的事
  if (!a.wanted) {
    return {
      says: '关 = 星收起 · 分享/选中菜单这些明确动作仍可用',
      showGrant: false,
      showKeepAlive: false,
      why: null
    }
  }
  // ② 他要开，系统也放行了 —— 正常态
  if (a.granted === true) {
    return {
      says: '第三方 App 里悬浮星常驻 · 点星进取词模式',
      showGrant: false,
      showKeepAlive: false,
      why: null
    }
  }
  // ③ 问不到（网页端调试）—— 如实说查不到，不假装是任何一种
  if (a.granted === null) {
    return {
      says: '查不到系统的放行状态（在电脑上预览时会这样）',
      showGrant: false,
      showKeepAlive: false,
      why: null
    }
  }
  // ④ ★ 他要开，但系统撤了 —— 说清原因与出路，**绝不说成「你关了」**
  return {
    says: '开着，但系统的无障碍授权被撤销了',
    showGrant: true,
    showKeepAlive: true,
    why: WHY_REVOKED
  }
}

/**
 * 「减少这种情况」那一行 —— 它是**建议**，不是承诺。
 *
 * ★ 2026-09-13 把最管用的那条放到最前：**用返回 / 主页键退出**。
 *   白名单与自启动挡的是**系统自动**清理，挡不住他自己在最近任务里划掉 ——
 *   而真机量下来，后者正是授权掉的那条路。先说管用的，再说有帮助的。
 */
export const KEEP_ALIVE_HINT =
  '退出时请用返回键或主页键，不要在最近任务里划掉 Nyx。' +
  '把 Nyx 加进电池优化白名单并允许自启动，能减少被系统清理的次数。'
