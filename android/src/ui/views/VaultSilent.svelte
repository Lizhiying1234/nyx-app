<script lang="ts">
  /**
   * 「静默」那一档（①e 下半 · D-359：这是学习决定，给）。
   *   ★ 屏上那两个字**不在这儿写**，从 `SILENCE_FILTER_NAME` 来（注释里拼不了常量，
   *     而闸扫之前剥注释 —— 所以这一行没人拦，只能靠写的人自己别抄第二份）。
   * ★★★ 标题**无数字**（D-348 点名：「已静默总数」是统计）—— 列表只列行。
   * ★★ D-485：一个档里装着**两件相反的事** —— 自动练成的（已练成）与他手动
   *   收起来的（收起来了）。库值都是 `production_state='silent'`，靠 `silenced_by`
   *   分。**行上必须分得出来**，否则里面就是一锅（D-412）。
   *   ★★ 2026-09-15 档名裁回了短的「静默」，**中性名那条退路没有了** ——
   *     D-412 那个顾虑改由引导句 `vault-learned` 扛（core `PAGE_GUIDES`，两端一句）。
   *     所以「行上分得出来」这一条**变得更硬**：名字不再自己解释自己了。
   *   判据在 core（`silenceKind`），不在这里写第二份。
   *   ★ 屏上那两个词 2026-09-15 不再出现了（D-489，见下面小标那一段）。
   * ★ 「放回去」行内直给（D-379 H5 核心不藏）—— 真写 `restoreItem`：
   *   清零建立期、认读卡立刻到期（与 bulkSilence(false) 是两个动作）。
   * ★ 日期是单对象直读：state_events 最后一次转入，兜底 updated_at。
   */
  import { CANT_READ, RESTORED_CARD } from '../lib/copy.ts'
  import { untrack } from 'svelte'
  import { store } from '../lib/store.svelte.ts'
  import { snacks } from '../lib/snack.svelte.ts'
  import { loadLibraryItems, type VaultItem } from '../../db/vault-lists.ts'
  import { restoreItem } from '../../db/manage.ts'
  import { listArchived, setSilentNode, type ArchivedRow } from '../../db/manage-nodes.ts'
  import { SILENCE_ACTIONS, SILENCE_FILTER_NAME } from '../../core-link.ts'

  let { onopen, onback }: { onopen: (id: number) => void; onback: () => void } = $props()

  let rows = $state<VaultItem[]>([])
  let archived = $state<ArchivedRow[]>([])
  let silencedAt = $state<Record<number, number>>({})
  /** 这一条是练成的还是他收起来的 —— 值原样从库里来，认哪一种由 core 判 */
  let stat = $state<'loading' | 'ok' | 'error'>('loading')
  let err = $state('')
  let note = $state<string | null>(null)
  let busy = $state(false)

  async function load(): Promise<void> {
    if (store.db.k !== 'ok') return
    try {
      const db = store.db.db
      rows = await loadLibraryItems(db, { scope: 'silent', sort: 'stalest' })
      const map: Record<number, number> = {}
      if (rows.length > 0) {
        const q = rows.map(() => '?').join(',')
        for (const r of await db.all(
          `select item_id as id, max(created_at) as at from state_events
            where to_state = 'silent' and item_id in (${q}) group by item_id`,
          rows.map((x) => x.id)
        )) {
          map[Number(r['id'])] = Number(r['at'])
        }
      }
      silencedAt = map
      archived = await listArchived(db)
      stat = 'ok'
    } catch (e) {
      stat = 'error'
      err = (e as Error)?.message ?? String(e)
    }
  }
  $effect(() => {
    untrack(() => {
      void load()
    })
  })

  async function doRestore(id: number): Promise<void> {
    if (store.db.k !== 'ok' || busy) return
    busy = true
    try {
      await restoreItem(store.db.db, id)
      await load()
      await store.reloadCounts()
      snacks.show(RESTORED_CARD)
    } catch (e) {
      note = `恢复没写成：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }

  const KIND_A: Record<'project' | 'unit' | 'lecture', string> = { project: '项目', unit: '单元', lecture: 'Lecture' }

  const fmtDay = (at: number): string => {
    const d = new Date(at)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
</script>

<div class="view">
  <!-- ★ 子页屏顶（与 Lecture 同一形态）：back + 坐标，标题另起一行 -->
  <div class="top" style="gap:8px">
    <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
      <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
    </button>
  </div>

  {#if note}<div class="note" role="status">{note}</div>{/if}

  <!-- ★ 无数字（D-348） -->

  {#if stat === 'error'}
    <div class="empty tight"><div class="t zh2">{CANT_READ}</div><div class="s">{err}</div></div>
  {:else if stat === 'ok' && rows.length === 0 && archived.length === 0}
    <div class="empty tight">
      <div class="t zh2">这里还没有东西</div>
      <!--
        ★ 这句说明 2026-09-15 删掉了（主控裁）：它和引导句 `vault-learned` 说的是同一件事，
          而档名「静默」+ 筛选片「含静默」已经自解释。
        ★ 顺带解决一个真机才看得见的缺陷：那句在 360 宽上断成「…随时恢 / 复。」——
          **拼进句子的常量会把断点搬家**，四门看不见。
      -->
    </div>
  {:else}
    <div class="set mt3">
      {#each rows as r (r.id)}
        <div class="li">
          <button class="hit" onclick={() => onopen(r.id)}>
            <span class="g">
              <span class="term ink2">{r.term}</span>
              <!--
                ★★★ **行上那枚小标 2026-09-15 去掉了**（D-489 · 使用者裁，两端同步）。
                  它标的是「这一条是练成的还是你自己收起来的」。使用者这一轮裁
                  「已练成」退役，并且**不要小标把这一档分成两半**。
                ★ 判据没删：`silenceKind()` 还在 core，进度仍然只算练成的那一半（D-485）——
                  去掉的只是「把这个区分写到他眼前」。
                ★ 喂它的 `silencedBy` 那份状态**一并删掉**：只删控件会留一条哑路
                  （查了库、存进 state、没人读），下一个人会以为它还是活的。
              -->
              <small>{fmtDay(silencedAt[r.id] ?? r.updatedAt)} · <span class="tag t-v">{r.layer}</span></small>
            </span>
          </button>
          <button class="rowact" disabled={busy} onclick={() => void doRestore(r.id)}>{SILENCE_ACTIONS.restore}</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if archived.length > 0}
    <!--
      被静默的容器 —— Atlas 的树排掉 silent=1（Windows 同口径），恢复只能在这里。
      ★ 小标原来是 `SHELVED`，那是退役概念「收起来」的英文（D-489）。
        全大写英文小标是这一端的风格（使用者 2026-09-15 裁，保留）；
        换掉的只是里面那个**概念词**。
    -->
    <div class="lab">SILENCED</div>
    <div class="set">
      {#each archived as a (`${a.kind}-${a.id}`)}
        <div class="li">
          <span class="g">
            <span class="zh s14 ink2">{KIND_A[a.kind]} · {a.name}</span>
          </span>
          <button
            class="rowact"
            disabled={busy}
            onclick={async () => {
              if (store.db.k !== 'ok' || busy) return
              busy = true
              try {
                await setSilentNode(store.db.db, a.kind, a.id, false)
                await load()
                await store.reload()
                await store.reloadCounts()
                snacks.show(`已${SILENCE_ACTIONS.restore} —— 回到树里了`)
              } catch (e) {
                note = `没写成：${(e as Error)?.message ?? e}`
              } finally {
                busy = false
              }
            }}>{SILENCE_ACTIONS.restore}</button>
        </div>
      {/each}
    </div>
  {/if}

</div>
