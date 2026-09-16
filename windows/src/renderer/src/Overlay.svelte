<script lang="ts">
  /**
   * 浮窗里的那一页 —— 盖在**别的程序**上面的查词卡（使用者 2026-09-13）
   *
   * ══ 它和应用内那张卡是同一个组件 ═══════════════════════════════
   * 使用者原话：「不要再让『查字典』和其他查词能力成为彼此割裂的功能。」
   * 所以这里**不另写一张卡**，就是 `DictCard` —— 换的只是它住在哪个窗口里：
   *   · 应用内右键「查词」 → 画在主窗口里（`Capture.svelte`）
   *   · Glance / Frame     → 画在这个置顶浮窗里（他正看着别的程序）
   * 内容、词典、发音、换书**完全同一份代码**。
   *
   * ══ 这一页为什么这么空 ═════════════════════════════════════════
   * 窗口本身是 `transparent`，所以这一页**不画任何底色**：
   * 卡自己有面和影，卡以外的地方必须是真透明的 ——
   * 给 body 上个底色的话，他会看到一个方方正正的灰块浮在网页上。
   */
  import DictCard from './DictCard.svelte'
  import Sprite from './Sprite.svelte'

  let word = $state<string | null>(null)
  /**
   * 收下的东西进哪一讲 —— 从 Settings → Assist 那一项来（使用者选的「甲」）。
   * ★ 浮窗是在**别的程序**上弹出来的，这里没有「当前这一讲」可用，
   *   所以只能靠那个设好的默认目标（契约 §五：零配置，不问保存到哪）。
   */
  let lectureId = $state<number | null>(null)
  window.nyx.glance
    .get()
    .then((a) => (lectureId = a.lecture))
    .catch(() => {
      /* 读不出来就没有那颗「收下」，卡上会说去哪儿设 —— 不拦查词 */
    })
  /**
   * ★★ 这串字是**认出来的**吗（I-177，2026-09-14 复活）。
   *
   * 这一栏当天下午刚删过，那一版的理由是：Frame 取消之后 Windows 上没有
   * 任何一条路是「认出来」的，卡上那句话没有主语。**当时是对的。**
   * 现在主语回来了 —— 真原神那类自绘界面里 UIA 一个字都拿不到，
   * 只剩认的这一条。D-395 一个字没改过，所以那句话也一个字没改。
   */
  let ocr = $state(false)
  /**
   * ★★ 这一下什么都没读到（I-177）。
   *   他报的「Point 点不了原神的词」在代码里的样子就是**屏上什么都不发生** ——
   *   功能没坏，是**坏了不说**。所以这一档必须有张卡。
   */
  let empty = $state(false)
  /**
   * ★★ 卡上那一句**由判据给，不写死在这儿**。
   *   写死「这里没读到文字」的话，在黑名单程序里那一下就成了假话 ——
   *   字读到了，是我们不给。他会一直换地方拖，永远不知道那个程序被自己拉黑了。
   */
  let note = $state('')
  let hint = $state('')
  $effect(() =>
    window.nyx.overlay.onLookup((t, isOcr, isEmpty, n, h) => {
      word = t
      ocr = isOcr
      empty = isEmpty
      note = n
      hint = h
    })
  )

  function close(): void {
    word = null
    empty = false
    window.nyx.overlay.close()
  }
</script>

<!--
  ★ 位置写死在左上角：**窗口本身**已经被主进程摆到鼠标旁边了
    （`main/overlay.ts` 按 `screen.getDisplayNearestPoint` 夹过边界）。
    这里再算一次位置就是两份判据，而且那一份看不见屏幕。
-->
<!--
  ★★★ **这一页必须自己挂 `Sprite`**（2026-09-14 抓到）。
    `Sprite` 原来只挂在 `App.svelte` 顶层，而这一页**不是它的子树** ——
    于是这张卡上每一个 `<Ic>` 都渲染成一个空的 `<use href="#nyx-…">`：
    关闭那个 ✕、词典选择器的 ⌄、当前那本前面的 ✓，**全是隐形的**。
    ★ 它不报错、不留痕迹，只是什么都不画 —— 我先前在截图里还以为是对比度问题。
-->
<Sprite />

{#if empty}
  <!--
    ★★ 什么都没读到的那一张（I-177）。
      这张卡存在的全部理由：他拖了一下，**必须有东西回应他**。
      在这之前这条路是哑的 —— 助手报了一行、认不出来就丢掉，屏上一片安静，
      于是「Nyx 坏了」和「这儿确实没字」在他眼里长得一模一样。
    ★ 不给 `DictCard`：没有词就没什么可查的，硬塞一张空的查词卡更糟。
  -->
  <div class="ovnone" data-testid="overlay-none">
    <p class="ovnone-t">{note || '这里没读到文字'}</p>
    {#if hint}
      <p class="ovnone-s">{hint}</p>
    {/if}
    <button type="button" class="ovnone-x" onclick={close}>知道了</button>
  </div>
{:else if word}
  <!--
    ★★★ 这一层是**必须**的（2026-09-14 截图抓到的，不是设计出来的）。
      `.dcw.fill` 是 `position:absolute; inset:0` —— 它铺满整个浮窗。
      标记本来写在它前面、走正常流，于是**整条被卡盖住**：
      DOM 里在、用例数得到、屏幕上一个像素都看不见。
      ☞ 用例数得到 ≠ 他看得见。这一版的用例因此改成量两个盒子**重不重叠**。
    ★ 标记和卡之间不留缝：缝是透明的，但照样吃鼠标 —— 他点那儿
      会把卡关掉，而他以为自己点的是底下那个程序（同 `overlay.test.ts` ③）。
  -->
  <div class="ovwrap">
  {#if ocr}
    <!--
      ★ D-395 写死的：OCR「永远只是兜底，禁止升格为主方案，**结果带『可能有误』标记**」。
        实测这台机器上 `Prompts` 认成 `Prom pts`、`Practice` 认成 `Practlce` ——
        不标的话他会以为是 Nyx 查错了词，而真相是根本没认对。
      ★ 放在卡**上面**不放卡里：这句话说的是「这串字怎么来的」，
        不是词典查出来的内容，混进卡里会让人以为是释义的一部分。
    -->
    <div class="ovocr" data-testid="overlay-ocr">
      这几个字是<b>认出来的</b>，可能有误：「{word}」
    </div>
  {/if}
  <!-- ★ `outside` —— 这张是在别的程序上面弹的：下面那段 AI 点了才跑（省他的钱）-->
  <DictCard {word} at={{ x: 0, y: 0 }} onclose={close} {lectureId} outside />
  </div>
{/if}
