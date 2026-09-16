#!/usr/bin/env bash
# Live reload —— 装**一次**包，之后网页改动只需刷新，不再重装。
#
# ★★★ 为什么必须有这个（2026-09-01 查实）：
#   装包这件事本身很贵 —— 一轮迭代装十来次，每次都要等构建 + 装 + 冷启动。
#
#   ★ **2026-09-06 更正（T-6.7，2026-09-07 真机再复量一次）**：这里原来写着
#     「重装 App 会自动撤销无障碍绑定，`adb install -r` 每跑一次踹一次」。
#     在 PJE110 / ColorOS 上**实测不成立** —— 装完之后
#     `settings get secure enabled_accessibility_services` 原样，
#     `dumpsys accessibility` 里 `label=Save to Nyx` 的绑定还在。
#     真正会撤销授权的是**强制停止**那一类事件（一键清理 · 上滑杀后台）：
#     `am force-stop` 之后那个设置项直接变成 `null`，而 `am kill` 不会。
#     整张表与出处见 `docs/nyx-system/android/ANDROID_ASSIST.md` §十·八。
#     （别的 ROM / 别的 Android 版本上重装仍可能撤销 —— 那句话不是凭空来的，
#       只是在这台机器上今天不成立。）
#
#   次因（这台机器特有）：`com.nyx.android` 不在电池优化白名单，
#   ColorOS 会在后台清理时把它关掉。那个要在系统设置里加白，脚本不碰。
#
# ★★★ 默认不用它。为什么：live 模式装上去的包**指向我的 dev server**，
#   我这边不开服务时，使用者自己打开 App 会白屏。他每天在用这台机器上的 Nyx，
#   不能为了我少装几次包，让他的 App 变成只有我在场才能用。
#   **现行做法：把改动攒成一批，一次装完**（理由是构建与冷启动的往返，
#   不是授权 —— 见上面那条更正）。
#   只有在「使用者不在用、我要连续调版面」的时候才 up，收工必须 down。
#
# 用法：
#   tools/device/live.sh up     # 起 dev server + 装一次指向它的包（只需做一次）
#   tools/device/live.sh shot out.png ["x y"...]   # 刷新 + 点坐标 + 截图（不重装）
#   tools/device/live.sh down   # 装回正常包（web 资源打进 APK），dev server 关掉
set -euo pipefail

# ★★ 同 ship.sh / accept.sh（I-154）：ROOT 从**脚本自身的位置**推，不许写死。
#    写死之后在 worktree 里跑它，会去改**主检出**的 capacitor.config.json、
#    从主检出构建装机、还在主检出起 dev server —— 装错代码 + 动了不该碰的目录。
#    脚本在 `<ROOT>/tools/device/` 下，往上两级就是 ROOT。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADB="D:/android-toolchain/sdk/platform-tools/adb.exe"
PKG="com.nyx.android"
PORT=5173
CFG="$ROOT/capacitor.config.json"
BAK="$ROOT/capacitor.config.json.orig"
export JAVA_HOME="D:/android-toolchain/jdk-21.0.12.1+1"
export ANDROID_HOME="D:/android-toolchain/sdk"

install_apk() {
  cd "$ROOT/android"
  ./gradlew assembleDebug --init-script nyx-mirrors.init.gradle -q 2>&1 | tail -3
  "$ADB" install -r "$ROOT/android/app/build/outputs/apk/debug/app-debug.apk" 2>&1 | tail -1
  # ★ 这里原来打印「授权已被系统撤销，需要重新授权一次」—— 与上面那条更正同一个错话，
  #   两次改头注都漏了它。现在如实报当前状态，不替系统下结论。
  local svc
  svc="$("$ADB" shell settings get secure enabled_accessibility_services 2>/dev/null | tr -d '\r')"
  case "$svc" in
    *com.nyx.android*) echo "✓ 装完了，无障碍授权还在（install -r 不撤销；只有强制停止会撤）。" ;;
    *) echo "⚠ 装完了，但当前**没有**无障碍授权 —— 去系统设置里放行一次（强制停止过就会这样）。" ;;
  esac
}

case "${1:?用法: live.sh up|shot|down}" in
up)
  cd "$ROOT"
  [ -f "$BAK" ] || cp "$CFG" "$BAK"
  python - "$CFG" "$PORT" <<'PY'
import json,sys
p,port=sys.argv[1],int(sys.argv[2])
c=json.load(open(p,encoding='utf-8'))
c['server']['url']=f'http://localhost:{port}'
c['server']['cleartext']=True
json.dump(c,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
print('capacitor.config.json → 指向 dev server',port)
PY
  npx cap sync android >/dev/null 2>&1
  cp "$BAK" "$CFG"          # 立刻还原，别让指向 dev 的配置留在仓库里
  "$ADB" reverse "tcp:$PORT" "tcp:$PORT"
  ( cd "$ROOT" && npm run dev >/dev/null 2>&1 & )
  sleep 3
  install_apk
  echo "✓ live 模式已开。之后改 svelte/css 只要 live.sh shot，**不再重装**。"
  ;;
shot)
  SHOT="${2:?用法: live.sh shot <截图路径> [\"x y\"...]}"; shift 2 || true
  "$ADB" shell am force-stop "$PKG"; sleep 1
  "$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 7
  for tap in "$@"; do "$ADB" shell input tap $tap; sleep 2; done
  sleep 1
  "$ADB" exec-out screencap -p > "$SHOT"; ls -la "$SHOT"
  ;;
down)
  cd "$ROOT"
  [ -f "$BAK" ] && cp "$BAK" "$CFG" && rm -f "$BAK"
  npm run build 2>&1 | grep -E "prune-woff|built in" || true
  npx cap sync android >/dev/null 2>&1
  install_apk
  echo "✓ 已装回正常包（web 打进 APK）。"
  ;;
*) echo "用法: live.sh up|shot|down"; exit 1;;
esac
