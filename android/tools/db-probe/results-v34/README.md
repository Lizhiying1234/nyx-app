# Gate 2 重跑 · v34 · 原始结果（2026-08-25）

> D-296 拆表之后同步表面指纹变了，**2026-08-24 那次 v33 的真机结论不再覆盖当前结构**，
> 所以 Gate 2 按 D-270 第 6 条重跑了一遍。本目录是**原始结果**，不是结论摘要。

## 判定

```
PASS —— 两把尺子都与 Windows 基线一致
连续两次（第二次从上一次留下的脏库起步）都 PASS
```

## 设备与运行环境

| | |
|---|---|
| 设备 | OnePlus **PJE110** · Android **16** · Build TP1A.220905.001 · serial `6ccc1ca9` |
| WebView | Chrome **148.0.7778.178** |
| 插件 | `@capacitor-community/sqlite` **7.0.3** · Capacitor 7 |
| 工具链 | JDK **21.0.12.1+1** (Temurin) · Gradle 8.11.1 |
| schema 来源 | `schema/v34.sql`（2026-08-25T09:12:51.051Z 从 Windows 仓库拉取） |
| 建库方式 | JS 侧按 SQLite 语法切成 **136 条**，逐条 `db.run()`（A-1 的 workaround，未走 `execute()`） |

## 两端逐项对照

### 必须一致 —— 全部一致

| 项 | Windows 基线 | Android 真机 | |
|---|---|---|---|
| **同步表面指纹** | `07dd1cfd1f4f514a` | `07dd1cfd1f4f514a` | ✅ |
| **完整本地结构**（含触发器正文） | `9a744e3e4f5934c8`（26444 字） | `9a744e3e4f5934c8`（26444 字） | ✅ **逐字相同** |
| `user_version` | 34 | 34 | ✅ |
| 同步表 | 31 | 31（缺 0） | ✅ |
| 列 | 324 | 324 | ✅ |
| 外键 | 28 | 28 | ✅ |
| 触发器 | 32 | 32 | ✅ |
| 规范化文本 | 11347 字 | 11347 字 | ✅ |
| `foreign_keys` | 1 | 1 | ✅ |
| `integrity_check` | ok | ok | ✅ |

### 允许不同 —— 平台项，只报告不判定

| 项 | Windows | 这台 |
|---|---|---|
| `sqlite_version` | 3.53.1 | 3.50.4 |
| `busy_timeout` | 0 | 2500 |
| `synchronous` | 2 | 1 |
| `page_size` / `encoding` / `auto_vacuum` / `temp_store` / `locking_mode` / `journal_mode` / `cache_size` | — | 4096 / UTF-8 / 0 / 0 / normal / delete / -2000 |

## 与 v33 那次的差异（都在预期之内）

| | v33（2026-08-24） | v34（本次） |
|---|---|---|
| 同步表 | 30 | **31**（+`reading_cards`） |
| 列 / 外键 / 触发器 | 313 / 27 / 29 | **324 / 28 / 32** |
| 同步表面指纹 | `9dde78ab1d916501` | **`07dd1cfd1f4f514a`** |
| 完整本地结构 | `d065e01fba453fab`（24895 字） | **`9a744e3e4f5934c8`**（26444 字） |
| 建库语句 | 129 条 | **136 条** |

+1 表 / +11 列 / +1 外键 / +3 触发器 —— 与 V34 迁移写下的东西**逐项对得上**：
`reading_cards` 及其三条索引，加上 `trg_reading_cards_uid`、`trg_items_reading_card`、
`trg_items_reading_card_late` 三条触发器。

## 文件

| 文件 | 是什么 |
|---|---|
| `run1-top.png` | 第一次运行 · 上半屏（设备信息 + 两把尺子的数字） |
| `run1-verdict.png` | 第一次运行 · 判定（`✓ 逐字相同` + `✓ PASS`） |
| `run2-verdict.png` | **第二次**运行 · 判定（从脏库起步，结果与第一次逐项相同） |
| `pc-baseline.log` | PC 侧重新生成 v34 基线 |
| `pc-selftest.log` | 探针自证：`✓ 与基线一致 —— 探针本身是好的，可以拿去真机` |
| `pc-verify-split.log` | 切分器无损性：136 条语句 / 32 条 create trigger / **0 条收尾不完整**；负对照（插件那套切法）**如期失败** |
| `pc-verify-bundle.log` | 壳预演：esbuild 转译后、真正打进 APK 的那份代码算出 `07dd1cfd1f4f514a` |

## 这一轮**没有**做的事

- **没有修改 Windows baseline** —— 指纹是两边各自独立算出来后对上的
- **没有为了让测试通过修改 schema** —— `schema/v34.sql` 是 `npm run schema:dump` 生成的，一个字没手改
- **没有开始 Android database implementation**

## 一处执行细节（记下来，免得下次重踩）

第一次跑完在 logcat 里**抓不到结果**，原因不是探针，是设备限流：

```
W LOG_FLOWCTRL: ==LOGS OVER PROC QUOTA(300), rows(331) bytes(62807) com.nyx.dbprobe DROPPED==
```

Capacitor 每条 pragma 查询打两行日志，几百条把这个应用的 logcat 配额撑爆，
探针最后那一行 `NYX_PROBE_RESULT` 被丢掉了。

处置：`capacitor.config.json` 加 `"loggingBehavior": "none"` 关掉插件的逐条调用日志。
副作用是 JS 的 `console.log` 也一并被 Capacitor 拦下，所以结果改从**屏幕**读（截屏即上面三张）。
**这只影响结果怎么传出来，不影响探针测什么。**

另：`gradlew` 必须带 `--init-script nyx-mirrors.init.gradle` ——
这条网络连不上 `dl.google.com`，不带就停在
`Could not resolve com.android.tools.build:gradle:8.7.2`。

---

★ **2026-09-04（Phase 1A 清理）**：上表的截图（`run1-top.png` · `run1-verdict.png` · `run2-verdict.png`）
已从仓库删除，判定文字与数字原样保留。要看原图：

```
git show d4a7e74:tools/db-probe/results-v34/run1-verdict.png > run1-verdict.png
```
