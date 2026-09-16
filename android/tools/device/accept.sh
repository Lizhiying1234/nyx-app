#!/usr/bin/env bash
# ══ 真机验收 · 一条命令跑完一批断言，打一张能直接贴走的表（T-9.2）══════
#
# 为什么存在（D-405③）：整轮构建只要 ~12s，慢的从来不是构建，是**回合数** ——
# 一条 eval 发一次、看一眼、再发下一条，是这个项目最贵的时间浪费。
# 而第③档是唯一算「做好了」的一档（CLAUDE.md §四），跑得越费劲，跳过它的
# 诱惑就越大。所以把它压成一条命令。
#
# ★★ 三条纪律，每条都有出处：
#   ① **不看截图判对错。** 2026-08-25 在缩略图上「看见」多了一条 Tab 栏，
#      查半天才发现那是系统状态栏（README 第一节）。眼睛在缩放过的图上不可靠 ——
#      这里每一条断言都是**页面自己报的数**，截图只在 --shot 时另存留档。
#   ② **没接手机就说没接手机。** 绝不打一张全是「未验」的表冒充跑过 ——
#      那正是这个项目定义的最贵失败形态（成功的失败）。
#   ③ **绝对路径。** Git Bash 里 `cd` 的工作目录会在多次调用之间漂（同 ship.sh）。
#
# 用法：
#   tools/device/accept.sh                    # 跑核心四条
#   tools/device/accept.sh --all              # 核心四条 + 全部可选组
#   tools/device/accept.sh --group voice,compact
#   tools/device/accept.sh --no-write         # 不往库里写那条探针（见下）
#   tools/device/accept.sh --shot out.png     # 顺带留一张截图（不参与判定）
#
# 退出码：0 = 全 ✔ · 1 = 有 ✖ · 2 = 没接手机 · 3 = 连不上 WebView 调试口
#
# ★★★ `--no-write` 那一条要看清楚：
#   「一条采集落库」这条断言**会往他的真库里写一行**，然后软删掉。
#   软删 = 那一行还在（回收站 30 天），而且**会随下一趟同步去到电脑**。
#   所以：默认写、但每次都把 id 与词条打出来，他要清干净可以去回收站彻底删；
#   不想留任何痕迹就带 `--no-write`（那一条会标「跳过」，不是「通过」）。
set -uo pipefail

# ★★ 同 ship.sh（I-154）：ROOT 从**脚本自身的位置**推，不许写死。
#    写死之后，在 worktree 里跑这个脚本会去用**主检出**那一份 eval.mjs（见下面
#    EVAL_CMD），而这个会话改的是 worktree 里那一份 —— 「改了没生效」查半天。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# ── 三个**测试缝**（只给 tools/device/accept-selftest.sh 用；真机跑时一个都不设）──
#   没有它们，这个脚本自己就只能靠「接上手机试一次」来验证 ——
#   而它存在的全部意义就是「不接手机也说得清哪一步没通」。
#   ★ 默认值全是真的那一套：不设 = 完全按真机路径走。
ADB="${NYX_ADB:-D:/android-toolchain/sdk/platform-tools/adb.exe}"
PKG="${NYX_PKG:-com.nyx.android}"
PORT="${NYX_PORT:-9222}"
# eval 的执行者（默认真的那一份）—— 自测时换成一个回固定答案的桩
EVAL_CMD="${NYX_EVAL:-node $ROOT/tools/device/eval.mjs}"

# ★★ 这个变量**不许**叫 `GROUPS`（I-146）。`GROUPS` 是 bash 的内建**数组**变量
#    （当前用户的组 ID），给它赋标量字符串会被**静默吞掉** —— `set -euo pipefail`
#    都不报。2026-09-06 真机批实测：bash 5.3.15 下进脚本时它已经是
#    `declare -a GROUPS=([0]="197121")`，赋值后仍是 `197121`，于是 `,$GROUPS,`
#    恒为 `,197121,`，`--all` / `--group X` **一个组都激活不了**，五组全打
#    「（组 X 没跑）」。而且它把另一个 bug 盖住了：可选组里那七条断言的顶层
#    await 问题从来没机会暴露。改名之后五组当场全 ACTIVE。
#    同理别用 `SECONDS` / `LINENO` / `PIPESTATUS` / `RANDOM` / `HOSTNAME` / `UID` …
NYX_GROUPS=""
DO_WRITE=1
SHOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all) NYX_GROUPS="voice,compact,analysis,edit,batch"; shift ;;
    --group) NYX_GROUPS="${2:-}"; shift 2 ;;
    --no-write) DO_WRITE=0; shift ;;
    --shot) SHOT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '1,32p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）"; exit 1 ;;
  esac
done

has_group() { case ",$NYX_GROUPS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# ── ① 前置自检：没接手机 / 连不上调试口，当场说清是哪一步 ─────────────

if ! command -v "$ADB" >/dev/null 2>&1 && [ ! -x "$ADB" ]; then
  echo "✖ 找不到 adb：$ADB —— CLAUDE.md §七 的 ANDROID_HOME 对不上？"
  exit 2
fi

DEVICES="$("$ADB" devices 2>/dev/null | sed -n '2,$p' | grep -c "device$" || true)"
if [ "${DEVICES:-0}" -eq 0 ]; then
  echo "✖ 没接手机 —— 一条断言都没跑。插上 USB、确认已授权调试（adb devices 要看到 device）。"
  exit 2
fi

# WebView 的调试端口：pid 从 ps 里找（README 第一节那两步）
PID="$("$ADB" shell ps -A 2>/dev/null | grep "$PKG\$" | awk '{print $2}' | head -1 || true)"
if [ -z "${PID:-}" ]; then
  echo "✖ Nyx 没在跑（ps 里找不到 $PKG）—— 先在手机上打开它，再跑这条命令。"
  exit 3
fi
"$ADB" forward "tcp:$PORT" "localabstract:webview_devtools_remote_$PID" >/dev/null 2>&1 || {
  echo "✖ adb forward 没成 —— 端口 $PORT 可能被占着（adb forward --list 看一眼）。"
  exit 3
}
WS="$(curl -s --max-time 5 "http://localhost:$PORT/json" 2>/dev/null \
      | tr ',' '\n' | grep -o 'ws://[^"]*' | head -1 || true)"
if [ -z "${WS:-}" ]; then
  echo "✖ 转发通了，但 $PORT 上没有可调试的页面 —— App 的 WebView 可能被系统冻着；"
  echo "  把 Nyx 切到前台再跑一次。（curl http://localhost:$PORT/json 自己看一眼）"
  exit 3
fi

# ── 一句 eval（结果打回来；页面里抛异常时 eval.mjs 自己会说是什么）────────
EV() { $EVAL_CMD "$WS" "$1" 2>&1; }

# ── 表 ───────────────────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0
ROWS=""
row() { # row <断言> <期望> <实测> <结果>
  ROWS="${ROWS}| $1 | $2 | $3 | $4 |
"
}
check() { # check <断言> <期望> <表达式>；实测 == 期望 → ✔
  local name="$1" want="$2" got
  got="$(EV "$3")"
  got="$(printf '%s' "$got" | tr -d '\r' | head -c 160 | tr '\n' ' ')"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); row "$name" "$want" "$got" "✔"
  else FAIL=$((FAIL+1)); row "$name" "$want" "${got:-（空）}" "✖"; fi
}
note_only() { # note_only <断言> <说明> <表达式>：只报数、不判对错
  local got; got="$(EV "$3")"
  got="$(printf '%s' "$got" | tr -d '\r' | head -c 160 | tr '\n' ' ')"
  row "$1" "$2" "${got:-（空）}" "—"
}
skip() { SKIP=$((SKIP+1)); row "$1" "$2" "未验" "○"; }

echo "# 真机验收 · $(date '+%Y-%m-%d %H:%M')"
echo
echo "设备 $("$ADB" devices | sed -n '2p' | awk '{print $1}') · pid $PID · $WS"
echo

# ── ② 核心四条 ────────────────────────────────────────────────────────

# 1 · 开库到底开成了什么样。★ 不看界面上的 ABOUT，问 db 自己
check "开库 · user_version" "36" \
  "nyx.db.k === 'ok' ? String((await nyx.db.db.get('pragma user_version')).user_version) : 'db 没开（' + nyx.db.k + '）'"
note_only "开库 · busy_timeout / 词典通道" "15000 · random" \
  "JSON.stringify(globalThis.nyxDb ?? null)"

# 2 · 同步的账。problems 非 0 = 有包没收下／结构不合，设置页也看得见（R-4-D）
check "同步 · settings['sync.problems'] 条数" "0" \
  "nyx.db.k === 'ok' ? String(JSON.parse(((await nyx.db.db.get(\"select value from settings where key='sync.problems'\"))||{}).value || '[]').length) : 'db 没开'"

# 3 · 写库通道：写一行、读回来、软删掉
#    ★ 它证明的是「这台机器上写得进去、读得回来、软删生效」，
#      **不是** capture 的判据（那一份在 db/capture.ts，没有 ③ 档通道 —— 见 README）。
if [ "$DO_WRITE" = "1" ]; then
  MARK="__nyx-accept-$(date +%s)"
  WROTE="$(EV "(async()=>{const d=nyx.db.db,t=Date.now();
    const l=await d.get('select id from lectures where deleted_at is null order by id limit 1');
    if(!l) return 'no-lecture';
    await d.run(\"insert into items (term,gloss,layer,kind,source,owner_lecture_id,confidence,created_at,updated_at) values (?,'','A','chunk','self',?,1.0,?,?)\",['$MARK',l.id,t,t]);
    const r=await d.get('select id from items where term = ?',['$MARK']);
    if(!r) return 'not-readable';
    await d.run('update items set deleted_at = ?, updated_at = ? where id = ?',[t,t,r.id]);
    const back=await d.get('select deleted_at from items where id = ?',[r.id]);
    return JSON.stringify({id:r.id,soft:back.deleted_at!==null});})()")"
  case "$WROTE" in
    *'"soft":true'*) PASS=$((PASS+1)); row "写库 · 写一条→读回→软删" "soft:true" "$WROTE" "✔" ;;
    *) FAIL=$((FAIL+1)); row "写库 · 写一条→读回→软删" "soft:true" "${WROTE:-（空）}" "✖" ;;
  esac
  echo "> ★ 这一条往真库写了 \`$MARK\` 并软删（回收站 30 天，**会随下一趟同步去电脑**）。"
  echo "> 不想留痕迹下次带 \`--no-write\`；要清干净去 Vault › 回收站彻底删。"
  echo
else
  skip "写库 · 写一条→读回→软删" "soft:true"
fi

# 4 · 认读那一档的判据在真机上真的跑得起来（不看截图）
check "认读 · revealsAnswer 露答案判据" "true" \
  "String(nyxRead.revealsAnswer('the word is stairwell here','stairwell'))"
note_only "认读 · 今天到期几张" "≥0" \
  "nyx.db.k === 'ok' ? String((await nyx.db.db.get('select count(*) as n from reading_cards where silent = 0 and due_at is not null and due_at <= ' + Date.now())).n) : 'db 没开'"

# ── ③ 可选断言组（--group / --all）─────────────────────────────────────
# 每组一句话说明它验的是哪条任务的哪一项；跑不到的如实标「未验」。

if has_group voice; then
  # T-7.5 · 顺序由 core/voice 排、预算由 core 执行；这里问「上一次谁赢了、每一步花了多久」
  note_only "T-7.5 Voice · 上一次赢下来的那一步" "dictionary/cache/system 之一" \
    "String(globalThis.nyxTts ? nyxTts.engine() : '没有 nyxTts')"
  note_only "T-7.5 Voice · 每一步的账（tried）" "hit/miss/timeout + ms" \
    "JSON.stringify(globalThis.nyxTts ? nyxTts.tried() : null)"
  note_only "T-7.5 Voice · 为什么用的不是词典音" "一句人话" \
    "String(globalThis.nyxTts ? nyxTts.why() : '')"
fi

if has_group compact; then
  # T-2.10 · 立碑之后下一趟同步末尾压实一次；D-458 要答得出「压的是哪些」
  note_only "T-2.10 压实 · ops_log 里 compact 的行数" "≥1（压过才有）" \
    "nyx.db.k === 'ok' ? String((await nyx.db.db.get(\"select count(*) as n from ops_log where op = 'compact'\")).n) : 'db 没开'"
  note_only "T-2.10 压实 · 最近一行 compact" "带压掉了哪些" \
    "nyx.db.k === 'ok' ? JSON.stringify((await nyx.db.db.get(\"select detail, created_at from ops_log where op = 'compact' order by id desc limit 1\")) ?? null) : 'db 没开'"
fi

if has_group analysis; then
  # T-5.12 · 手机做的单条解析要在 item_events 里认得出来（origin = android）
  note_only "T-5.12 单条分析 · item_events analyzed 行数" "≥1（分析过才有）" \
    "nyx.db.k === 'ok' ? String((await nyx.db.db.get(\"select count(*) as n from item_events where kind = 'analyzed'\")).n) : 'db 没开'"
  note_only "T-5.12 单条分析 · 其中 origin=android 的" "≥1" \
    "nyx.db.k === 'ok' ? String((await nyx.db.db.get(\"select count(*) as n from item_events where kind = 'analyzed' and detail like '%android%'\")).n) : 'db 没开'"
fi

if has_group edit; then
  # T-5.14 · 手机改词条要留痕（corrections 区块），uid 不变
  note_only "T-5.14 改词条 · corrections 块数" "≥1（改过才有）" \
    "nyx.db.k === 'ok' ? String((await nyx.db.db.get(\"select count(*) as n from analysis_blocks where block = 'corrections'\")).n) : 'db 没开'"
fi

if has_group batch; then
  # T-5.13 · 批次状态一条 JSON（本机，不上云）；后台接着跑靠它
  note_only "T-5.13 批量 · settings['analysis.batch']" "跑过才有" \
    "nyx.db.k === 'ok' ? String(((await nyx.db.db.get(\"select value from settings where key='analysis.batch'\"))||{}).value ?? '（没跑过批量）') : 'db 没开'"
  note_only "T-5.13 批量 · 还有没有待办" "true/false" \
    "String(globalThis.nyxAnalysis ? await nyxAnalysis.pending(nyx.db.db) : '没有 nyxAnalysis')"
fi

for g in voice compact analysis edit batch; do
  has_group "$g" || skip "（组 $g 没跑）" "用 --group $g 或 --all"
done

# ── ④ 打表 ───────────────────────────────────────────────────────────
echo "| 断言 | 期望 | 实测 | 结果 |"
echo "|---|---|---|---|"
printf '%s' "$ROWS"
echo
echo "**汇总**：✔ $PASS · ✖ $FAIL · ○ 未验 $SKIP（「—」= 只报数，不判对错）"

if [ -n "$SHOT" ]; then
  # ★ 截图只留档，不参与判定（见文件头纪律①）
  "$ADB" exec-out screencap -p > "$SHOT" && echo "（截图留档：$SHOT —— 不参与判定）"
fi

[ "$FAIL" -eq 0 ] || exit 1
exit 0
