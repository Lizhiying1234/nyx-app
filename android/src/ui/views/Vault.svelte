<script lang="ts">
  /**
   * Vault —— 知识点库域（D-388 独立 Tab · D-391 全族定形）。
   *
   * ══ 四段式（高保真 v4 ①b 帧为验收样）═══════════════════════
   *   hero 馆藏数（400 —— 层级用尺寸不用字重，D-392）
   *   → 馆藏搜索（底线式；结果页没过高保真，先如实说）
   *   → Assist 专区（唯一有底色的面；有才出现 —— Capture 未落地时恒隐藏，不造假数）
   *   → 点线 INDEX（全部 / 攻坚 / 静默 / 重复收集 / 回收站）→ 子页全部真接线
   *
   * ★ D-348 卫兵：静默库**不取不显总数**；攻坚显示的是待练任务量；
   *   馆藏数是规模；回收站是件数。
   * ★ Tab 内导航栈（D-393 返回链）：详情 → 子页 → 首页 → App 层兜底。
   * ★ D-227：零样式。
   */
  import { DUP_COLLECT } from '../lib/copy.ts'
  import { SILENCE_FILTER_NAME } from '../../core-link.ts'
  import { route } from '../lib/route.svelte.ts'
  import { store } from '../lib/store.svelte.ts'
  import VaultItems from './VaultItems.svelte'
  import VaultHard from './VaultHard.svelte'
  import VaultSilent from './VaultSilent.svelte'
  import VaultTrash from './VaultTrash.svelte'
  import VaultSearch from './VaultSearch.svelte'
  import Detail from './Detail.svelte'
  import Lecture from './Lecture.svelte'
  import type { LibraryFilter } from '../../db/vault-lists.ts'

  /**
   * ★ 导航状态已上收到全应用唯一的 Route（`lib/route.svelte.ts`，D-411）。
   *   栈为空 = Vault 的 Root（首页）。
   */
  const nav = $derived(route.stacks.vault.at(-1) ?? null)

  /**
   * ★ 这里原来有一个 `todo()` 占位（点「在馆藏里找…」只会说「还没接上」）。
   *   2026-09-01 搜索接真之后，**Vault 首页已经没有任何未接线的入口**。
   */
  const v = $derived(store.vault)
  const home = (): void => void route.pop()
  const open = (id: number): void => route.push({ k: 'item', id })

  /* ★ 返回不再由本组件注册 —— Route 落地后由 App.svelte 的 backstack 统一消费。 */
</script>

{#if nav?.k === 'item'}
  <Detail id={nav.id} onback={home} />
{:else if nav?.k === 'items'}
  <VaultItems preset={nav.preset} title={nav.title} showTotal={nav.showTotal} onopen={open} onback={home} />
{:else if nav?.k === 'hard'}
  <VaultHard onopen={open} onback={home} />
{:else if nav?.k === 'silent'}
  <VaultSilent onopen={open} onback={home} />
{:else if nav?.k === 'trash'}
  <VaultTrash onback={home} />
{:else if nav?.k === 'search'}
  <VaultSearch onopen={open} onback={home} />
{:else if nav?.k === 'lec'}
  <Lecture id={nav.id} onback={home} onitem={open} />
{:else}
  <div class="view">
    <!-- ★ 屏顶标题已删（第十九则指令 §六/§七）：底部 Tab 已经说过「Vault」。
         馆藏大数因此直接落在屏顶 —— 回到高保真 v4 ①b 帧的四段式本来样子。 -->
    {#if store.db.k !== 'ok'}
      <div class="empty"><div class="t zh2">等库打开…</div></div>
    {:else if v === null}
      <div class="empty"><div class="t zh2">数不出来</div><div class="s">计数查询失败 —— 树那边若正常，这里单独重试即可。</div></div>
    {:else}
      <!-- ★ 馆藏大数领屏：「VAULT ✦」小标签与屏顶标题都已删掉，
           这一屏第一眼看到的是那个数，不是一句「你在 Vault」。
           ★ 2026-09-09：我提过「大数与 INDEX 第一行说的是同一个数、而且最响的那个
           不可点」，使用者裁 **两个都保留、大数也不改成入口**。记录在 SC-07 六问第 5 问，
           不当待办。 -->
      <div class="vnum">{v.total}</div>
      <div class="vsub zh">全部知识点{#if v.hard > 0} · 攻坚 {v.hard} 待练{/if}</div>

      <!-- ★ 馆藏搜索已接真（F-013 · 2026-09-01）—— 手机没有常驻树，找东西只能靠它。
           判据 = db/search.ts（逐字港 browse.ts::search，范围照 D-106）。 -->
      <button class="uline" style="margin-top:16px" onclick={() => route.push({ k: 'search' })}>
        <svg class="ic" width="12" height="12" viewBox="0 0 24 24" style="color:var(--mute)"><use href="#nyx-search" /></svg>
        <span class="zh">在馆藏里找…</span>
      </button>

      {#if v.assist > 0}
        <!-- Assist 专区（D-400③）：统一收集视图 —— 判据 = ops_log capture 来源标记；
             同一批知识点（落进哪个 P/U/L 都在这找得到），不是第二套数据 -->
        <button
          class="assist"
          onclick={() =>
            route.push({
              k: 'items',
              preset: { assistOnly: true, includeSilent: true, sort: 'recent' },
              title: 'Assist 收进来的',
              showTotal: false
            })}>
          <span class="hd">
            <svg class="ic" width="13" height="13" viewBox="0 0 24 24" style="color:var(--violet)"><use href="#nyx-star" /></svg>
            <span class="lab" style="margin:0;color:var(--violet)">我的收集</span>
            <span class="zh" style="font-size:11.5px;color:var(--mute)">收进来的</span>
            <span class="m" style="margin-left:auto">{v.assist} <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
          </span>
        </button>
      {/if}

      <div class="sec">Index</div>
      <div class="set">
        <button class="toc" onclick={() => route.push({ k: 'items' })}>
          <span class="nm zh">全部</span><span class="lead"></span><span class="ct">{v.total} <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
        </button>
        <button class="toc" data-guide="vault-hard" onclick={() => route.push({ k: 'hard' })}>
          <span class="nm zh">攻坚区</span><span class="lead" class:nodots={v.hard === 0}></span>
          <span class="ct">{#if v.hard > 0}<span class="tag t-w">{v.hard} 待练</span>{/if} <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
        </button>
        <!-- ★ 这一档无数字（D-348：「已静默总数」是点名禁止的统计）。
             ★ 名字**中性**（使用者 2026-09-15 裁）：里面装着「已练成」和「收起来了」
               两件相反的事，叫其中任何一个都是对另一半说假话（D-412）。 -->
        <button class="toc" data-guide="vault-learned" onclick={() => route.push({ k: 'silent' })}>
          <span class="nm zh">{SILENCE_FILTER_NAME}</span><span class="lead nodots"></span><span class="ct"><svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
        </button>
        <button
          class="toc"
          onclick={() => route.push({ k: 'items', preset: { onlyRepeated: true }, title: DUP_COLLECT, showTotal: false })}
        >
          <span class="nm zh">{DUP_COLLECT}</span><span class="lead" class:nodots={v.redo === 0}></span>
          <span class="ct">{#if v.redo > 0}{v.redo} {/if}<svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
        </button>
        <button class="toc dim" onclick={() => route.push({ k: 'trash' })}>
          <span class="nm zh">回收站</span><span class="lead" class:nodots={v.trash === 0}></span><span class="ct">{#if v.trash > 0}{v.trash} {/if}<svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
        </button>
      </div>
    {/if}
  </div>
{/if}
