# 真机调试通道

在**真机上跑着的 Nyx** 里执行 JS、截图、按像素核对。

## 为什么需要这个

第③档验收要看真机（CLAUDE.md §9.1）。但真机上：

- `console.log` 不能用 —— logcat 被系统限流（`LOGS OVER PROC QUOTA`），
  关掉限流的代价是 `loggingBehavior:"none"` 把 console 一起关了
- **截图会看岔**。2026-08-25 我在缩略图上「看见」顶部多了一条 Tab 栏，
  查了半天，最后逐行扫像素才发现那是**系统状态栏图标**，页面本身没问题。
  眼睛在缩放过的图上不可靠，得让数字说话。

## 用法

```bash
# ① 转发 WebView 的调试端口（pid 从 ps 里找）
adb shell ps -A | grep nyx
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>

# ② 拿到页面的 ws 地址
curl -s http://localhost:9222/json
```

### ★ `curl :9222/json` 是空的怎么办（T-9.2 撞到过，T-6.5 查清了）

**先分清是哪一种「App 在跑」。** `ps` 里看得见 `com.nyx.android` 只说明**进程**活着，
而这个进程可能是**无障碍服务**撑起来的 —— `MainActivity` 从未创建过。

链子是这样的（都在源码里，不是猜的）：

- 调试口由 `WebView.setWebContentsDebuggingEnabled(...)` 打开，它是**静态**的、按进程生效
- 我们自己**从来不调它**；调它的是 Capacitor：`Bridge.java` 里那一句，
  参数默认值 = APK 的 debuggable 标志（`CapConfig` 里 `isDebug` 那一段）
- 而 `Bridge` 只在 `MainActivity`（`BridgeActivity`）起来时才构造
- 无障碍服务与它的无头 WebView **不需要 MainActivity** 就能跑（他打开无障碍开关时系统就绑定它，
  App 被划掉也照旧活着）

⇒ 只有服务在跑的那种情形，**整个进程一次都没人调过那个开关**，于是没有 devtools socket：
`adb forward` 看着成功（抽象套接字是懒连的），`curl :9222/json` 空。

**T-6.5 补了一行**：`AssistEngine.warm()` 里，按 `ApplicationInfo.FLAG_DEBUGGABLE`
（与 Capacitor 用的同一条判据，不用 `BuildConfig` —— 本仓没开 `buildFeatures.buildConfig`）
自己开一次。**release 包永远进不来这一支。** 装的是 `ship.sh` / `live.sh` 出的
`app-debug.apk`，所以真机上这一支会走到。

于是两条路各自都能被看见：

| 想看谁 | 怎么让它有页面 |
|---|---|
| App 的 WebView | 把 Nyx **切到前台**（`MainActivity` 起来 → Capacitor 开开关） |
| 引擎的无头 WebView | 进一次**取词模式**（`warm()` 被调 → 这一行开开关 + 建 WebView） |

★ 两者在**同一个进程**（Manifest 没有 `android:process`），所以 pid 只有一个、
`webview_devtools_remote_<pid>` 也只有一个；`/json` 里会列出各自的页面。
★ 装包之后先确认探针那一行：`run-as com.nyx.android cat files/probe.txt | grep devtools`
应当有 `engine devtools debuggable=true`。

拿到 `webSocketDebuggerUrl` 之后：

```bash
# 在真机页面里执行 JS，结果打回来
node tools/device/eval.mjs "<ws://…>" "JSON.stringify({h: innerHeight})"

# 整页截图（页面自己画的，不含系统状态栏）
node tools/device/shot.mjs "<ws://…>" out.png

# 截一小块并放大 —— 缩略图看不准的时候用
node tools/device/clip.mjs "<ws://…>" out.png <x> <y> <w> <h> <放大倍数>

# 扫描 PNG 每一行有多少非白像素 —— 内容到底画在哪，用数字回答
node tools/device/rows.mjs shot.png
```

`rows.mjs` 也能读 `adb exec-out screencap -p` 出来的图。

## 无障碍授权什么时候会掉（2026-09-06 实测）

| 动作 | 授权 |
|---|---|
| 正常开 / 关 App · `am kill`（内存回收）· `adb install -r`（原地更新） | **保持** |
| `am force-stop`（强制停止 · 一键清理 · 上滑杀后台） | **清空**（`enabled_accessibility_services` 变成 `null`） |

★ `live.sh` 头注原来说「重装会踹掉授权」—— 那句话在这台机器上**实测不成立**，已就地更正。
整张表、Nyx 这一侧查过的每一项、以及界面上该说哪句话，见
`docs/nyx-system/android/ANDROID_ASSIST.md` **§十·八**。

### ⚠️ 但**用 `ship.sh` / `live.sh` 装包确实会撤授权** —— 别被上面那张表读反了

表说的是 `adb install -r` **这一个动作**不撤。可这两个脚本装完之后紧接着
`am force-stop`（`ship.sh` 为了冷启动截图、`live.sh` 的 `shot` 为了重启取新版），
而 `am force-stop` 正是表里唯一会清空授权的那一格。**净效果：装一次包，授权掉一次。**

**于是有一条排序纪律（2026-09-07 真机付过学费）：**

> **装包必须排在「请使用者去系统里放行」之前。**

那天先请他放行、再装包，他那次放行当场作废，只能再麻烦他一遍。
正确顺序是：**把这一轮所有要装的包装完 → 再请他放行一次 → 然后一口气跑完所有要无障碍的项**。

装完自己确认一句（`live.sh` 的 `install_apk` 现在就是这么报的，不再瞎猜）：

```bash
adb shell settings get secure enabled_accessibility_services   # 含 com.nyx.android 就是还在
adb shell settings get secure accessibility_enabled            # 0 = 连总开关都关了
```

★ **`accessibility_enabled` 是系统级总开关，App 和 adb 都改不了它**
（要 `WRITE_SECURE_SETTINGS`；使用者也明说过不要绕过系统授权机制）。
它是 `0` 的时候只有一条路：**请他自己去系统设置里开**。

## 一条踩过的坑

截图要在 **Git Bash** 里 `adb exec-out screencap -p > x.png`。
PowerShell 的 `>` 会给二进制加 BOM，存出来不是 PNG。

---

## 这些名字别用（写 shell 之前先看一眼 · I-146）

**症状都一样：赋值看着写了，行为却像没写 —— 而且一声不吭。**
`set -euo pipefail` 拦不住这类，因为它们不是错误。

| 名字 | 是什么 | 撞上会怎样 |
|---|---|---|
| **`GROUPS`** | bash 内建**数组**（当前用户的组 ID） | 赋标量**被静默吞掉**。实测 bash 5.3.15：进脚本时已是 `declare -a GROUPS=([0]="197121")`，赋值后仍是它 → `accept.sh` 的 `--all` / `--group X` **一个组都激活不了**，五组全打「没跑」 |
| **`TMP`**（Windows/Git Bash） | 从系统继承的**已导出**变量（`C:\Users\…\AppData\Local\Temp`） | 赋值**传染给所有子进程**（实测：子进程 `echo $TMP` 就是你赋的那个）。`accept-selftest.sh` 还在 trap 里 `rm -rf "$TMP"` —— 等于把子进程的临时目录连根删了 |
| `LINES` / `COLUMNS` | bash 的终端尺寸 | 标量能赋上，所以**未必当场坏**；但 `checkwinsize` / `select` / readline 会读它 |
| `SECONDS` `RANDOM` `LINENO` `PIPESTATUS` `FUNCNAME` `BASHPID` `SHLVL` `OPTARG` `OPTIND` `REPLY` `IFS` `PWD` `OLDPWD` `PATH` `HOME` `UID` `EUID` `PPID` | bash / 环境的特殊变量 | 轻则行为怪，重则静默失效 |

**做法**：脚本里的变量一律带 `NYX_` 前缀（`NYX_GROUPS` / `NYX_TMP` / `NYX_LINES`），
或者至少先 `bash -c 'echo ${那个名字-未设}'` 确认它不是别人的地盘。

★ 这一条是**量出来的**，不是抄手册：2026-09-06 真机批里 `GROUPS` 那个 bug
把另一个 bug（可选组里七条断言的顶层 `await`）整整盖住了 —— 组永远不激活，
那七条就永远跑不到，也就永远不会红。`accept-selftest.sh` 第 ⑥ 组是为此补的闸。

---

## `accept.sh` —— 一条命令跑完一批断言（T-9.2 · 2026-09-06）

```bash
tools/device/accept.sh                 # 核心四条
tools/device/accept.sh --all           # 再加上五个可选组
tools/device/accept.sh --group voice,compact
tools/device/accept.sh --no-write      # 不往真库里写那条探针
tools/device/accept.sh --shot out.png  # 顺带留一张截图（不参与判定）
```

输出是一张 Markdown 表（断言 · 期望 · 实测 · 结果）+ 一行汇总，**可直接贴进
`docs/nyx-system/findings/CHANGE_LOG.md`**。退出码：`0` 全 ✔ · `1` 有 ✖ ·
`2` 没接手机 · `3` 连不上 WebView 调试口。

**为什么要它**（D-405③）：整轮构建只要 ~12s，慢的从来不是构建，是**回合数**。
而第③档是唯一算「做好了」的一档 —— 跑得越费劲，跳过它的诱惑就越大。

**三条纪律**：

- **不看截图判对错。** 每条断言都是页面自己报的数（`eval.mjs` → `globalThis.nyx*`）。
  截图只在 `--shot` 时另存留档 —— 理由见本文件第一节那次「看见了不存在的 Tab 栏」。
- **没接手机就说没接手机**（exit 2，只打一行）。绝不打一张全是「未验」的表冒充跑过。
  连不上调试口时说清是哪一步没通（App 没在跑 / forward 没成 / 9222 上没有页面）。
- **只报数的那几行标「—」**，不算 ✔ 也不算 ✖ —— 「上一次朗读谁赢了」这种没有
  固定期望值，摆出来给人看，不假装它是一条断言。

### 核心四条

| | 问什么 | 怎么问 |
|---|---|---|
| 开库 | `user_version` = 36 | `nyx.db.db.get('pragma user_version')` |
| 同步 | `settings['sync.problems']` 条数 = 0 | 同上，读 settings |
| 写库 | 写一行 → 读回 → 软删 | ★ 见下面那条警告 |
| 认读 | `revealsAnswer` 在真机上判得对 | `nyxRead.revealsAnswer(…)` |

> ★★ **写库那条会往他的真库里写一行**，然后软删。软删 = 那一行还在
> （回收站 30 天），而且**会随下一趟同步去到电脑**。所以脚本每次都把写进去的
> 词条（`__nyx-accept-<时间戳>`）与 id 打出来，他要清干净可以去 Vault › 回收站
> 彻底删；不想留任何痕迹就带 `--no-write`（那一条会标「未验」，**不冒充通过**）。

### 可选组（`--group`）

| 组 | 验的是哪条任务的哪一项 |
|---|---|
| `voice` | T-7.5 · `nyxTts.engine() / tried() / why()` —— 上一次谁赢了、每步花了多久 |
| `compact` | T-2.10 · `ops_log` 里 `compact` 的行数与最近一行（D-458「压的是哪些」） |
| `analysis` | T-5.12 · `item_events` 里 `analyzed` 的行数、其中 `origin=android` 的 |
| `edit` | T-5.14 · `analysis_blocks` 里 `corrections` 的块数（改过词条才有） |
| `batch` | T-5.13 · `settings['analysis.batch']` 与「还有没有待办」 |

没选的组在表里标「○ 未验」，**不是「通过」**。

### `accept-selftest.sh` —— 不接手机也能证明它没坏

```bash
bash tools/device/accept-selftest.sh
```

用假的 `adb`、假的 9222、假的 `eval` 桩（`NYX_ADB` / `NYX_PORT` / `NYX_EVAL`
三个测试缝，真机跑时一个都不设），验五件事：没接手机 → exit 2 且只一行 ·
App 没在跑 → exit 3 且说清哪一步 · 有页面 → 取 ws → eval → 判定 → 打表 → exit 0 ·
有一条对不上 → 那行 ✖ 且 exit 1 · `--no-write` 标「未验」且一个字不往库里写。

★ 它存在的理由：`accept.sh` 坏掉的症状是**打出一张好看的表而里面全是假的**。
靠「接上手机试一次」来验证验证器，等于把验证器的验证也押在真机上。
（第一次跑它就抓出我把判定项数写成 5 的错 —— 实际是 4。）

---

## 已有的工具

| | |
|---|---|
| `rows.mjs` | ✅ **在**。扫描 PNG 每一行的非背景像素，输出连续段落。自带最小 PNG 解码，无依赖 |
| `eval.mjs` | ✅ **在**（2026-08-26 补）。在真机页面里执行 JS。零依赖，用 Node 22+ 自带的 WebSocket。`--pick` 可以自己去 9222 找页面 |
| `shot.mjs` · `clip.mjs` | ✅ **在**（2026-08-29 归位）。★ 它们其实早就写了，但一直躺在 `android/tools/device/` —— 一份**没人知道的第二份**。那个目录已整个删除，工具只此一处 |
| `accept.sh` · `accept-selftest.sh` | ✅ **在**（2026-09-06 · T-9.2）。把上面这些串成一次验收并打一张能贴走的表；自测不需要手机。见本文件上一节 |

★ 这条本身就是个教训：**README 承诺了不存在的东西，下一个人照着做会直接撞空。**

## 2026-08-25 · 第一次真机核对视觉方案，踩到的三件事

**① 没有 `<meta name="viewport">` 时，手机 Chrome 退回 980px 桌面视口再整体缩小。**
页面在桌面上完全正常，真机上什么都读不了 —— 而且**状态栏那行数字不看就发现不了**。
★ 后注入 meta **没用**，Chrome 不认初始视口之后再加的。必须是真标签，写在文件最前面。

**② 这台机器的 CSS 视口是 `360 x 656`，不是 390。**
`wm size` 给的是 1080x2376，density 480 → 1080/3 = **360 css**。
旧原型按 390 画的，**窄了 30px**。

**③ ★★ 差点把测试台的问题当成产品的问题。**
判分那一行在截图上被切掉了，看起来像布局 bug。
量完才知道：内容跨度 **678 css**，视口 **656 css** —— 只超了 22px；
而切掉的那一截主要是**浏览器自己画在页面上的底部工具栏**（Via Browser），
**真正的 Nyx（Capacitor WebView）没有那条栏**。
> **在浏览器里做真机核对，浏览器自己的 chrome 会伪装成布局问题。**

## 顺带量到的两个可用事实

- **Practice Correct 的内容只占 328 css，视口有 656** —— 版面不挤，富余很大
- 风险只在**底边**：`100vh` 在 Android 上不扣系统导航栏。
  用 `100dvh` + `padding-bottom: env(safe-area-inset-bottom)`，两个都要

---

## 2026-08-26 · 第二次真机核对（Phase 5 设计探索），又踩到四件

**① `adb push /sdcard/...` 在 Git Bash 里会被翻译成 Windows 路径。**
报错长这样：`failed to copy … to 'C:/Program Files/Git/sdcard/…'`。
★ 前面加 `MSYS_NO_PATHCONV=1`。**源路径要用 `C:/…` 写法，目标路径才是设备路径。**

**② 推进 `/sdcard/Download/` 的文件，浏览器打不开 —— `ERR_ACCESS_DENIED`。**
分区存储挡的。★ **改走 `adb reverse`**：本机起一个静态服务，
`adb reverse tcp:8777 tcp:8777`，手机上开 `http://localhost:8777/x.html`。
顺带好处：**字体等外部资源走的是手机自己的网络**，和真实使用一致。

**③ ★★ `document.fonts.ready` 之后量字体，量到的可能全是兜底。**
`@font-face` 是**懒加载**的 —— 页面上没有元素用到它，浏览器根本不去取；
而 canvas 的 `measureText` **不触发**加载。
第一版探针因此量出四个候选**一模一样的 58.8%**，那全是兜底字体的数。
★ 必须先 `await document.fonts.load('40px "X"', 'x汉')` 显式拉一遍再量。
★★ 更要紧的是：**探针里那行 `fonts loaded 1/6` 救了这一次** ——
没有它，我会把四个假数字当成真结论报上去。**测量前先测「能不能测」。**

**④ 这台机器（PJE110）能连 Google Fonts，开发机连不上。**
`curl` 实测：PC → `000`（连不上），设备 → `200`。
★ 所以「手机上字体加载失败」这个结论**不成立**，别照抄。

### 这一轮真机推翻的两个设计方案（都在桌面上看不出来）

| | 桌面上 | 真机上 |
|---|---|---|
| **判分的空心记号** | 以为是「空心 + 内嵌实心」 | ★★★ `stroke-width 24`（100 的 viewBox 上占 24%）在 **24/32/40/64/96 五档全部糊成实心团**，与「会了」**只剩颜色能区分** —— 等于 D-341 的四条非颜色通道**实际只有三条** |
| **Home 用三颗星** | 看着像启动图标 | ★★ 第三颗在 **16 / 20 / 24** 上就是个点。换成**两颗**之后，比例正好回到 D-341 实测的 **1.9 : 1**，16px 也不用另画一张 |

> ★ 两个都是**只有把尺寸阶梯摆到真机上才看得见**的问题。
> 做法很朴素：把同一个记号按 16/20/24/32/48（或 24/32/40/64/96）排成一行，
> **一眼就知道它在哪一档开始塌。**
