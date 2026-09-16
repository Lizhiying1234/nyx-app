#!/usr/bin/env node
// 在**真机页面里**执行 JS，把结果打回来。
//
// 为什么存在：第③档验收要看真机（CLAUDE.md §9.1），可真机上 console.log 用不了 ——
// logcat 被系统限流（`LOGS OVER PROC QUOTA`），而关掉限流的代价是
// `loggingBehavior:"none"` 把 console 一起关掉。
//
// ★ 更要紧的一条：**截图会看岔。** 2026-08-25 在缩略图上「看见」顶部多了一条 Tab 栏，
//   查半天才发现那是系统状态栏图标；同一天又差点把浏览器自己的底部工具栏
//   当成判分行的布局 bug。**眼睛在缩放过的图上不可靠，得让页面自己报数。**
//
// README 从 2026-08-25 起就写着这个用法，但脚本一直没提交 ——
// 「README 承诺了不存在的东西」本身就是个教训。2026-08-26 补上。
//
//   node tools/device/eval.mjs <ws://…> "<表达式>"
//   node tools/device/eval.mjs --pick "<表达式>"     ← 自己去 9222 找唯一那个页面
//
// 怎么把端口转过来（README 里也有）：
//   adb forward tcp:9222 localabstract:chrome_devtools_remote   ← 浏览器
//   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>  ← Nyx 自己
//
// ★ 表达式在页面里跑，返回值走 JSON 序列化。要复杂结果就自己 `JSON.stringify(...)`。
// ★ 顶层 `await` 可以直接写（I-146）：这里会自动裹成 `(async()=>( … ))()`。
//   判据一句话：有 await 且没有 async → 裹；两个都有 → 你自己已经裹了，不动。
//   要跑多条语句仍需自己写 `(async()=>{ … })()`。`NYX_EVAL_SHOW=1` 看最终那一串。

const args = process.argv.slice(2);
const pick = args[0] === '--pick';
const expr = pick ? args[1] : args[1];
const wsArg = pick ? null : args[0];

if (!expr) {
  console.error('用法: node tools/device/eval.mjs <ws://…|--pick> "<表达式>"');
  process.exit(2);
}

/**
 * 顶层 `await` 自动裹一层 async IIFE（I-146）。
 *
 * 为什么要有：`Runtime.evaluate` **不给 async 上下文** —— DevTools 控制台会替你
 * 裹，CDP 不会。于是 `nyx.db.k === 'ok' ? String((await …).x) : '…'` 这种表达式
 * 在控制台里好好的，走到这里就抛 `SyntaxError`（`await` 被当成标识符解析）。
 * `awaitPromise:true` 只 await **结果**，救不了表达式**内部**的 await。
 *
 * 这个坑的代价是量出来的：`accept.sh` 有 10 条断言踩了它（核心断言当场炸），
 * 而全脚本只有一处（`:137`）恰好包对了；2026-09-06 的真机批里我自己手写探测
 * 表达式又连踩三次。所以修在这里 —— 一处修，所有调用方受益。
 *
 * 判据只有一句，好解释也好预测：
 *   · 有 `await`、**没有** `async` → 作者写的是裸顶层 await → 裹
 *   · 两个都有 → 作者自己已经写了 async 函数 → **不动**
 *   · 没有 `await` → 不动
 * 裹的是**表达式**形式 `(async()=>( … ))()`，所以只对表达式成立；
 * 要跑多条语句的，本来就得自己写 `(async()=>{ … })()`，那正好落进「不动」那一支。
 *
 * `NYX_EVAL_SHOW=1` 打印最终真正发过去的那一串（排查用）。
 */
function wrapTopLevelAwait(src) {
  if (!/\bawait\b/.test(src)) return src;
  if (/\basync\b/.test(src)) return src;
  return '(async()=>(' + src + '))()';
}

const finalExpr = wrapTopLevelAwait(expr);
if (process.env.NYX_EVAL_SHOW === '1' && finalExpr !== expr) {
  console.error('[eval] 顶层 await → 已裹 async IIFE：' + finalExpr);
}

/** 去 http://localhost:9222/json 里挑一个真页面 —— 跳过 devtools 自己和空白页 */
async function pickTarget() {
  const r = await fetch('http://localhost:9222/json');
  const list = await r.json();
  const pages = list.filter(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl && !/^devtools:/.test(t.url ?? '')
  );
  if (pages.length === 0) {
    console.error('9222 上没有可调试的页面。先 adb forward，再确认手机上那一页开着。');
    console.error('拿到的是：' + JSON.stringify(list.map((t) => ({ type: t.type, url: t.url }))));
    process.exit(3);
  }
  if (pages.length > 1) {
    console.error('★ 有 ' + pages.length + ' 个页面，挑第一个：');
    for (const p of pages) console.error('   · ' + p.title + '  ' + p.url);
  }
  return pages[0].webSocketDebuggerUrl;
}

const url = wsArg ?? (await pickTarget());

// Node 22+ 自带 WebSocket，不引任何依赖 —— 这个仓库的工具一律零依赖。
const ws = new WebSocket(url);
let id = 0;
const waiting = new Map();

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

ws.addEventListener('message', (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  if (msg.error) w.reject(new Error(msg.error.message));
  else w.resolve(msg.result);
});

ws.addEventListener('error', (e) => {
  console.error('连不上 ' + url + '：' + (e.message ?? e.type));
  process.exit(4);
});

ws.addEventListener('open', async () => {
  try {
    const r = await send('Runtime.evaluate', {
      expression: finalExpr,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      // ★ 报页面里的真实错误，不要只说「失败了」—— 那是这个仓库反复付过学费的失败形态
      console.error('页面里抛了：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      process.exit(5);
    }
    const v = r.result?.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error(String(err));
    process.exit(6);
  }
});
