#!/usr/bin/env bash
# 一条命令走完：构建 → 同步 → 打包 → 装机 → 冷启动 →（可选）按一串坐标 → 截图
#
# 为什么存在（D-405③）：整轮只要 ~12s，慢的从来不是构建而是**回合数**。
# 一条 eval 发一次、看一眼、再发下一条，是这个项目最贵的时间浪费。
# 另外：Git Bash 里 `cd` 的工作目录在多次调用之间会漂，全用绝对路径就没这个问题。
#
# 用法：
#   tools/device/ship.sh out.png                    # 构建装机后截首屏
#   tools/device/ship.sh out.png "190 1180" "400 1400"   # 再依次点两下
#   NOBUILD=1 tools/device/ship.sh out.png "190 1180"    # 跳过构建，只操作+截图
set -euo pipefail

# ★★ ROOT 从**脚本自身的位置**推，不许写死（I-154）。
#    写死 `/d/Nyx-Android` 的后果是：在 worktree（`.claude/worktrees/<名>/`）里跑它，
#    会跑去**主检出**构建装机 —— 既装错代码，又动了这个会话不该碰的目录。
#    2026-09-06 的真机批里就是因为这条，我不得不放弃 ship.sh 手动走一遍装机。
#    脚本在 `<ROOT>/tools/device/` 下，所以往上两级就是 ROOT。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADB="D:/android-toolchain/sdk/platform-tools/adb.exe"
PKG="com.nyx.android"
export JAVA_HOME="D:/android-toolchain/jdk-21.0.12.1+1"
export ANDROID_HOME="D:/android-toolchain/sdk"

SHOT="${1:?用法: ship.sh <截图路径> [\"x y\"...]}"
shift || true

if [ "${NOBUILD:-0}" != "1" ]; then
  cd "$ROOT"
  npm run build 2>&1 | grep -E "prune-woff|built in|error" || true
  npx cap sync android >/dev/null 2>&1
  # ★ `cap sync` 会按**当前目录的位置**重写 android/capacitor.settings.gradle
  #   （worktree 里改成 `../../../../node_modules`，指回主检出）。它是 capacitor
  #   每次重新生成的文件，**不该带着某个 worktree 的位置进版本库** —— 那样合进
  #   master 就会让主检出的 Gradle 去 D:\node_modules 找依赖，直接构建失败。
  #   在跑 gradle **之前**就还原，是因为版本库里那份写的是 `../node_modules`，
  #   而它在主检出和 worktree 里都是对的（各自都有自己的 node_modules；
  #   没有的话上面那句 `npm run build` 早就失败了）。
  git -C "$ROOT" checkout -- android/capacitor.settings.gradle 2>/dev/null || true
  cd "$ROOT/android"
  ./gradlew assembleDebug --init-script nyx-mirrors.init.gradle -q 2>&1 | tail -3
  "$ADB" install -r "$ROOT/android/app/build/outputs/apk/debug/app-debug.apk" 2>&1 | tail -1
fi

"$ADB" shell am force-stop "$PKG"
sleep 1
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 8

for tap in "$@"; do
  # shellcheck disable=SC2086
  "$ADB" shell input tap $tap
  sleep 2
done
sleep 1

"$ADB" exec-out screencap -p > "$SHOT"
ls -la "$SHOT"
