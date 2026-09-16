# Phase 0 · M1 真机验证 —— 事务能不能扛住整次升级（2026-08-25）

> D-297（B′）要求升级有两条硬保证：**成功 → 新库；失败 → 旧库原样。**
>
> M2（临时库 + 文件替换）能拿到它，代价是需要一个插件没有直接提供的文件级操作。
> M1 想用 SQLite 自己的事务拿到**同一条**保证。
>
> **「事务能不能撤销 DDL」不许猜** —— 猜错的下场是升级失败之后库变成半拉子，
> 那正是 B′ 要杜绝的形态。所以拿真机测。

## 判定

```
✓ M1 全部通过 —— 事务足以扛住整次升级，不需要文件级替换
```

**因此采用 M1。M2 不再需要。**（使用者 2026-08-25 的指示：
「如果 M1 已足够满足完整保证，优先 M1」。）

## 环境

真机 OnePlus **PJE110** · Android 16 · serial `6ccc1ca9` ·
`@capacitor-community/sqlite` **7.0.3** · 目标结构 **v34**（建库 136 条，
`core/sql-split.ts` 切好逐条 `run`）· `journal_mode = delete`

## 六项逐条结果

| # | 验什么 | 结果 |
|---|---|---|
| **M1-G** | `pragma foreign_keys` 的开关位置 | 事务外可关（1→0）· **事务内是 no-op**（→1）<br>⇒ ★ **必须在 `BEGIN` 之前关** |
| **M1-C** | `pragma user_version` 参不参与事务 | ✅ 34 → 事务内 999 → **回滚后 34** |
| **M1-A** | DDL 能不能在事务里跑 | ✅ 触发器已删 · 新表已建 · 表改名生效 |
| **M1-B** ★ | **回滚能不能撤销 DDL** | ✅ 触发器回来 · 新表没了 · 表名复原 ·<br>`review_logs` 20/20 行 · `sqlite_master` 对象 **134/134** |
| **M1-D/E** | 整次重建放进一个事务，提交后数据完整 | ✅ `review_logs` 20/20 · `reading_cards` 3/3 ·<br>`interval_days` 合计 12/12 · `user_version` 34 · `integrity_check` ok |
| **M1-F** ★ | **中途失败 → 旧库原样** | ✅ 抛错有 · 对象 134/134 · `review_logs` 20/20 ·<br>`reading_cards` 3/3 · interval 12/12 · uv 34/34 |

M1-D/E 跑的就是 B′ 第 ②③④ 步在 M1 形态下的完整样子：

```
关外键（在 BEGIN 之前）
BEGIN
  删掉全部 trigger / index
  review_logs · reading_cards 改名到 _keep_*
  其余表全删
  执行 schema/v34.sql（同一份 sql，逐条 run）
  insert ... select 从 _keep_* 导回        ← 数据从不进 JS 内存
  drop _keep_*
  pragma user_version = 34
COMMIT
```

M1-F 故意在「导回途中」插一条不存在的表，验证 `rollbackTransaction()` 之后
**对象数、行数、字段合计、user_version 全部与动手之前逐项相同**。

## 这一条对实现的三个硬约束

1. **`pragma foreign_keys = OFF` 必须在 `BEGIN` 之前执行** —— 事务内设它是 no-op（M1-G 实测）
2. **`pragma user_version` 参与事务** —— 可以放在 COMMIT 之前写，回滚会一起撤销（M1-C）
3. **数据用 `insert ... select` 从改名后的表导回** —— 不经过 JS 内存，
   几万行的 `review_logs` 也不会把 WebView 撑爆

## 为什么不再验 M2

M1 拿到了 B′ 要的全部保证，而且**不需要任何文件操作** ——
少一个依赖（`@capacitor/filesystem` 或原生 shim）、少一处平台差异、
少一类「文件替换到一半掉电」的失败形态。

M2 保留为退路：将来若发现某个 SQLite 版本上事务撤销 DDL 不成立，
再回到 D-297 第四节的 M2 分支，**并且要重开裁决，不许默默换路**。

## 怎么复跑

```
cd tools/db-probe/device-harness
node prepare.mjs
D:/claude_code_workspace/nyx_project/node_modules/.bin/esbuild.cmd www/m1-run.js \
  --bundle --format=esm --platform=browser --target=es2020 --outfile=www/m1-bundle.js
# 把 www/index.html 的 <script src> 换成 m1-bundle.js
npx cap sync android && node patch-plugin-repos.mjs && node patch-gradle.mjs
cd android && ./gradlew installDebug --no-daemon --init-script nyx-mirrors.init.gradle
```

结果从屏幕读（`adb exec-out screencap -p`）——
设备对这个应用的 logcat 有配额限流，见 `README.md` 末节。

原始结果：`m1-transaction-verdict.png`。

★ 2026-09-04：`m1-transaction-verdict.png` 已从仓库删除（Phase 1A 清理），
取回：`git show d4a7e74:tools/db-probe/results-v34/m1-transaction-verdict.png > x.png`。本文判定文字不变。
