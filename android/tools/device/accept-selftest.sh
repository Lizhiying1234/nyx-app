#!/usr/bin/env bash
# ══ accept.sh 的自测 —— **不接手机也能证明它没坏**（T-9.2）══════════════
#
# 为什么需要它：`accept.sh` 存在的全部意义是「第③档跑一条命令就完」。
# 而它自己要是坏了（改了一行 grep、换了一个字段名），症状是**打出一张
# 好看的表而里面全是假的** —— 这个项目定义的最贵失败形态。
# 靠「接上手机试一次」来验证它，等于把验证器的验证也押在真机上。
#
# 它验六件事，每件都不需要手机：
#   ① 没接手机 → exit 2，只打一行人话（不假装跑过）
#   ② 手机在、但 9222 上没有页面 → exit 3，说清是哪一步没通
#   ③ 9222 上有页面 → 取到 ws → 逐条 eval → 判定 → 打表 → 全 ✔ exit 0
#   ④ 有一条对不上 → 那一行 ✖ → exit 1
#   ⑤ `--no-write` → 那一条标「未验」，且一个字都不往库里写
#   ⑥ `--all` / `--group X` **真的激活了可选组**（I-146 的回归闸）
#
# ★ ⑥ 是补上去的，补的正是它自己漏掉的那一层：`--all` 曾经一个组都激活不了
#   （变量名撞 bash 内建数组 `GROUPS`，赋值被静默吞），而当时这份自测只测了
#   `--no-write` 那种标量开关，于是**它绿着，工具是坏的**。教训写在这儿：
#   自测要覆盖**参数解析**本身，不只是参数生效之后的行为。
#
# 用法：bash tools/device/accept-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NYX_TMP="$(mktemp -d)"
trap 'rm -rf "$NYX_TMP"; [ -n "${FAKE_PID:-}" ] && kill "$FAKE_PID" 2>/dev/null' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✔ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✖ $1"; }
want() { # want <说明> <期望退出码> <实际退出码>
  if [ "$2" = "$3" ]; then ok "$1（exit $3）"; else bad "$1 —— 期望 exit $2，实得 $3"; fi
}

# ── 桩：一个假的 adb ─────────────────────────────────────────────────
mk_adb() { # mk_adb <devices 输出> <ps 输出>
  cat > "$NYX_TMP/adb" <<EOF
#!/usr/bin/env bash
case "\$1" in
  devices) printf '%s\n' "List of devices attached" "$1" ;;
  shell)   printf '%s\n' "$2" ;;
  forward) exit 0 ;;
  *)       exit 0 ;;
esac
EOF
  chmod +x "$NYX_TMP/adb"
}

# ── 桩：一个回固定答案的 eval（按表达式里的关键词认） ──────────────────
mk_eval() { # mk_eval <user_version 的答案>
  cat > "$NYX_TMP/eval" <<EOF
#!/usr/bin/env bash
# \$1 = ws, \$2 = 表达式
case "\$2" in
  *user_version*)     echo "$1" ;;
  *sync.problems*)    echo "0" ;;
  *revealsAnswer*)    echo "true" ;;
  *nyxDb*)            echo '{"busyTimeoutMs":15000,"dictIo":"random"}' ;;
  *reading_cards*)    echo "7" ;;
  *insert\ into\ items*) echo '{"id":4242,"soft":true}' ;;
  *)                  echo "（桩没认出这条表达式）" ;;
esac
EOF
  chmod +x "$NYX_TMP/eval"
}

echo "accept.sh 自测（不接手机）"
echo

# ── ① 没接手机 → exit 2，且只有一行 ─────────────────────────────────
mk_adb "" "no-nyx-here"
OUT="$(NYX_ADB="$NYX_TMP/adb" bash "$HERE/accept.sh" 2>&1)"; RC=$?
want "没接手机" 2 "$RC"
NYX_LINES="$(printf '%s\n' "$OUT" | grep -c .)"
if [ "$NYX_LINES" = "1" ]; then ok "只打了一行人话"; else bad "应该只打一行，实得 $NYX_LINES 行：$OUT"; fi
case "$OUT" in *没接手机*) ok "话里说清了「没接手机」" ;; *) bad "没说清：$OUT" ;; esac

echo

# ── ② 手机在、App 没在跑 → exit 3 ───────────────────────────────────
mk_adb "stub-device	device" "u0 111 1 0 0 S something.else"
OUT="$(NYX_ADB="$NYX_TMP/adb" bash "$HERE/accept.sh" 2>&1)"; RC=$?
want "手机在但 Nyx 没在跑" 3 "$RC"
case "$OUT" in *"没在跑"*) ok "说清了是哪一步（App 没在跑）" ;; *) bad "没说清：$OUT" ;; esac

echo

# ── ③ 9222 上有页面 → 取 ws → eval → 判定 → 打表 → exit 0 ────────────
# 起一个假的 CDP 列表端点（只需要 /json 那一段 —— accept.sh 就是从它抠 ws 的）
FAKE_PORT=39222
node -e '
const http = require("node:http");
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify([
    { type: "page", url: "http://localhost/", title: "Nyx",
      webSocketDebuggerUrl: "ws://localhost:39222/devtools/page/FAKE" }
  ]));
}).listen(39222, "127.0.0.1");
' &
FAKE_PID=$!
sleep 1

mk_adb "stub-device	device" "u0 21634 1 0 0 S com.nyx.android"
mk_eval "36"
OUT="$(NYX_ADB="$NYX_TMP/adb" NYX_PORT="$FAKE_PORT" NYX_EVAL="$NYX_TMP/eval" \
       bash "$HERE/accept.sh" 2>&1)"; RC=$?
want "全对 → 0" 0 "$RC"
case "$OUT" in
  *"ws://localhost:39222/devtools/page/FAKE"*) ok "从 /json 里取到了 ws 地址" ;;
  *) bad "没取到 ws：$OUT" ;;
esac
case "$OUT" in *"| 开库 · user_version | 36 | 36 | ✔ |"*) ok "断言逐条判定并进了表" ;; *) bad "表里没有那一行" ;; esac
# ★ 判定项共 4 条：user_version · sync.problems · 写库 · revealsAnswer。
#   `note_only` 那几行只报数、不进 ✔ 计数 —— 这条自测第一次跑就把我写错的
#   期望值（5）抓出来了，正是它存在的理由。
case "$OUT" in *"✔ 4 · ✖ 0"*) ok "汇总数对（4 条判定全过）" ;; *) bad "汇总不对：$(printf '%s\n' "$OUT" | grep 汇总)" ;; esac
case "$OUT" in *"__nyx-accept-"*) ok "写库那条把词条打出来了（他能去回收站清）" ;; *) bad "没打出写进去的词条" ;; esac

echo

# ── ④ 有一条对不上 → 那一行 ✖ → exit 1 ─────────────────────────────
mk_eval "38"   # user_version 期望 36，桩回 38
OUT="$(NYX_ADB="$NYX_TMP/adb" NYX_PORT="$FAKE_PORT" NYX_EVAL="$NYX_TMP/eval" \
       bash "$HERE/accept.sh" 2>&1)"; RC=$?
want "有一条对不上 → 1" 1 "$RC"
case "$OUT" in *"| 开库 · user_version | 36 | 38 | ✖ |"*) ok "对不上的那一行标 ✖ 并把实测摆出来" ;; *) bad "没标 ✖" ;; esac

echo

# ── ⑤ --no-write：那一条标「未验」，不算通过 ─────────────────────────
mk_eval "36"
OUT="$(NYX_ADB="$NYX_TMP/adb" NYX_PORT="$FAKE_PORT" NYX_EVAL="$NYX_TMP/eval" \
       bash "$HERE/accept.sh" --no-write 2>&1)"; RC=$?
want "--no-write 仍然全过" 0 "$RC"
case "$OUT" in *"| 写库 · 写一条→读回→软删 | soft:true | 未验 | ○ |"*) ok "没写就标「未验」，不冒充通过" ;; *) bad "--no-write 的那一行不对" ;; esac
case "$OUT" in *"__nyx-accept-"*) bad "--no-write 还是往库里写了" ;; *) ok "--no-write 一个字都没往库里写" ;; esac

echo

# ── ⑥ 参数解析 · 可选组真的被激活了（I-146 的回归闸）────────────────────
# ★★ 为什么补这一条：`--all` / `--group X` 曾经**一个组都激活不了**（五组全打
#    「没跑」），而这份自测当时**测不到** —— 它只测了 `--no-write` 那种标量开关。
#    根因是变量名撞了 bash 内建数组 `GROUPS`，赋值被静默吞掉。
#    这一组就是那道闸：谁再把 `NYX_GROUPS` 改回内建名，这里当场红。
mk_eval "36"
OUT="$(NYX_ADB="$NYX_TMP/adb" NYX_PORT="$FAKE_PORT" NYX_EVAL="$NYX_TMP/eval" \
       bash "$HERE/accept.sh" --all 2>&1)"; RC=$?
want "--all 仍然全过" 0 "$RC"
case "$OUT" in
  *"（组 "*"没跑）"*) bad "--all 之后还有组没跑 —— 参数解析没生效（查变量名是不是撞了 bash 内建）" ;;
  *) ok "--all 之后一个「没跑」都没有" ;;
esac
for g in "T-7.5 Voice ·" "T-2.10 压实 ·" "T-5.12 单条分析 ·"; do
  case "$OUT" in *"$g"*) ok "--all 激活了：$g" ;; *) bad "--all 没激活：$g" ;; esac
done

# --group 只开点名的那些，其余如实标「没跑」（不是全开也不是全不开）
OUT="$(NYX_ADB="$NYX_TMP/adb" NYX_PORT="$FAKE_PORT" NYX_EVAL="$NYX_TMP/eval" \
       bash "$HERE/accept.sh" --group voice 2>&1)"; RC=$?
want "--group voice 仍然全过" 0 "$RC"
case "$OUT" in *"T-7.5 Voice ·"*) ok "--group voice 激活了 voice" ;; *) bad "--group voice 没激活 voice" ;; esac
case "$OUT" in *"（组 compact 没跑）"*) ok "没点名的组如实标「没跑」" ;; *) bad "compact 不该跑却跑了（或没标未验）" ;; esac

echo
echo "自测汇总：✔ $PASS · ✖ $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
