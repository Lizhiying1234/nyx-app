#!/bin/bash
# 主控用：改完 PLAN 之后跑这个再提交。先自动把 NEXT ACTION 里非 NEXT 的任务编号换成文字（check:plan 规则），
# 再跑两仓的 plan 闸。打印 W_EXIT / A_EXIT；任一红就非零退出 —— 提交链一律 `bash scripts/master/plan-gate.sh && git commit …`。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIN="$(cd "$HERE/../.." && pwd)"
AND="${NYX_ANDROID:-/d/Nyx-Android}"
LOG="${TMPDIR:-/tmp}/nyx-plan-gate"; mkdir -p "$LOG"
node "$HERE/deid-next-action.mjs" || exit 9
cd "$WIN" || exit 9
npm run check:plan > "$LOG/gate-w.log" 2>&1; W=$?
cd "$AND" || exit 9
node tools/check-plan.mjs > "$LOG/gate-a.log" 2>&1; A=$?
cd "$WIN"
echo "W_EXIT=$W A_EXIT=$A"; grep -E "✓|✗|不合规" "$LOG/gate-w.log"; grep -E "✓|✗" "$LOG/gate-a.log"
[ "$W" = "0" ] && [ "$A" = "0" ]
