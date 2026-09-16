/**
 * Nyx 品牌图标资源生成 —— **从使用者给的那一张 Master Icon 出发，只做尺寸 / 裁切 / 留白 / 格式**
 * 2026-09-07（使用者：「以我提供的这张图片为唯一视觉标准，不要重新设计」）
 *
 * ── 它做什么 ─────────────────────────────────────────────
 *   输入  assets/brand/source/master-source-bunny-2026-09-14.png（使用者给的原图，只读，不改）
 *         旧那张水獭 master-source-otter-2026-09-07.png 改名留档，没删
 *   输出  assets/brand/master/icon-master-1024.png      规范正方形 Master
 *         assets/brand/windows/icon-{16,24,32,48,256}.png + nyx.ico
 *         assets/brand/android/ic_launcher_{foreground,background,monochrome}-{密度}.png
 *
 * ── 三条不能违反的 ────────────────────────────────────────
 * ① **不重画**：所有输出都是同一张原图的缩放 / 裁切 / 补边，不改造型、比例、线条、颜色。
 * ② **Android 前景不能带瓷砖**：自适应图标由系统再套一层遮罩，原图那圈圆角白瓷砖会被**二次遮罩**
 *    （圆角套圆角 = 边上一圈脏白）。所以前景层要把水獭从瓷砖里抠出来，底色交给 background 层。
 * ③ **安全区**：Android 前景画布 108dp，系统只保证中间 72dp 可见（外圈随厂商遮罩裁掉）。
 *    主体按 72dp 摆，不是按 108dp 摆。
 *
 * ── 怎么抠 ───────────────────────────────────────────────
 * 不能按「亮度阈值」抠 —— 这只水獭的脸和胸口本来就是近白色，和瓷砖底一个亮度。
 * 所以走**从瓷砖四边向内的洪水填充**：连通到边缘的近白 = 底；填不到的 = 主体（脸再白也保得住）。
 *
 * 用法：node scripts/gen-brand-icons.mjs
 *      （不在构建链里。原图换了才需要重跑，产物提交进仓库。）
 */
import { _electron as electron } from 'playwright-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mainWindow } from '../tests/win.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRAND = join(ROOT, 'assets', 'brand')
/**
 * ★★ 2026-09-14 · 原图换成使用者给的兔子（使用者原话 `docs/指令-2026-09-14-图标换成兔子.md`）。
 *   旧那张水獭改名留档在 `master-source-otter-2026-09-07.png`，**没删**（D-216 精神）。
 *   要重出水獭那一套的话，把 `SRC` 指回去即可 —— 下面的流程两种原图都认（见 `TRANSPARENT` 那段）。
 */
const SRC = join(BRAND, 'source', 'master-source-bunny-2026-09-14.png')

const WIN_SIZES = [16, 24, 32, 48, 256]
// 108dp 画布在五档密度下的像素边长（mdpi=1x）
const DENSITIES = [['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]]

for (const d of ['master', 'windows', 'android']) mkdirSync(join(BRAND, d), { recursive: true })

const dataUrl = 'data:image/png;base64,' + readFileSync(SRC).toString('base64')

const app = await electron.launch({ args: ['.'], cwd: ROOT, env: { ...process.env, NYX_DATA_ROOT: join(ROOT, '.brandtmp') } })
/**
 * ★ 拿主窗走 `tests/win.ts` 那一份判据（B-9，2026-09-14）——
 *   以前这里是 `app.firstWindow()`，它认的是「谁先开」，跟「谁是主窗」无关；
 *   悬浮球开着的库上它拿到的是那颗 46px 的球（I-157 / I-179）。
 */
const page = await mainWindow(app)
await page.waitForLoadState('domcontentloaded')

const out = await page.evaluate(async (src) => {
  const img = new Image()
  img.src = src
  await img.decode()
  const W = img.naturalWidth, H = img.naturalHeight

  const cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
  const ctx0 = cv(W, H).getContext('2d', { willReadFrequently: true })
  ctx0.drawImage(img, 0, 0)
  const px = ctx0.getImageData(0, 0, W, H)
  const D = px.data
  const at = (x, y) => (y * W + x) * 4
  const lum = (i) => (0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2]) / 255

  /* ① 两段洪水填充 —— 一段不够（第一版就死在这里）。
     第一段从**图的四边**灌，只认几乎纯白（>0.985）：它只能洗掉瓷砖外面那圈白边，
     会被瓷砖的淡灰边与投影挡住 —— 正好用它量出瓷砖框。
     第二段从**瓷砖内侧一圈**灌，宽一点（>0.86）：洗掉瓷砖里的白底，
     而水獭的白脸因为被蓝轮廓围着、灌不进去，保得住。 */
  const bg = new Uint8Array(W * H)
  const flood = (seeds, keep) => {
    const stack = seeds.slice()
    while (stack.length) {
      const y = stack.pop(), x = stack.pop()
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const p = y * W + x
      if (bg[p]) continue
      const i = at(x, y)
      if (!(D[i + 3] < 24 || keep(i))) continue
      bg[p] = 1
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1)
    }
  }

  const edge = []
  for (let x = 0; x < W; x++) edge.push(x, 0, x, H - 1)
  for (let y = 0; y < H; y++) edge.push(0, y, W - 1, y)
  flood(edge, (i) => lum(i) > 0.985)

  /**
   * ★★★ **这张原图有没有「白瓷砖」—— 两种原图走两条路**（2026-09-14 换兔子时加的）
   *
   * 上面那套抠底是给 2026-09-07 那只水獭写的：它是**整幅不透明**，主体坐在一块
   * 白色圆角瓷砖上，所以要先量出瓷砖框、再从瓷砖内侧灌第二段把白底洗掉。
   *
   * 兔子这张**完全是另一回事**（实测：1254×1254，**64.1% 的像素 alpha=0**，四角全是
   * `rgba=0,0,0,0`）—— 它本来就是透明底，没有瓷砖。
   * 如果照搬水獭那条路，第二段会从**兔子自己的包围盒内侧 3%** 开始灌白，
   * 而**这只兔子 63.2% 的不透明像素亮度 > 0.86**（它整只就是白的）——
   * 灌下去会把耳朵内侧、脸、眨眼那一侧的白**连成一片吃掉**，只剩一圈深蓝描边。
   * ☞ 所以判据不是「哪张图」，是**这张图有没有大片透明**：
   *   有 → 底本来就是透的，第一段已经够了，**不跑第二段**；
   *   没有 → 走原来那条瓷砖路。
   */
  let clear = 0
  for (let i = 3; i < D.length; i += 4) if (D[i] < 24) clear++
  const TRANSPARENT = clear > 0.02 * W * H

  /* ② 瓷砖框 = 没被第一段洗到的那块 */
  let tx0 = W, ty0 = H, tx1 = -1, ty1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (bg[y * W + x]) continue
    if (D[at(x, y) + 3] < 24) continue
    if (x < tx0) tx0 = x; if (x > tx1) tx1 = x
    if (y < ty0) ty0 = y; if (y > ty1) ty1 = y
  }

  /* ③ 第二段：从瓷砖内侧 3% 那一圈开始灌 —— **只有瓷砖那种原图才跑**（见上面 TRANSPARENT） */
  const inset = Math.round(Math.min(tx1 - tx0, ty1 - ty0) * 0.03)
  if (!TRANSPARENT) {
    const seeds = []
    for (let x = tx0 + inset; x <= tx1 - inset; x++) { seeds.push(x, ty0 + inset); seeds.push(x, ty1 - inset) }
    for (let y = ty0 + inset; y <= ty1 - inset; y++) { seeds.push(tx0 + inset, y); seeds.push(tx1 - inset, y) }
    flood(seeds, (i) => lum(i) > 0.86)
  }

  /* ④ 主体 = **最大连通块**，不是「所有非底像素」。
     第二版死在这里：瓷砖自己那圈抗锯齿的淡灰边也不是「底」，
     于是主体框被那圈细环擑成了整块瓷砖（主体框 == 瓷砖框）。
     环的面积小、水獭的面积大 —— 取最大块就干净了，
     而且顺手把那圈环从前景图里也除掉了（否则它会跟着进 Android 前景）。 */
  const comp = new Int32Array(W * H).fill(-1)
  /** 每一块的大小与包围盒 —— 下面要按大小筛，不是只留最大那一块 */
  const parts = []
  let best = -1, bestN = 0, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0, id = 0
  for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
    const sp0 = sy * W + sx
    if (bg[sp0] || comp[sp0] !== -1 || D[at(sx, sy) + 3] < 24) continue
    const st = [sx, sy]
    let n = 0, ax0 = W, ay0 = H, ax1 = -1, ay1 = -1
    comp[sp0] = id
    while (st.length) {
      const y = st.pop(), x = st.pop()
      const p = y * W + x
      n++
      if (x < ax0) ax0 = x; if (x > ax1) ax1 = x
      if (y < ay0) ay0 = y; if (y > ay1) ay1 = y
      const nb = [x + 1, y, x - 1, y, x, y + 1, x, y - 1]
      for (let k = 0; k < 8; k += 2) {
        const nx = nb[k], ny = nb[k + 1]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const np = ny * W + nx
        if (bg[np] || comp[np] !== -1 || D[at(nx, ny) + 3] < 24) continue
        comp[np] = id
        st.push(nx, ny)
      }
    }
    parts.push({ id, n, box: [ax0, ay0, ax1, ay1] })
    if (n > bestN) { bestN = n; best = id; bx0 = ax0; by0 = ay0; bx1 = ax1; by1 = ay1 }
    id++
  }

  /**
   * ★★★ **不能只留最大那一块** —— 2026-09-14 换兔子时这里差点吃掉两颗星光。
   *
   * 水獭那一版写的是「主体 = 最大连通块，其余并回底」，理由是瓷砖自己那圈抗锯齿的
   * 淡灰细环会把主体框撑成整块瓷砖。那个理由**对瓷砖原图成立**。
   * 但兔子这张的左边有**两颗独立的星光**（实测 4590 px 与 1234 px，
   * 而兔子本体 559183 px）——它们和本体不连通，"只留最大块"会把它们**整个删掉**，
   * 而派单写明「星光两颗是原图的一部分，保留」。
   *
   * 所以改成**按大小筛**：太小的（抗锯齿噪点，实测就是 1 px 和 2 px 各一处）并回底，
   * 够大的都留。阈值取 32 px —— 比噪点大一个量级、比小星光（1234 px）小两个量级，
   * 中间空得很开，不是卡着边缘挑出来的数。
   */
  const KEEP_MIN = 32
  const keep = new Set(parts.filter((p) => p.n >= KEEP_MIN).map((p) => p.id))
  for (let i = 0; i < W * H; i++) if (!keep.has(comp[i])) bg[i] = 1

  /** 主体框 = **留下来的所有块**的并集（星光在兔子左边，框要把它们圈进去）*/
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (const p of parts) {
    if (!keep.has(p.id)) continue
    if (p.box[0] < x0) x0 = p.box[0]
    if (p.box[1] < y0) y0 = p.box[1]
    if (p.box[2] > x1) x1 = p.box[2]
    if (p.box[3] > y1) y1 = p.box[3]
  }
  void best; void bx0; void by0; void bx1; void by1

  const png = (c) => c.toDataURL('image/png')

  /* ④ Master：把瓷砖裁出来，放进正方形画布，四周留 4% —— 原图那圈白边太宽，
        任务栏上会让图标显得比别人小一号。裁的是留白，不是图。 */
  const tW = tx1 - tx0 + 1, tH = ty1 - ty0 + 1
  const tSide = Math.max(tW, tH)
  const master = cv(1024, 1024)
  const mc = master.getContext('2d')
  mc.imageSmoothingQuality = 'high'
  const pad = Math.round(1024 * 0.04)
  const box = 1024 - pad * 2
  const scale = box / tSide
  mc.drawImage(img, tx0, ty0, tW, tH,
    pad + (box - tW * scale) / 2, pad + (box - tH * scale) / 2, tW * scale, tH * scale)
  const masterUrl = png(master)

  /* ⑤ Windows 各尺寸：从 Master 缩，一步到位（多步缩放会把低多边形的棱糊掉）。 */
  const mimg = new Image(); mimg.src = masterUrl; await mimg.decode()
  const win = {}
  /* ★ 小尺寸要**收紧构图**（光学尺寸）：16px 上一共只有 256 个像素，
     Master 那圈 4% 留白 + 瓷砖内水獭头顶的空白，会把主体压到只剩一半画面 ——
     实测 16 / 24 两档糊成一团蓝影。所以越小裁得越紧。
     裁的是留白，不是图：造型 / 比例 / 颜色一个没动。 */
  /**
   * ★★★ **这张表只对「主体外面还有富余留白」的原图成立** —— 2026-09-14 换兔子时实测到的。
   *
   * 水獭那张的 Master 里，主体外面除了 4% 补边，还有**瓷砖内部**那一圈空白
   * （水獭头顶离瓷砖上沿很远），所以 16 档裁掉 10% 只是把空白收紧，好看。
   * 兔子这张是透明底，Master 里主体外面**只有那 4% 补边** ——
   * 同一张表照搬下去，16 / 24 / 32 / 48 四档**四条边全部贴边**（实测：
   * 16 档上 8 下 11 左 4 右 7 个像素顶在边上），也就是**耳尖和下巴被切掉了**，
   * 而派单写的是「只缩放不裁耳」。
   * ☞ 所以：**有富余才收紧，没富余就只缩放**。判据就是上面那个 `TRANSPARENT`——
   *   透明底的原图，主体框就是内容框，Master 里除了补边没有别的空白可裁。
   */
  const INSET = TRANSPARENT
    ? { 16: 0, 24: 0, 32: 0, 48: 0, 256: 0 }
    : { 16: 0.10, 24: 0.09, 32: 0.07, 48: 0.04, 256: 0 }
  for (const s of [16, 24, 32, 48, 256]) {
    const c = cv(s, s); const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    const t = 1024 * INSET[s]
    g.drawImage(mimg, t, t, 1024 - t * 2, 1024 - t * 2, 0, 0, s, s)
    win[s] = png(c)
  }

  /* ⑥ Android 前景：只要主体，按 72dp 安全区摆（108dp 画布的中间 2/3）。 */
  const sW = x1 - x0 + 1, sH = y1 - y0 + 1
  const subj = cv(sW, sH)
  const sc = subj.getContext('2d')
  sc.drawImage(img, x0, y0, sW, sH, 0, 0, sW, sH)
  // 抠掉底：洪水填充标记过的像素一律透明
  const sp = sc.getImageData(0, 0, sW, sH)
  for (let y = 0; y < sH; y++) for (let x = 0; x < sW; x++) {
    if (bg[(y + y0) * W + (x + x0)]) sp.data[(y * sW + x) * 4 + 3] = 0
  }
  sc.putImageData(sp, 0, 0)
  const subjUrl = png(subj)
  const simg = new Image(); simg.src = subjUrl; await simg.decode()

  const fg = (side) => {
    const c = cv(side, side); const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    const safe = side * (72 / 108) * 0.94        // 安全区再收一点，别顶到圆形遮罩的边
    const k = Math.min(safe / sW, safe / sH)
    /**
     * ★★ **贴地还是居中，看这张图有没有「地面」**（2026-09-14 换兔子时分的两条路）
     *
     * 水獭那一版写死了贴地，理由是「原图里水獭的身子本来就顶着瓷砖下沿，抠出来底是平的，
     * 再摆到正中会像悬空的一块」—— 那个理由**对那张图成立**。
     * 兔子是**一颗浮着的头**，没有平底也没有地面。照旧贴地的实测后果是：
     * 可见区里上边留 17 px、下边只留 **1 px**（xxxhdpi，可见区 288 px）——
     * 三种标准遮罩都还没切到下巴，但**任何比它们再狠一点的厂商遮罩都会切**，
     * 而且那一点余量是白占的：上边空着 17 px。
     * ☞ 所以：**有平底的贴地，没平底的居中**。判据仍是上面那个 `TRANSPARENT`。
     */
    const floor = (side + side * (72 / 108)) / 2
    const dy = TRANSPARENT ? (side - sH * k) / 2 : floor - sH * k
    g.drawImage(simg, (side - sW * k) / 2, dy, sW * k, sH * k)
    return png(c)
  }

  /* ⑦ Android 背景：取原图瓷砖内部的底色（不是我挑的颜色，是从图里量的）。 */
  // 不能随手取一点（第一版取到了水獭头上，量出 #4484c9）——
  // 改成量**瓷砖内部被判为底的那些像素的均值**。
  /**
   * ★★★ **透明底那种原图不要量** —— 2026-09-14 第一次跑兔子时量出了 `#5e5eb3`（一片紫蓝）。
   *
   * 为什么会量成紫的：这张图**没有底色**，底是透明的。而这个循环收的是
   * 「框内被判为底、且 alpha ≥ 24 的像素」——透明的那些 alpha=0 被跳过了，
   * **剩下的正好是兔子描边外那一圈抗锯齿的半透明深蓝**。
   * 把那一圈平均一下，当然是紫蓝色。
   * ☞ 它不是「从图里量出来的底色」，是**边缘羽化的产物**。
   *   一个看起来很像数据的数字，量的却不是要的那件事。
   *   这张图**根本没有底色可量**，所以直接用判据定的 `#fafafa`（U-007）。
   */
  let ar = 0, ag = 0, ab = 0, an = 0
  if (!TRANSPARENT) {
    for (let y = ty0 + inset; y <= ty1 - inset; y += 2) for (let x = tx0 + inset; x <= tx1 - inset; x += 2) {
      if (!bg[y * W + x]) continue
      const i = at(x, y)
      if (D[i + 3] < 24) continue
      ar += D[i]; ag += D[i + 1]; ab += D[i + 2]; an++
    }
  }
  /**
   * ★ 量不出来时用 `#fafafa`，不是 `#ffffff`（2026-09-14）。
   *   兔子这张是透明底 —— 「瓷砖内部被判为底的像素」一个都没有（它们 alpha=0，上面跳过了），
   *   于是 `an === 0`。这时候**没有可量的东西**，就该回到判据定的那个值：
   *   U-007 使用者定的背景层是 `#fafafa`。原来兜底写的 `#ffffff` 是随手写的白，
   *   和判据差一档，而且差在「谁定的」这件事上。
   */
  const hex = an ? '#' + [ar / an, ag / an, ab / an].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') : '#fafafa'
  const bgLayer = (side) => {
    const c = cv(side, side); const g = c.getContext('2d')
    g.fillStyle = hex; g.fillRect(0, 0, side, side)
    return png(c)
  }

  /* ⑧ Android 单色层：系统会整片染色，所以只留形。
        实心剪影 + 把脸上那几处最深的（眼睛 · 鼻子）挖成洞，否则是一团无脸的疙瘩。 */
  const mono = (side) => {
    const c = cv(side, side); const g = c.getContext('2d')
    const safe = side * (72 / 108) * 0.94
    const k = Math.min(safe / sW, safe / sH)
    /** ★ 摆法必须和 `fg()` 一模一样 —— 单色层和前景层错位的话，系统一染色就看得出来 */
    const floor = (side + side * (72 / 108)) / 2
    const dx = (side - sW * k) / 2
    const dy = TRANSPARENT ? (side - sH * k) / 2 : floor - sH * k
    g.drawImage(simg, dx, dy, sW * k, sH * k)
    const im = g.getImageData(0, 0, side, side)
    const d2 = im.data
    for (let i = 0; i < d2.length; i += 4) {
      if (d2[i + 3] < 40) { d2[i + 3] = 0; continue }
      const L = (0.2126 * d2[i] + 0.7152 * d2[i + 1] + 0.0722 * d2[i + 2]) / 255
      const y = Math.floor((i / 4) / side)
      const faceZone = y < dy + sH * k * 0.58
      if (faceZone && L < 0.34) { d2[i + 3] = 0; continue }   // 眼睛 / 鼻子 → 洞
      d2[i] = 0; d2[i + 1] = 0; d2[i + 2] = 0; d2[i + 3] = 255
    }
    g.putImageData(im, 0, 0)
    return png(c)
  }

  /**
   * ★★★ ⑨ **扁平位图（API 23–25 用的那两张）** · 2026-09-14 追加（Nyx-UI-Android 核出来的）
   *
   * `minSdk = 23`，而自适应图标（前景 / 背景 / 单色三层）**要 API 26 才认**。
   * 23–25 那几档系统读的是 `AndroidManifest` 上 `android:icon` / `roundIcon` 指的
   * **扁平位图** （`mipmap-` 各密度目录下的 `ic_launcher.png` 与 `ic_launcher_round.png`）。
   * ★ 这一句原本写成 `mipmap-*` 加斜杠，而那两个字符正好是**块注释的结束符**：
   *   注释在那里就断了，后半句变成裸代码，脚本直接 SyntaxError。
   *   （`check:css` 那道闸治的就是 CSS 里的同一件事，这回轮到 JS。）
   * 不出这两张的话，**旧机器上仍然是水獭**，而手上这台 Android 13 走自适应那条路，
   * **看不出来** —— 又是一个「屏上没变化所以以为没事」。
   *
   * 尺寸：48dp × 密度（mdpi 48 … xxxhdpi 192），不是 108dp 那一套。
   * 底色用背景层同一个 `hex`（量不出来就是 U-007 的 `#fafafa`），主体居中留一点边；
   * 圆版就是同一张再套个圆遮罩 —— 系统不会再给它们套遮罩，所以圆得自己套。
   */
  const flat = (side, round) => {
    const c = cv(side, side)
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    if (round) {
      g.beginPath()
      g.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2)
      g.closePath()
      g.clip()
    }
    g.fillStyle = hex
    g.fillRect(0, 0, side, side)
    /** 主体占 86% —— 扁平图标没有安全区那一说，但顶着边会被启动器的圆角切到 */
    const box = side * 0.86
    const k = Math.min(box / sW, box / sH)
    g.drawImage(simg, (side - sW * k) / 2, (side - sH * k) / 2, sW * k, sH * k)
    return png(c)
  }

  const android = {}
  for (const [name, side] of [['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]]) {
    /** 扁平那两张按 48dp×密度：108dp 画布边长 × (48/108) 正好是它 */
    const flatSide = Math.round(side * (48 / 108))
    android[name] = {
      fg: fg(side),
      bg: bgLayer(side),
      mono: mono(side),
      flat: flat(flatSide, false),
      flatRound: flat(flatSide, true)
    }
  }

  return {
    meta: {
      W, H,
      transparentPct: +(100 * clear / (W * H)).toFixed(1),
      mode: TRANSPARENT ? '透明底（不跑第二段洪水）' : '白瓷砖（跑第二段洪水）',
      tile: [tx0, ty0, tx1, ty1],
      subject: [x0, y0, x1, y1],
      parts: parts.map((p) => p.n).sort((a, b) => b - a).slice(0, 8),
      kept: parts.filter((p) => keep.has(p.id)).length,
      bgHex: hex,
      bgMeasured: an > 0
    },
    master: masterUrl, win, android
  }
}, dataUrl)

await app.close()

const buf = (u) => Buffer.from(u.split(',')[1], 'base64')
const put = (p, u) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf(u)) }

put(join(BRAND, 'master', 'icon-master-1024.png'), out.master)
for (const s of WIN_SIZES) put(join(BRAND, 'windows', `icon-${s}.png`), out.win[s])
for (const [name] of DENSITIES) {
  put(join(BRAND, 'android', `ic_launcher_foreground-${name}.png`), out.android[name].fg)
  put(join(BRAND, 'android', `ic_launcher_background-${name}.png`), out.android[name].bg)
  put(join(BRAND, 'android', `ic_launcher_monochrome-${name}.png`), out.android[name].mono)
  /** ★ API 23–25 读的那两张扁平位图（见上面 ⑨） */
  put(join(BRAND, 'android', `ic_launcher-${name}.png`), out.android[name].flat)
  put(join(BRAND, 'android', `ic_launcher_round-${name}.png`), out.android[name].flatRound)
}

/* ── ICO 打包 ────────────────────────────────────────────────
   ICO = 6 字节头 + 每张 16 字节目录项 + 各张 PNG 原样。
   Vista 以后 Windows 直接认 PNG 条目，不必转 BMP。 */
const entries = WIN_SIZES.map((s) => ({ s, data: buf(out.win[s]) }))
const head = Buffer.alloc(6)
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4)
const dir = Buffer.alloc(16 * entries.length)
let offset = 6 + 16 * entries.length
entries.forEach((e, i) => {
  const o = i * 16
  dir[o] = e.s >= 256 ? 0 : e.s
  dir[o + 1] = e.s >= 256 ? 0 : e.s
  dir[o + 2] = 0; dir[o + 3] = 0
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6)
  dir.writeUInt32LE(e.data.length, o + 8); dir.writeUInt32LE(offset, o + 12)
  offset += e.data.length
})
writeFileSync(join(BRAND, 'windows', 'nyx.ico'), Buffer.concat([head, dir, ...entries.map((e) => e.data)]))

console.log('原图', out.meta.W + '×' + out.meta.H, '· 透明', out.meta.transparentPct + '%', '·', out.meta.mode)
console.log('外框', out.meta.tile.join(','), '主体框', out.meta.subject.join(','))
console.log('连通块（大到小）', out.meta.parts.join(' '), '→ 留下', out.meta.kept, '块')
console.log('背景色', out.meta.bgHex, out.meta.bgMeasured ? '（从图里量的）' : '（图里量不出来 → U-007 定的 #fafafa）')
console.log(
  '✓ 写出 master 1 · windows ' + (WIN_SIZES.length + 1) +
  ' · android ' + DENSITIES.length * 5 + '（三层 ' + DENSITIES.length * 3 + ' + 扁平 ' + DENSITIES.length * 2 + '）'
)
