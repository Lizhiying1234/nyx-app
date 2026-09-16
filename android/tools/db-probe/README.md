# db-probe · Android 数据库准入验证（D-270 第 6 条）

> **这是准入实验，不是 Android 第一版。** 不做 UI、不做同步客户端、不做业务功能。
> 跑完就删，不许变成生产代码。

---

## 它要回答的那一句话

```
Windows 的 schema/v33.sql
   ↓  拿到**真 Android 设备**上执行
Android SQLite runtime 建出来的库
   ↓  读 pragma + 量同步表面
与 Windows 基线比：指纹是不是同一个？
```

**Windows 基线**（`expected.json`，由 `run-node.mjs --write-baseline` 生成）：

```
user_version   33
同步表         30 张
列/外键/触发器  313 / 27 / 29
规范化文本     10885 字
指纹           9dde78ab1d916501
```

---

## 判据分层（按 D-269 / D-270 定的，不是随手划的）

### 必须一致 —— 不一致就是 **FAIL**

| 项 | 为什么 |
|---|---|
| **schema fingerprint** | D-269：不一致 → 收包时**整包拒绝**。这是唯一真正的判据 |
| `user_version` | 建库版本 |
| 同步表数量与表名（30 张） | 少一张 = 那张表的数据永远同步不过去，且不报错 |
| `foreign_keys = 1` | 外键没启用 → 关系不被约束 → 孤儿行 |
| `integrity_check = ok` | 库本身要是好的 |

### 允许不同 —— 只报告，不判定

```
sqlite_version · page_size · encoding · auto_vacuum · temp_store
locking_mode · busy_timeout · journal_mode · cache_size · synchronous
```

**为什么这些可以不同**：D-269 明写「指纹只针对**同步表面**」——
Android 的 SQLite 版本、日志模式、页大小是**平台怎么实现**的事，
两端本来就该不同。把它们算进判定，等于把「平台本来就不同」误判成结构不兼容。

### 指纹已经吸收掉的差异（所以不用担心）

`core/schema-fingerprint.ts` 的规范化已经处理了这几类跨版本差异：

| 差异 | 怎么处理的 |
|---|---|
| 自动索引的名字（`sqlite_autoindex_*`） | **只算列集与唯一性，不算名字** |
| 类型写法（`TEXT` vs `text` vs `Text  `） | 大写 + 压空白 |
| 默认值的引号风格（`'x'` vs `"x"`） | 统一成单引号（但保留「是不是字符串」的区分） |
| 外键动作空值 vs `NO ACTION` | 统一成 `NO ACTION` |
| 列 / 索引 / 触发器的返回顺序 | 全部排序 |

**真正会让指纹变的只有三类**：少一条触发器 · 少/多一列 · 外键或显式索引不一样。

---

## 第一步：先在 PC 上自证（**已完成**）

```bash
node tools/db-probe/run-node.mjs        # 默认读 submodule nyx-core/（T-1.3）；也可 --repo 指一个 nyx_project 检出
```

结果：`✓ 与基线一致 —— 探针本身是好的，可以拿去真机`
（SQLite 3.53.1 / node:sqlite，指纹 `9dde78ab1d916501`）

> **为什么要有这一步**：一个从没被跑过的探针，和没有探针是一回事。
> 先证明这套逻辑能复现 Windows 基线，真机上再红，那就是**设备**的问题。

---

## 第二步：真机（**尚未执行 —— 缺工具链**）

### 需要什么

| # | 要什么 | 这台机器现状 |
|---|---|---|
| 1 | JDK 17+ | ❌ 没有 |
| 2 | Android SDK + platform-tools（`adb`） | ❌ 没有 |
| 3 | Gradle（Android Studio 自带） | ❌ 没有 |
| 4 | 一台开了 USB 调试的 Android 手机 | ❓ 未连接 |

装法（任选其一）：Android Studio（约 8–10 GB，含全部）或
命令行 `commandlinetools` + JDK（约 2 GB，够用）。

### 怎么跑（推荐路线 A，与 `TECH_STACK_DECISION.md` 的推荐一致）

```
① npx @capacitor/cli create 一个最小工程（只加 @capacitor-community/sqlite）
② 把这三样打进 bundle：
     tools/db-probe/probe.mjs
     Windows 仓库的 src/core/sync-tables.ts
     Windows 仓库的 src/core/schema-fingerprint.ts
   ★ 从仓库取，不要复制第二份到这里
③ 把 Windows 仓库的 schema/v33.sql 作为 asset 打进去
④ 启动时：建库 → exec(v33.sql) → pragma user_version = 33
⑤ 调 probe(query, deps)，deps.sha256 用 WebCrypto
⑥ 把结果 JSON 打到 logcat 或写文件，adb pull 回来
⑦ 与 expected.json 比：node -e "…compare(got, baseline)…"
```

**如果最终技术栈不是 Capacitor**：`probe.mjs` 是纯逻辑、依赖全注入，
换任何能给出 `query(sql) -> rows[]` 的驱动都能跑；Kotlin 路线则照它逐条实现同样的读取。

---

## 第三步：结果怎么判（D-270）

### PASS

指纹一致 + `user_version` 33 + 30 张表齐 + `foreign_keys=1` + `integrity_check=ok`
→ **D-270 第 6 条完成**，可以进入 Step 9（Android database layer）。

### FAIL

**不要继续进入 Android database implementation**（D-270 原文）。先报告：

| 要答 | 怎么判 |
|---|---|
| 失败项 | `compare()` 会逐行打印 Windows / 这台的差异行（`T` 表名 / `C` 列 / `F` 外键 / `X` 隐式索引 / `I` 显式索引 / `G` 触发器） |
| 失败原因 | 差异行的首字母就说明了是哪一类 |
| 影响 schema 吗 | 差在 `C` / `F` / `I` / `G` → 是 |
| 影响 sync 吗 | **指纹一变就影响** —— 收包时整包被拒 |
| 要换技术栈吗 | 只有当**同一段 DDL 在 Android SQLite 上根本建不出同样的对象**时才是栈的问题；若只是 pragma 差异，改设置即可 |
| 最小修复 | 优先改**建库那一步**（比如显式建索引、显式写 `NO ACTION`），**绝不改 `schema/vNN.sql` 去迁就设备** —— 那会让 Windows 侧指纹跟着变 |

---

## 边界（这一阶段明确不做）

不做 Android UI · 不做完整 database implementation · 不做 sync client ·
不做扫码配置 · 不做任何业务功能 · **不把 probe 变成生产代码**。
