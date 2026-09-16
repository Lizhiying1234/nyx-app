/**
 * Nyx 图标几何 —— **两端唯一的一份** · D-410（2026-09-01 上提 core）
 *
 * ── 为什么在 core 里，而且是个字符串 ──────────────────────
 *
 * D-410 使用者钦定：**「图标系统两端一起重画」（Android + Windows + Nyx 星）**。
 * 「一起」不能靠纪律 —— 那正是本项目定义的最贵事故形态（同一件事两份判据）：
 * 改了一端不报错，只会让两台机器上的 Nyx 慢慢长得不一样，**而两边都说得通**。
 *
 * 所以几何住在这里，两端各自把它铺成 <svg><defs>：
 *
 *   Nyx-Android  src/ui/lib/Sprite.svelte      ← 经 core-link
 *   Windows      src/renderer/src/Sprite.svelte
 *
 * 是**字符串**而不是结构化数据，因为这一层不做任何判断 ——
 * 它就是那一组 <symbol> 的原文，谁都不许在中间加工。
 * （同 schema/v35.sql 的做法：原文一个字不许在路上改。）
 *
 * ── 改它之前 ─────────────────────────────────────────────
 *
 * 几何是设计判据，归 DS §四（D-326：改值先改 DS）。
 * 三条硬规则（§4.2）：① 空心与实心共用同一条核路径 ② 芒不与核相连
 * ③ 16px 掉芒留核（nyx-star-16）。
 * ★ **小尺寸是另一张图**（D-344 / D-357）—— 加新符号先按 §4.4b 走四档实尺。
 * ★ 星核配给律（§4.4）：星核只出现在「Nyx 自己」和「Nyx 独有的事」上。
 *
 * ★ 手机上有对照表：Settings › ABOUT 连点五下构建指纹（全部符号 × 四档实尺）。
 */

/**
 * 全部图标的 id —— 顺序即 <defs> 里的顺序。
 * ★ **不要在注释里写枚数**：2026-09-02 查出来源码是 34 枚，而三处注释还写着 32、
 *   CLAUDE.md 写着 33 —— 数字一写进散文就会烂。要枚数就数 `NYX_ICON_IDS.length`，
 *   `tests/kit.test.ts` KIT-5 也是这么钉的（动态比对，所以它一直是绿的、也一直没发现这件事）。
 */
export const NYX_ICON_IDS = [
  'nyx-core',
  'nyx-core-o',
  'nyx-star',
  'nyx-star-o',
  'nyx-star-16',
  'nyx-study',
  'nyx-study-o',
  'nyx-lookup',
  'nyx-lookup-o',
  'nyx-vault',
  'nyx-vault-o',
  'nyx-settings',
  'nyx-settings-o',
  'nyx-grade-ok',
  'nyx-grade-near',
  'nyx-grade-again',
  'nyx-grade-again-s',
  'nyx-caret',
  'nyx-back',
  'nyx-close',
  'nyx-plus',
  'nyx-more',
  'nyx-grip',
  'nyx-search',
  'nyx-fix',
  'nyx-speak',
  'nyx-sync',
  'nyx-recollect',
  'nyx-both',
  'nyx-project',
  'nyx-unit',
  'nyx-lecture',
  'nyx-check',
  'nyx-delete'
] as const

export type NyxIconId = (typeof NYX_ICON_IDS)[number]

/**
 * 那 32 个 <symbol> 的原文。两端把它塞进一个 width=0 height=0 的隐藏
 * <svg><defs> 里即可（aria-hidden + focusable=false —— 它不是内容）。
 */
export const NYX_ICON_DEFS = `
<!-- ══ 种子：星核（唯一一条路径，实心与空心共用）══════════════ -->
<symbol id="nyx-core" viewBox="0 0 24 24">
  <path
    d="M12 6.4 Q13.2 10.8 17.6 12 Q13.2 13.2 12 17.6 Q10.8 13.2 6.4 12 Q10.8 10.8 12 6.4 Z"
    fill="currentColor"
  />
</symbol>
<symbol id="nyx-core-o" viewBox="0 0 24 24">
  <path
    d="M12 6.4 Q13.2 10.8 17.6 12 Q13.2 13.2 12 17.6 Q10.8 13.2 6.4 12 Q10.8 10.8 12 6.4 Z"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
  />
</symbol>

<!-- ══ 衍射星 ══
     ON  = 核实心 + 四芒亮起　　OFF = 只有核、空心（§4.3）
     芒与核之间留空 —— 这个间隙不许填上。 -->
<symbol id="nyx-star" viewBox="0 0 24 24">
  <use href="#nyx-core" />
  <g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <path d="M12 2 V4.8" /><path d="M12 19.2 V22" />
    <path d="M2 12 H4.8" /><path d="M19.2 12 H22" />
  </g>
</symbol>
<symbol id="nyx-star-o" viewBox="0 0 24 24"><use href="#nyx-core-o" /></symbol>
<!-- ★ 16px 专用：只画核。小尺寸上四道芒会糊成一团毛边 -->
<symbol id="nyx-star-16" viewBox="0 0 24 24"><use href="#nyx-core" /></symbol>

<!-- ══ 四个 Tab ══════════════════════════════════════════════ -->
<!-- Atlas：一大一小两颗核（继承 D-357 真机定的 1.9:1） -->
<symbol id="nyx-study" viewBox="0 0 24 24">
  <use href="#nyx-core" x="7.2" y="1.4" width="15.4" height="15.4" />
  <use href="#nyx-core" x="1.4" y="11.2" width="8.1" height="8.1" />
</symbol>
<symbol id="nyx-study-o" viewBox="0 0 24 24">
  <use href="#nyx-core-o" x="7.2" y="1.4" width="15.4" height="15.4" />
  <use href="#nyx-core-o" x="1.4" y="11.2" width="8.1" height="8.1" />
</symbol>

<!-- Lookup：镜里含一颗核 —— 查的是 Nyx 自己的词，不是通用搜索 -->
<symbol id="nyx-lookup" viewBox="0 0 24 24">
  <circle cx="10.6" cy="10.6" r="6.4" fill="none" stroke="currentColor" stroke-width="1.6" />
  <path d="M15.3 15.3 L20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  <use href="#nyx-core" x="6.6" y="6.6" width="8" height="8" />
</symbol>
<symbol id="nyx-lookup-o" viewBox="0 0 24 24">
  <circle cx="10.6" cy="10.6" r="6.4" fill="none" stroke="currentColor" stroke-width="1.6" />
  <path d="M15.3 15.3 L20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  <path
    d="M10.6 8.6 Q11.0 10.2 12.6 10.6 Q11.0 11.0 10.6 12.6 Q10.2 11.0 8.6 10.6 Q10.2 10.2 10.6 8.6 Z"
    fill="none" stroke="currentColor" stroke-width="1.1"
  />
</symbol>

<!-- Vault「收藏之匣」（G8 · D-407①）：匣口敞开，一颗核正落进去 -->
<symbol id="nyx-vault" viewBox="0 0 24 24">
  <path d="M4.8 11.2 V17.8 Q4.8 20 7 20 H17 Q19.2 20 19.2 17.8 V11.2"
    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <use href="#nyx-core" x="6.6" y="1.4" width="10.8" height="10.8" />
</symbol>
<symbol id="nyx-vault-o" viewBox="0 0 24 24">
  <path d="M4.8 11.2 V17.8 Q4.8 20 7 20 H17 Q19.2 20 19.2 17.8 V11.2"
    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <path d="M12 4.2 Q12.7 6.8 15.3 7.5 Q12.7 8.2 12 10.8 Q11.3 8.2 8.7 7.5 Q11.3 6.8 12 4.2 Z"
    fill="none" stroke="currentColor" stroke-width="1.2" />
</symbol>

<!-- Settings：两条轨 + 两个坐在轨上的旋钮（D-344 不用齿轮）
     ★ F1 真机修法：旋钮要**坐在轨道上**才读得出是滑轨 —— 早先轨道短、
       旋钮小，在屏上读成了「虚线加点」，根本不像设置。 -->
<symbol id="nyx-settings" viewBox="0 0 24 24">
  <path d="M3.4 8.6 H8.8 M13.4 8.6 H20.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <path d="M3.4 15.4 H14 M18.6 15.4 H20.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <use href="#nyx-core" x="6.1" y="3.6" width="10" height="10" />
  <use href="#nyx-core" x="11.3" y="10.4" width="10" height="10" />
</symbol>
<symbol id="nyx-settings-o" viewBox="0 0 24 24">
  <path d="M3.4 8.6 H8.8 M13.4 8.6 H20.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <path d="M3.4 15.4 H14 M18.6 15.4 H20.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <use href="#nyx-core-o" x="6.1" y="3.6" width="10" height="10" />
  <use href="#nyx-core-o" x="11.3" y="10.4" width="10" height="10" />
</symbol>

<!-- ══ 判分三态（DS v5 §五）══════════════════════════════════
     四条**非颜色**通道原样（D-341）：形 · 文案 · 动效方向 · 点数。
     验收判据不变：**关掉颜色仍然读得懂**。
     ★ 「芒 = 光 = 会了」是新种子白送的一层语义，比实心/空心更好读。 -->
<!-- 会了：核实心 + 四芒全亮 -->
<symbol id="nyx-grade-ok" viewBox="0 0 24 24"><use href="#nyx-star" /></symbol>
<!-- 差一点：核空心 + 内嵌 45% 实心，**无芒** -->
<symbol id="nyx-grade-near" viewBox="0 0 24 24">
  <use href="#nyx-core-o" />
  <use href="#nyx-core" x="9.48" y="9.48" width="5.04" height="5.04" />
</symbol>
<!-- 再想想：核**虚线**空心，无芒。用 --mute 不用红（D-322 不羞辱） -->
<symbol id="nyx-grade-again" viewBox="0 0 24 24">
  <path
    d="M12 6.4 Q13.2 10.8 17.6 12 Q13.2 13.2 12 17.6 Q10.8 13.2 6.4 12 Q10.8 10.8 12 6.4 Z"
    fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-dasharray="2.4 2.2" stroke-linejoin="round"
  />
</symbol>

<!-- ★ 小尺寸专用（22px 判分四格）—— 与 \`nyx-star-16\` 同一个道理：
     **小尺寸是另一张图**（D-344）。44px 的结果页用 2.4/2.2 的细虚线读得出
     「虚线的星」；22px 上每一段只剩 2px，全落在星的凹角里，
     真机上读成**一撮点，不是形状**（2026-09-01 实测，先试 17 再试 22 都糊）。
     这一版把段拉长到 4、加粗到 2.2 —— 段数从 ~5 降到 ~4，每段才看得出是「一段线」。 -->
<symbol id="nyx-grade-again-s" viewBox="0 0 24 24">
  <path
    d="M12 6.4 Q13.2 10.8 17.6 12 Q13.2 13.2 12 17.6 Q10.8 13.2 6.4 12 Q10.8 10.8 12 6.4 Z"
    fill="none" stroke="currentColor" stroke-width="2.2"
    stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="butt"
  />
</symbol>

<!-- ══ 通用动作 ══
     ★ §4.4 星核配给律：Back / Close / Plus / Sort 这些通用动作
     **一颗星都不放** —— 它们靠笔画语言属于这一家，不靠盖章。
     导航基元线宽 1.8（要比结构线 1.6 更硬）。 -->
<symbol id="nyx-caret" viewBox="0 0 24 24">
  <path d="M9.5 5.5 L16 12 L9.5 18.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
</symbol>
<symbol id="nyx-back" viewBox="0 0 24 24">
  <path d="M14.5 5.5 L8 12 L14.5 18.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
</symbol>
<symbol id="nyx-close" viewBox="0 0 24 24">
  <path d="M6.8 6.8 L17.2 17.2 M17.2 6.8 L6.8 17.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
</symbol>
<symbol id="nyx-plus" viewBox="0 0 24 24">
  <path d="M12 5 V19 M5 12 H19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
</symbol>
<symbol id="nyx-more" viewBox="0 0 24 24">
  <circle cx="12" cy="5.6" r="1.55" fill="currentColor" />
  <circle cx="12" cy="12" r="1.55" fill="currentColor" />
  <circle cx="12" cy="18.4" r="1.55" fill="currentColor" />
</symbol>
<symbol id="nyx-grip" viewBox="0 0 24 24">
  <circle cx="9" cy="6" r="1.4" fill="currentColor" /><circle cx="15" cy="6" r="1.4" fill="currentColor" />
  <circle cx="9" cy="12" r="1.4" fill="currentColor" /><circle cx="15" cy="12" r="1.4" fill="currentColor" />
  <circle cx="9" cy="18" r="1.4" fill="currentColor" /><circle cx="15" cy="18" r="1.4" fill="currentColor" />
</symbol>
<symbol id="nyx-search" viewBox="0 0 24 24">
  <circle cx="10.6" cy="10.6" r="6.4" fill="none" stroke="currentColor" stroke-width="1.6" />
  <path d="M15.3 15.3 L20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
</symbol>
<symbol id="nyx-fix" viewBox="0 0 24 24">
  <path d="M4.4 19.6 L5.4 15.6 L15.6 5.4 A2.1 2.1 0 0 1 18.6 8.4 L8.4 18.6 Z"
    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
</symbol>
<symbol id="nyx-speak" viewBox="0 0 24 24">
  <path d="M4 9.6 V14.4 H7.2 L12 18.4 V5.6 L7.2 9.6 Z" fill="currentColor" />
  <path d="M15.4 9.4 A4 4 0 0 1 15.4 14.6 M18 6.8 A7.6 7.6 0 0 1 18 17.2"
    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
</symbol>
<symbol id="nyx-sync" viewBox="0 0 24 24">
  <!-- D-344：Sync 不用循环弧 —— 两端 + 两条方向相反的路，说的是「两台机器对拷」 -->
  <path d="M7 4.6 H4.4 V19.4 H7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M17 4.6 H19.6 V19.4 H17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M9 9.6 H15.2 M13.2 7.6 L15.4 9.6 L13.2 11.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M15 14.4 H8.8 M10.8 12.4 L8.6 14.4 L10.8 16.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
</symbol>

<!-- ══ 练习与树 ══════════════════════════════════════════════ -->
<symbol id="nyx-recollect" viewBox="0 0 24 24">
  <!-- 认读：一张卡，一行实、一行虚（虚的那行就是要你回忆的） -->
  <rect x="3.6" y="5" width="16.8" height="14" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6" />
  <path d="M6.8 10.2 H11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <path d="M13.4 10.2 H17.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="1.6 1.8" />
  <path d="M6.8 14.2 H14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
</symbol>
<symbol id="nyx-both" viewBox="0 0 24 24">
  <!-- 产出：同一张卡，末笔向上一挑 —— 一笔写出来的笔势
       ★ F2 真机修法：这一笔早先冲出卡片，在屏上读成「画错了」，现在收在卡内 -->
  <rect x="3.6" y="5" width="16.8" height="14" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6" />
  <path d="M6.8 10 H13.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <path d="M6.8 14.8 H13.2 L17.2 10.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
</symbol>
<symbol id="nyx-project" viewBox="0 0 24 24">
  <path d="M12 3.6 L20.4 7.6 L12 11.6 L3.6 7.6 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
  <path d="M3.6 12 L12 16 L20.4 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
  <path d="M3.6 16.4 L12 20.4 L20.4 16.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
</symbol>
<symbol id="nyx-unit" viewBox="0 0 24 24">
  <path d="M12 5.6 L20.4 9.6 L12 13.6 L3.6 9.6 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
  <path d="M3.6 14.4 L12 18.4 L20.4 14.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
</symbol>
<symbol id="nyx-lecture" viewBox="0 0 24 24">
  <path d="M12 4.4 L20.4 8.4 L12 12.4 L3.6 8.4 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
  <path d="M6.4 15.4 H17.6 M6.4 19 H13.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
</symbol>

<!-- ★ 选中记号 —— 2026-09-01 新画。DS §16.3 明写「Chip 选中 = 紫描边加粗 1.5
     + 紫字 + **左侧长出 ✓**」，但那一枚从来没画过：两端至今在用**字符**
     （Android 6 处 · Windows 2 处），而字符的粗细跟着字体走、不受设计控制。
     ★ 家族语法：单笔、stroke 1.6、两端圆头圆角 —— 与 caret / close / plus 同一档。
     ★ 没有空心版：它本身就是「选中」这个状态，不存在未选中的对照。 -->
<symbol id="nyx-check" viewBox="0 0 24 24">
  <path d="M4.8 12.6 L9.6 17.4 L19.2 7.2" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
</symbol>

<!-- ★ 回收站 —— 2026-09-01 新画的第 33 枚，**还没上过真机**。
     几何按 DS §4.4b 那段自我更正逐字落：「实际画出来的就是一只桶……
     它的盖子是分开的一条线（打得开），桶身与 Vault 共用同一条底部曲线」。
     所以桶身**就是** #nyx-vault 那条路径（一个字没改），只是上方另起一条盖线。
     ★ 为什么现在需要它：Windows 侧栏的「垃圾箱」一直用 🗑 —— 那是 emoji，
     D-327 明写「emoji 代设计」是禁令。 -->
<symbol id="nyx-delete" viewBox="0 0 24 24">
  <path d="M4.8 11.2 V17.8 Q4.8 20 7 20 H17 Q19.2 20 19.2 17.8 V11.2"
    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <path d="M3.4 8 H20.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  <path d="M9.4 8 V5.6 Q9.4 4.4 10.6 4.4 H13.4 Q14.6 4.4 14.6 5.6 V8"
    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
</symbol>
`
