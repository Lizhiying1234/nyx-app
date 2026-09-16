# Nyx

A personal language-learning system, built for one user, running on two ends that share one source of truth.

- **`windows/`** — Desktop app (Electron, Svelte 5, TypeScript, better-sqlite3 in WAL mode).
  Read material, pull out what is worth learning, generate exercises, practise, keep the record.
- **`android/`** — Phone companion (Capacitor, Svelte 5, a native accessibility service).
  Look up and capture words from inside any other app, analyse a single item, run exercises.

## This is a snapshot

This repository is **the current code as a single commit**. It carries no development history,
no design documents, no issue log and no screenshots — those stay in the private repositories.

## Layout

```
windows/            desktop source
android/            phone source
  nyx-core/         logic shared by both ends (src/core), database schema, AI prompts
```

In the real development repository `nyx-core/` is a git submodule pinned to a commit of the desktop
repository — **the shared logic exists once, it is not copied into both ends.** To make this snapshot
clonable on its own it has been materialised into a plain directory here, taken from desktop commit
`35585f5`. So `windows/src/core/` and `android/nyx-core/src/core/` look duplicated here; upstream they
are the same files.

## A few design decisions

- **SQLite is the only truth.** The UI holds no copy of the data and never touches the database or the
  AI directly — everything goes through the main process.
- **The database only grows.** Numbered migrations, a backup before every upgrade, a self-check after.
  Nothing on a synced table is ever hard-deleted behind the user's back.
- **Five kinds of generated exercise, and multiple choice is not one of them.** Recognising the right
  option is not the same as being able to produce the phrase.
- **Prompts are files, not code** (`prompts/*.md`) — editable in any text editor without a rebuild.
- **All CSS lives in global stylesheets**; Svelte components carry no styles. No UI component library,
  no Tailwind.

## Running it

```
npm install
npm run dev
```

You have to supply three things yourself, and none of them are in this repository:

- **An AI endpoint and key** (OpenAI-compatible). Entered in the app's settings, stored locally only.
- **Dictionaries** — the desktop app reads MDX/MDD dictionary files from `dicts/`.
- **Sync** (optional) — WebDAV or Supabase Storage. Credentials also stay local.

See `windows/使用说明.md` for the desktop app's own manual (Chinese).

## Icons and splash art

The **generated** icons and splash images are all here, so the apps build and run with nothing missing.
The **source artwork** they were generated from is not included, so `scripts/gen-brand-icons.mjs` and
`scripts/gen-splash-art.mjs` cannot run in this snapshot. That is deliberate, not a missing file.

## License

No licence is attached. All rights reserved — you are welcome to read it and learn from it,
please do not reuse it without permission.

---

# Nyx（中文）

一个自用的语言学习系统，两个端共用一份判据。

- **`windows/`** —— 桌面端（Electron + Svelte 5 + TypeScript + better-sqlite3，WAL）。
  理解材料、析出知识点、出题、练习、记录。
- **`android/`** —— 手机端（Capacitor + Svelte 5 + 原生无障碍服务）。
  在任何别的 App 里取词查词、单条解析、执行练习。

## 这是一份快照

本仓库是**当前代码的快照，只有一个提交**，不含开发历史、设计文档、问题清单和截图 —— 那些留在私有仓库里。

## 目录

```
windows/            桌面端源码
android/            手机端源码
  nyx-core/         两端共用的纯逻辑（src/core）、库结构（schema）、AI 提示词（prompts）
```

在真正的开发仓里 `nyx-core/` 是一个 git submodule，指向桌面端仓库并锁定 commit SHA ——
**共用的逻辑只有一份，不是两端各抄一遍。** 为了让这份快照能独立 clone 下来构建，这里把它
实体化成了普通目录，内容取自桌面端的 `35585f5`。所以 `windows/src/core/` 和
`android/nyx-core/src/core/` 在这里看起来重复，在开发仓里它们是同一份文件。

## 几条设计上的取舍

- **SQLite 是唯一真相**：界面不持有数据副本，也不直接碰数据库和 AI，一律走主进程。
- **数据库只增不删**：编号迁移、升级前备份、迁移后自检；同步表上不做用户看不见的硬删除。
- **产出题型只有五种，里面没有选择题**：认得出正确选项，和能自己说出来，不是一回事。
- **提示词是文件不是代码**（`prompts/*.md`）：记事本就能改，不用重新构建。
- **全部 CSS 放全局样式表**，Svelte 组件里不写样式；不引 UI 组件库，不用 Tailwind。

## 跑起来

```
npm install
npm run dev
```

有三样东西要你自己准备，仓库里都没有：

- **AI 接口与 key**（OpenAI 兼容）：在软件设置里填，只存在本地。
- **词典**：桌面端读 `dicts/` 下的 MDX/MDD 词典文件。
- **同步**（可选）：WebDAV 或 Supabase Storage，凭据同样只存在本地。

桌面端另见 `windows/使用说明.md`。

## 图标与启动图

图标和启动图的**成品**都在，构建和运行不缺东西；生成它们用的**原图不在**，所以
`scripts/gen-brand-icons.mjs` 和 `scripts/gen-splash-art.mjs` 在这份快照里跑不起来。
这是有意的，不是缺文件。

## 许可

未附许可证，保留一切权利。欢迎阅读和学习，未经许可请勿用于其他用途。
