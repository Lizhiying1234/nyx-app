# Nyx

一个自用的语言学习系统，两个端共用一份判据：

- **`windows/`** —— 桌面端（Electron + Svelte 5 + TypeScript + better-sqlite3）。理解材料、析出知识点、出题、练习、统计。
- **`android/`** —— 手机端（Capacitor + Svelte 5 + 原生无障碍服务）。跨 App 取词、单条解析、练习执行。

## 这是一份快照

这个仓库是**当前代码的快照，只有一个提交**，不含开发历史、设计文档、问题清单和截图。
开发过程留在私有仓库里。

## 目录说明

```
windows/            桌面端完整源码
android/            手机端完整源码
  nyx-core/         两端共用的纯逻辑（src/core）、库结构（schema）、AI 提示词（prompts）
```

`nyx-core/` 在真正的开发仓里是一个 git submodule，指向桌面端仓库并锁定 commit SHA ——
**两端共用的逻辑只有一份，不是抄两遍**。为了让这份快照能独立 clone 下来构建，
这里把它实体化成了普通目录，内容取自桌面端仓库的 `35585f5`。
所以 `windows/src/core/` 和 `android/nyx-core/src/core/` 在这里看起来重复，
在开发仓里它们是同一份文件。

## 跑起来需要什么

两端都要自己准备：

- **AI 接口**：OpenAI 兼容的 endpoint 和 key，在软件的设置里填，只存在本地。
- **词典**：桌面端需要 MDX/MDD 词典文件放进 `dicts/`，仓库里没有。
- **同步**（可选）：WebDAV 或 Supabase Storage，凭据也只存在本地。

```
npm install
npm run dev
```

桌面端另见 `windows/使用说明.md`。

## 关于图标与启动图

图标和启动图的**成品**都在仓库里，构建和运行不缺东西。但生成它们用的**原图不在**
（作者的素材，未一并公开），所以 `scripts/gen-brand-icons.mjs` 和 `scripts/gen-splash-art.mjs`
这两个"重新生成"的脚本在这份快照里跑不起来 —— 这是有意的，不是缺文件。

## 许可

未附许可证，保留一切权利。可以阅读和学习，未经许可请勿用于其他用途。
