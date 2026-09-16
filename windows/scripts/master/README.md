# 主控（Master）工具 · 2026-09-07

给「总控」会话用的三件小工具，随仓走，换会话不用重写：

| 文件 | 干什么 | 怎么用 |
|---|---|---|
| `plan-gate.sh` | 改完 `NYX_MASTER_PLAN.md` 之后：先自动把 NEXT ACTION 里非 NEXT 的任务编号换成文字，再跑两仓的 plan 闸 | `bash scripts/master/plan-gate.sh && git add NYX_MASTER_PLAN.md && git commit …`（**只许 `&&` 串到 commit**，红了不提交） |
| `deid-next-action.mjs` | 上面那一步的第一半，可单独跑 | `node scripts/master/deid-next-action.mjs` |
| `changelog-insert.mjs` | 往 Android 仓 `docs/nyx-system/findings/CHANGE_LOG.md` 的「## 流水」后面插一条（正文从文件读，绕开模板字符串里的反引号） | `node scripts/master/changelog-insert.mjs <CHANGE_LOG 路径> <正文 .md>` |

主控的工作方式见 `NYX_MASTER_PLAN.md` PLAN HEALTH RULES 末尾「工作方式精简」；交接见 NEXT ACTION「主控交接」。
Android 仓路径默认 `/d/Nyx-Android`，可用环境变量 `NYX_ANDROID` 覆盖。
