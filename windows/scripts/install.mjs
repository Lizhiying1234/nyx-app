/**
 * 把打包好的新版本装到软件文件夹。
 *
 * 装法是**先清空程序目录、再拷新版本**，而这只有在一个前提下才安全：
 *
 *   ★ 程序目录里除了 `data/` 之外，没有任何属于使用者的东西。
 *
 * 这个前提是 I-106 才建立起来的 —— 在那之前，词典在 `<软件>/dicts`、
 * 使用者改过的提示词在 `<软件>/prompts`，两样都在删除区。
 * 2026-08-05 我就是这么把他 22 本词典（OALD10、TLD、朗文全家）删掉的，
 * 回收站里都没有。现在两样都归到 `data/` 底下，边界才真正画清楚。
 *
 * 所以这个脚本做三件事，缺一不可：
 *   ① 清空之前**先检查**：程序目录里有没有名单之外的可疑东西？有就停下来问
 *   ② 只删程序文件，`data/` 一个字节不碰
 *   ③ 装完**核对**：`data/` 还在吗、里面的东西还是原来那些吗
 *
 * 用法：node scripts/install.mjs [目标目录]   默认 D:\Nyx
 *      node scripts/install.mjs --dry-run    只说会做什么，不动手
 *      node scripts/install.mjs --force      名单之外有东西时也照删（想清楚再用）
 *
 * ── ★★ 装机要在**独立的 release worktree** 里出包（T-9.9 · 2026-09-06）──────
 *
 * 2026-09-06 真出过一次：我在主检出 build → package，正等使用者关掉 Nyx 的那几分钟里，
 * 另一条线在**同一个主检出**跑了 `npm run gate`（它里面有 build），
 * 把 `src/main/build-info.json` 盖成了另一个提交、而且 `dirty:true`。
 * 于是这个脚本拷的是**我 11:52 打的包**，写进 `BUILD.txt` 的却是**11:56 别人的纸条**——
 * 装的是 A，纸条说是 B。更糟的是 `npm run installed` 当时报「✔ 一致」：
 * 它比的是纸条与仓库 HEAD，而纸条正是被那次构建写进去的，两边当然一致。
 * **一次什么都没验到的绿。**
 *
 * 所以装机这条链现在这么走：
 *
 *     git worktree add .claude/worktrees/release <要装的 sha>
 *     # node_modules 做成 junction，别 npm install
 *     cd .claude/worktrees/release
 *     npm run build          # 真跑，别用 if-stale：BUILD.txt 抄的就是这一次写的纸条
 *     npx electron-builder --dir
 *     node scripts/install.mjs --dry-run
 *     node scripts/install.mjs
 *
 * 一个只属于这次装机的检出，别人不会在里面构建。装完把那个 worktree 删掉。
 * 下面那道「包比纸条旧就拒装」的闸是兜底 —— 万一还是在共用检出里出的包，它拦得住。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'release', 'win-unpacked')
const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const force = args.includes('--force')
const dest = resolve(args.find((a) => !a.startsWith('--')) ?? 'D:\\Nyx')

if (!existsSync(src)) {
  console.error(`✖ 没有打包产物：${src}\n  先跑 npm run package`)
  process.exit(1)
}

/**
 * ★★ 闸：**包不能比纸条旧**（T-9.9 · 2026-09-06）
 *
 * `BUILD.txt` 抄的是仓里 `src/main/build-info.json`，而那份是 `npm run build` 写的；
 * 包是随后 `electron-builder` 打的。**正常顺序下包一定晚于纸条。**
 * 一旦反过来（包 11:52 < 纸条 11:56），只有一种解释：
 * 打完包之后又有人构建过，纸条已经不是描述这个包的了 —— 再装下去，
 * 使用者手上就会出现「程序是 A、纸条说是 B」，而这件事**事后极难发现**。
 *
 * 判据只看时间先后，宁可停下来让人重打一次包，也不要装一个说不清自己是谁的东西。
 * ★ 在**动手删之前**判 —— 和下面那条「Nyx 正在运行」一样，删除不可逆。
 */
const infoPathPre = join(root, 'src', 'main', 'build-info.json')
const asarPath = join(src, 'resources', 'app.asar')
if (existsSync(infoPathPre)) {
  const builtAt = Date.parse(JSON.parse(readFileSync(infoPathPre, 'utf8')).builtAt ?? '')
  // 优先看 app.asar（那才是软件本身）；没有就退回可执行文件
  const probe = existsSync(asarPath) ? asarPath : join(src, 'Nyx.exe')
  if (Number.isFinite(builtAt) && existsSync(probe)) {
    const packedAt = statSync(probe).mtimeMs
    const fmt = (ms) => new Date(ms).toLocaleString('sv')
    if (packedAt < builtAt) {
      console.error(
        `\n✖ 停下：**包比纸条旧**，装下去会出现「程序是这一份、BUILD.txt 说是另一份」。\n` +
          `    包　　${fmt(packedAt)}　${probe}\n` +
          `    纸条　${fmt(builtAt)}　${infoPathPre}\n\n` +
          `  多半是打完包之后又有人（或另一条会话）跑过一次构建，把纸条盖掉了。\n` +
          `  重新打一次包再装：npx electron-builder --dir\n` +
          `  ★ 更稳的做法是在独立的 release worktree 里 build + package + install（见本文件头注）。`
      )
      process.exit(1)
    }
  }
}

/**
 * 使用者的东西 —— 任何情况下都不删。
 * ★ 这一份名单**三处共用**：删除循环让开它 · 拷贝循环跳过它 · 下面那道闸不许它出现在包里。
 *   各写各的就会漂 —— I-194 正是「删除循环有、拷贝循环没有」。
 */
const KEEP = ['data']

/**
 * ★★ 闸 `install:no-data-in-package` —— **包里不许有 `data/`**（I-194 · 2026-09-15）
 *
 * 删除循环按 `KEEP` 把 `data/` 让开了，可**拷贝循环原来没有对应的过滤**：
 * 只要 `release/win-unpacked/` 里出现 `data/`，那一行 `cpSync(…, { force: true })`
 * 就会带着它递归盖进 `<目标>/data` —— **同名文件（含 `nyx.db`）直接被覆盖**。
 * 挡在「测试库」和「他的真库」之间的，原来只有一个收尾钩子。
 *
 * 它真的会出现：D-263 让打包后的应用把数据写在自己的文件夹里，
 * 所以 `npm run smoke:packaged` 真起一次那个 exe，`win-unpacked/data/` 就被建出来
 * （`tests/packaged.test.ts` 还断言它存在）。那一套跑完会自己删掉，所以正常路径看不见 ——
 * **中途挂掉 / Ctrl-C / 被杀掉，它就留在包里了。**
 * 而 CLAUDE.md §四 的装机配方里，`smoke:packaged` 正排在这个脚本**前一步**：
 * 危险顺序就是文档推荐的顺序。
 *
 * 判据只看「在不在」，不看里面是什么：包里出现 `data/` 这件事本身就说明上一步没跑完。
 * ★ `--force` 不放行 —— `--force` 说的是「名单之外那些东西可以删」，和这件事无关。
 * ★ 放在**最靠前**：动手之前判（删除不可逆，和「Nyx 正在运行」那道一个道理），
 *   而且 `--dry-run` 也要报这一句 —— dry 正是装机前用来「看一眼」的那一步，
 *   在那里闭嘴，就等于在唯一有人会看的时候不说话。
 */
for (const f of KEEP) {
  const stray = join(src, f)
  if (!existsSync(stray)) continue
  console.error(
    `\n✖ 停下：打包产物里有 ${f}/ —— 它会被拷进你的数据目录，同名文件（含 nyx.db）直接覆盖。\n\n` +
      `    包里的　${stray}\n` +
      `    会盖住　${join(dest, f)}\n\n` +
      `  多半是 smoke:packaged 中途挂了（Ctrl-C / 被杀掉 / 断言死在收尾之前）留下的：\n` +
      `  那一套要真起一次打包后的 exe，而 D-263 让它把库写在软件文件夹里，正常跑完才收拾掉。\n\n` +
      `  先把它删掉再装（确认里面只是验收跑出来的空库，不是谁的真数据）：\n` +
      `    Remove-Item -Recurse -Force "${stray}"\n` +
      `  ★ 这道闸不受 --force 影响 —— 包里本来就不该有它，没有「照装」这一档。`
  )
  process.exit(1)
}

/**
 * 上一版留下的、已经搬进 data/ 的旧目录：删掉是对的，但要说一声。
 *
 * `prompts` **不在这里面**：I-113 之后根目录那份是**出厂种子**，
 * 每次升级都要带着新的一份过来（他那份在 data/prompts，靠指纹判断要不要更新）。
 * 写进这个名单会让人以为它是残留 —— 而它是必需的。
 */
const MIGRATED = ['dicts']

/**
 * **这个脚本自己写出来的东西。**
 *
 * `BUILD.txt` 是上一次安装盖的构建号纸条（`npm run installed` 靠它比对）。
 * 它不在打包产物里、也不是使用者放的 —— 忘了登记的后果是：
 * 下一次安装被自己上一次的产物拦住，说「有名单之外的东西，可能是你自己放的」。
 * 第一次装完就撞上了。
 *
 * 判据：**凡是这个脚本会写进程序目录的文件，都要登记在这里。**
 */
const OURS = ['BUILD.txt']

const shipped = new Set(readdirSync(src))
const before = existsSync(dest) ? readdirSync(dest) : []

/**
 * 名单之外、又不是这次要装的东西 —— 有可能是他自己放的。
 * 宁可停下来问，也不要再删错一次。
 */
const unknown = before.filter(
  (f) => !KEEP.includes(f) && !MIGRATED.includes(f) && !OURS.includes(f) && !shipped.has(f)
)

console.log(`来源：${src}`)
console.log(`目标：${dest}`)
console.log(`\n保留：${KEEP.join('、')}（你的数据、词典、改过的提示词都在里面）`)

const stale = before.filter((f) => MIGRATED.includes(f))
if (stale.length) {
  console.log(`\n旧位置的 ${stale.join('、')} 会被删掉 —— 启动时已经搬进 data/ 了。`)
  for (const f of stale) {
    const inData = join(dest, 'data', f)
    if (!existsSync(inData)) {
      console.error(
        `\n✖ 停下：${f}/ 还没搬进 data/（${inData} 不存在）。\n` +
          `  先把新版本跑起来一次让它自动搬，或者手动搬过去，再来装。`
      )
      process.exit(1)
    }
  }
}

if (unknown.length && !force) {
  console.error(
    `\n✖ 停下：程序目录里有名单之外的东西，可能是你自己放的 ——\n` +
      unknown.map((f) => `    ${f}`).join('\n') +
      `\n\n  确认可以删就加 --force，或者先把它们移走。`
  )
  process.exit(1)
}

/**
 * ★ 软件正在跑就不能装。
 *
 * 第一次跑这个脚本时它正开着：删到 `d3dcompiler_47.dll` 撞上 EPERM 停下，
 * 而前面两个 .pak **已经删掉了** —— 程序目录停在一个装不完、也跑不起来的半截状态。
 * 删除是不可逆的，所以这道闸必须在**动手之前**，不能指望出错之后回滚。
 */
if (process.platform === 'win32') {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Nyx.exe', '/NH'], {
    encoding: 'utf8'
  })
  if (/Nyx\.exe/i.test(out)) {
    console.error(
      `\n✖ Nyx 正在运行 —— 先把它关掉再装。\n` +
        `  （文件被占用时会删到一半停下，程序目录卡在装不完的状态。）`
    )
    process.exit(1)
  }
}

if (dry) {
  console.log(`\n--dry-run：会删掉 ${before.length - KEEP.length} 个条目，再拷 ${shipped.size} 个进来。`)
  process.exit(0)
}

// ── 清程序文件（data/ 不碰）──────────────────────────────────
mkdirSync(dest, { recursive: true })
for (const f of readdirSync(dest)) {
  if (KEEP.includes(f)) continue
  rmSync(join(dest, f), { recursive: true, force: true })
}

// ── 拷新版本 ────────────────────────────────────────────────
// 不用 fs.cpSync：整棵 win-unpacked（含 200MB 的 exe）会让进程直接挂掉，
// 而且不抛异常、退出码 127 —— 看起来像成功。逐个条目拷就没事。
for (const f of readdirSync(src)) {
  // ★ 和删除循环共用同一份 KEEP（I-194）。上面那道闸已经拦在前面了，这里是兜底：
  //   两个循环各写各的判据，正是当初「删除让开了、拷贝没让开」的由来。
  if (KEEP.includes(f)) continue
  cpSync(join(src, f), join(dest, f), { recursive: true, force: true })
}

/**
 * 刻一个号：这一份是从哪个提交打的。
 *
 * 来历见 `scripts/build-info.mjs` —— 我说「拖拽修好了」、他说「不行」，
 * 两句都对，因为他手上是旧包。`npm run installed` 靠这张纸条给答案。
 */
const infoPath = join(root, 'src', 'main', 'build-info.json')
if (existsSync(infoPath)) {
  writeFileSync(join(dest, 'BUILD.txt'), readFileSync(infoPath, 'utf8'), 'utf8')
}

// ── 装完核对 ────────────────────────────────────────────────
const after = readdirSync(dest)
if (!after.includes('data')) {
  console.error(`\n✖ data/ 不见了 —— 这不该发生，立刻停下来查`)
  process.exit(1)
}
const dicts = join(dest, 'data', 'dicts')
const n = existsSync(dicts) ? readdirSync(dicts).length : 0
console.log(`\n✔ 装好了。`)
console.log(`  data/ 还在 · 词典 ${n} 项 · 提示词 ${
  existsSync(join(dest, 'data', 'prompts')) ? '在 data/prompts' : '首次启动时会放进 data/prompts'
}`)
