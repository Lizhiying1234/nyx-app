import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALWAYS_DROP,
  DROP_ON_SYNC,
  dynamicOf,
  EXTRA_RELATIONS,
  localOnlyKeys,
  relationsOf,
  SCOPE_TABLES,
  syncColumnOf,
  toLocal,
  toSync,
  type Relation
} from './fk-map.ts'

/**
 * 同步边界的身份翻译 · Step 3 / C-2
 *
 * 守两件事：
 *   ① **来回一趟回得来** —— 本地行 → 同步行 → 本地行，关系原样重建
 *   ② **父行不在时不许含糊** —— 不猜、不填 0、不跳过，明确失败
 */

const ITEM_FK: Relation[] = [
  { column: 'item_id', parent: 'items', syncColumn: 'item_uid' },
  { column: 'lecture_id', parent: 'lectures', syncColumn: 'lecture_uid' }
]

/** 一对假的解析器：id ↔ uid 一一对应 */
const world = new Map<string, Map<number, string>>([
  ['items', new Map([[3, 'items-aaa'], [4, 'items-bbb']])],
  ['lectures', new Map([[7, 'lectures-ccc']])],
  ['prompt_presets', new Map([[1, 'prompt_presets-ddd']])],
  ['projects', new Map([[9, 'projects-eee']])]
])
const uidOf = (t: string, id: number): string | null => world.get(t)?.get(id) ?? null
const idOf = (t: string, uid: string): number | null => {
  for (const [id, u] of world.get(t) ?? []) if (u === uid) return id
  return null
}

describe('列名规则', () => {
  it('`x_id` → `x_uid`', () => {
    assert.equal(syncColumnOf('item_id'), 'item_uid')
    assert.equal(syncColumnOf('owner_lecture_id'), 'owner_lecture_uid')
    assert.equal(syncColumnOf('converted_lecture_id'), 'converted_lecture_uid')
  })
  it('不以 `_id` 结尾的直接加后缀（自引用那一条）', () => {
    assert.equal(syncColumnOf('derived_from'), 'derived_from_uid')
  })
  it('★ 规则是函数不是清单 —— 清单会漏，而漏掉的关系不报错', () => {
    for (const c of ['a_id', 'b', 'x_y_id']) assert.ok(syncColumnOf(c).endsWith('_uid'))
  })
})

describe('本地行 → 同步行', () => {
  it('★ 本地自增主键被删掉', () => {
    const r = toSync('answers', { id: 1, item_id: 3, text: 'x' }, ITEM_FK, [], uidOf)
    assert.equal(r.ok, true)
    assert.ok(r.ok && !(ALWAYS_DROP in r.data), '包里还带着本地 id')
  })

  it('★ 数字外键换成 uid，本地列名不再出现', () => {
    const r = toSync('answers', { id: 1, item_id: 3, lecture_id: 7, text: 'x' }, ITEM_FK, [], uidOf)
    assert.ok(r.ok)
    if (!r.ok) return
    assert.equal(r.data['item_uid'], 'items-aaa')
    assert.equal(r.data['lecture_uid'], 'lectures-ccc')
    assert.ok(!('item_id' in r.data) && !('lecture_id' in r.data))
    assert.equal(r.data['text'], 'x', '非关系列该原样带过去')
  })

  it('可空外键为 null → 同步列也是 null', () => {
    const r = toSync('answers', { id: 1, item_id: null, text: 'x' }, ITEM_FK, [], uidOf)
    assert.ok(r.ok && r.data['item_uid'] === null)
  })

  it('★★ 父行查不到 uid → **整行不发**，不发 null', () => {
    const r = toSync('answers', { id: 1, item_id: 999, text: 'x' }, ITEM_FK, [], uidOf)
    assert.equal(r.ok, false)
    assert.match(r.ok === false ? r.why : '', /999/)
    assert.match(r.ok === false ? r.why : '', /items/)
  })

  it('★ 明说要丢的列真的被丢掉（ops_log.target_id 是展示面包屑，不是关系）', () => {
    assert.deepEqual([...(DROP_ON_SYNC['ops_log'] ?? [])], ['target_id'])
    const r = toSync('ops_log', { id: 1, target: 'item', target_id: 42, title: 'x' }, [], [], uidOf)
    assert.ok(r.ok && !('target_id' in r.data) && r.data['title'] === 'x')
  })
})

describe('同步行 → 本地行', () => {
  it('★ uid 换回本地 id，同步列名不再出现', () => {
    const r = toLocal('answers', { item_uid: 'items-aaa', lecture_uid: 'lectures-ccc', text: 'x' }, ITEM_FK, [], idOf)
    assert.ok(r.ok)
    if (!r.ok) return
    assert.equal(r.data['item_id'], 3)
    assert.equal(r.data['lecture_id'], 7)
    assert.ok(!('item_uid' in r.data))
  })

  it('★★ 父行还没到 → 整行失败，话里说得出是哪一个', () => {
    const r = toLocal('answers', { item_uid: 'items-never', text: 'x' }, ITEM_FK, [], idOf)
    assert.equal(r.ok, false)
    assert.match(r.ok === false ? r.why : '', /items/)
    assert.match(r.ok === false ? r.why : '', /还没同步/)
  })

  it('★★ 绝不拿 0 / null 顶一个外键', () => {
    const r = toLocal('answers', { item_uid: 'items-never' }, ITEM_FK, [], idOf)
    assert.equal(r.ok, false, '父行不在却给了个值')
  })

  it('★★ 绝不按 uid 的字符串去猜 id', () => {
    // `items-aaa` 里没有任何数字可猜；就算有，也不许猜
    const r = toLocal('answers', { item_uid: 'items-3' }, ITEM_FK, [], idOf)
    assert.equal(r.ok, false)
  })

  it('uid 不是字符串 → 失败', () => {
    assert.equal(toLocal('answers', { item_uid: 42 }, ITEM_FK, [], idOf).ok, false)
  })
})

describe('★★ 来回一趟：本地 → 同步 → 本地', () => {
  it('关系原样重建', () => {
    const local = { id: 5, item_id: 3, lecture_id: 7, text: 'x', grade: 3 }
    const s = toSync('answers', local, ITEM_FK, [], uidOf)
    assert.ok(s.ok)
    if (!s.ok) return
    const back = toLocal('answers', s.data, ITEM_FK, [], idOf)
    assert.ok(back.ok)
    if (!back.ok) return
    assert.equal(back.data['item_id'], 3)
    assert.equal(back.data['lecture_id'], 7)
    assert.equal(back.data['text'], 'x')
    assert.equal(back.data['grade'], 3)
    assert.ok(!('id' in back.data), '本地 id 该由收的那一侧自己分，不许从包里带回来')
  })

  it('★★ 同一个身份、**不同的本地 id**，也能接回去 —— 这就是 C-2 的全部意义', () => {
    const s = toSync('answers', { id: 5, item_id: 3, text: 'x' }, ITEM_FK, [], uidOf)
    assert.ok(s.ok)
    if (!s.ok) return
    // 对面那台机器上，同一条知识点的本地 id 是 88
    const otherSide = (t: string, uid: string): number | null =>
      t === 'items' && uid === 'items-aaa' ? 88 : null
    const back = toLocal('answers', s.data, ITEM_FK, [], otherSide)
    assert.ok(back.ok && back.data['item_id'] === 88)
  })
})

describe('动态关系', () => {
  const picks = dynamicOf('picks')

  it('picks 的每个 scope 都在清单里', () => {
    assert.deepEqual(Object.keys(SCOPE_TABLES).sort(), ['lecture', 'project'])
    assert.equal(SCOPE_TABLES['lecture'], 'lectures')
    assert.equal(SCOPE_TABLES['project'], 'projects')
  })

  it('★ picks · lecture 作用域来回一趟', () => {
    const s = toSync('picks', { id: 1, scope: 'lecture', scope_id: 7, content: 'x' }, [], picks, uidOf)
    assert.ok(s.ok && s.data['scope_uid'] === 'lectures-ccc' && !('scope_id' in s.data))
    if (!s.ok) return
    const back = toLocal('picks', s.data, [], picks, idOf)
    assert.ok(back.ok && back.data['scope_id'] === 7 && back.data['scope'] === 'lecture')
  })

  it('★ picks · project 作用域来回一趟', () => {
    const s = toSync('picks', { id: 1, scope: 'project', scope_id: 9, content: 'x' }, [], picks, uidOf)
    assert.ok(s.ok && s.data['scope_uid'] === 'projects-eee')
    if (!s.ok) return
    const back = toLocal('picks', s.data, [], picks, idOf)
    assert.ok(back.ok && back.data['scope_id'] === 9)
  })

  it('★ picks 的父不在 → 整行不发', () => {
    const s = toSync('picks', { id: 1, scope: 'lecture', scope_id: 404 }, [], picks, uidOf)
    assert.equal(s.ok, false)
  })

  it('认不出的 scope → 不当成关系（留 null），而不是把数字发出去', () => {
    const s = toSync('picks', { id: 1, scope: '???', scope_id: 7 }, [], picks, uidOf)
    assert.ok(s.ok && s.data['scope_uid'] === null)
  })

  it('★★ tombstones.target_id 不进包 —— 它只由本机自己写', () => {
    /**
     * ★ 这一条的形状是被负向对照改过来的。
     *
     * 一开始我让 `toLocal` 按 `target_uid` 反查一次本地号码填回 `target_id`，
     * 看着挺合理。把那段删掉之后**一条用例都不红** —— 因为 B 执行这块碑时
     * 会走 `hardDelete` → `cascade.writeTombstones`，那里就地按本机号码写好了。
     * 也就是说那段代码从来没承过重，只是多了一份写同一个字段的路。
     *
     * 现在：`target_id` **只有一个写入方**。边界这一层只保证它不进包。
     */
    const tb = dynamicOf('tombstones')
    const s = toSync('tombstones', { id: 1, kind: 'items', target_uid: 'items-aaa', target_id: 3 }, [], tb, uidOf)
    assert.ok(s.ok)
    if (!s.ok) return
    assert.ok(!('target_id' in s.data), '包里不该有 target_id —— 那是本机的号码')
    assert.ok(!('id' in s.data), '包里不该有本地主键')
    assert.equal(s.data['target_uid'], 'items-aaa', 'target_uid 本来就是身份，原样带走')
    assert.equal(s.data['kind'], 'items')

    // 收回来时不碰它 —— 留给 writeTombstones 写
    const back = toLocal('tombstones', s.data, [], tb, idOf)
    assert.ok(back.ok)
    if (!back.ok) return
    assert.ok(!('target_id' in back.data), '边界不该顺手写 target_id —— 那是第二份写入方')
    assert.equal(back.data['target_uid'], 'items-aaa')
  })

})

describe('清单本身', () => {
  it('★ pragma 看不见的关系必须明写 —— lectures.preset_id 就是一条', () => {
    const extra = EXTRA_RELATIONS['lectures'] ?? []
    assert.equal(extra.length, 1)
    assert.deepEqual({ ...extra[0] }, {
      column: 'preset_id',
      parent: 'prompt_presets',
      syncColumn: 'preset_uid'
    })
  })

  it('relationsOf 把声明的和明写的合起来，不重复', () => {
    const declared: Relation[] = [{ column: 'unit_id', parent: 'units', syncColumn: 'unit_uid' }]
    const all = relationsOf('lectures', declared)
    assert.equal(all.length, 2)
    assert.deepEqual(all.map((r) => r.column).sort(), ['preset_id', 'unit_id'])
  })

  it('★ localOnlyKeys 认得出「有一条路没走翻译」', () => {
    assert.deepEqual(localOnlyKeys({ item_uid: 'x', text: 'y' }, ITEM_FK, []), [])
    assert.deepEqual(localOnlyKeys({ id: 1, item_id: 3 }, ITEM_FK, []).sort(), ['id', 'item_id'])
  })
})
