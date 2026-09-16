import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSchema, type SchemaTable } from './schema-fingerprint.ts'

/**
 * 结构指纹的规范化 · Step 1A
 *
 * 这一条的价值全在**它对什么敏感、对什么不敏感**上：
 *   敏感 → 少列 / 多列 / 少唯一索引 / 少触发器 / 改可空 / 改外键
 *   不敏感 → 书写顺序、大小写、引号风格、自动索引的名字
 * 敏感度不够 = 静默丢字段；敏感过头 = 天天误报，两次之后就没人信了。
 */

const base = (): SchemaTable => ({
  name: 'items',
  columns: [
    { name: 'id', type: 'INTEGER', notNull: false, dflt: null, pk: 1 },
    { name: 'term', type: 'TEXT', notNull: true, dflt: null, pk: 0 },
    { name: 'kind', type: 'TEXT', notNull: true, dflt: "'chunk'", pk: 0 },
    { name: 'uid', type: 'TEXT', notNull: false, dflt: null, pk: 0 }
  ],
  fks: [
    { from: 'derived_from', parent: 'items', to: 'id', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }
  ],
  indexes: [
    { name: 'idx_items_uid', columns: ['uid'], unique: true, origin: 'c' },
    { name: 'idx_items_term', columns: ['term'], unique: false, origin: 'c' },
    { name: 'sqlite_autoindex_items_1', columns: ['uid'], unique: true, origin: 'u' }
  ],
  triggers: ['trg_items_uid']
})

const clone = (t: SchemaTable): SchemaTable => JSON.parse(JSON.stringify(t)) as SchemaTable
const fp = (tables: SchemaTable[]): string => normalizeSchema(tables)

describe('结构相同 → 指纹相同（不该敏感的那些）', () => {
  it('同一份结构，算两遍一样', () => {
    assert.equal(fp([base()]), fp([base()]))
  })

  it('列的书写顺序不算差异', () => {
    const t = clone(base())
    t.columns.reverse()
    assert.equal(fp([t]), fp([base()]))
  })

  it('表的书写顺序不算差异', () => {
    const a = clone(base())
    const b = clone(base())
    b.name = 'lectures'
    assert.equal(fp([a, b]), fp([b, a]))
  })

  it('外键 / 索引 / 触发器的顺序不算差异', () => {
    const t = clone(base())
    t.indexes.reverse()
    t.triggers = [...t.triggers].reverse()
    assert.equal(fp([t]), fp([base()]))
  })

  it('类型的大小写与空白不算差异', () => {
    const t = clone(base())
    t.columns[1]!.type = ' text '
    assert.equal(fp([t]), fp([base()]))
  })

  it('★ 默认值的引号风格不算差异 —— 但「是不是字符串」仍然算', () => {
    const dq = clone(base())
    dq.columns[2]!.dflt = '"chunk"'
    assert.equal(fp([dq]), fp([base()]), '双引号写的同一个默认值被判成不同了')

    const num = clone(base())
    num.columns[2]!.dflt = '0'
    const str = clone(base())
    str.columns[2]!.dflt = "'0'"
    assert.notEqual(fp([num]), fp([str]), "default 0 和 default '0' 是两回事")
  })

  it('自动索引的名字不算差异（它是生成的，序号会漂）', () => {
    const t = clone(base())
    t.indexes[2]!.name = 'sqlite_autoindex_items_7'
    assert.equal(fp([t]), fp([base()]))
  })

  it('★ 触发器只算名字，不算正文（D-269：指纹只表达结构）', () => {
    // 正文根本没进过输入 —— 这一条守的是「将来别有人把正文塞进来」
    const t = clone(base())
    assert.equal(fp([t]), fp([base()]))
    assert.ok(!fp([t]).includes('randomblob'), '指纹里出现了触发器正文')
  })
})

describe('结构变了 → 指纹必须变', () => {
  const differs = (mutate: (t: SchemaTable) => void, why: string): void => {
    const t = clone(base())
    mutate(t)
    assert.notEqual(fp([t]), fp([base()]), why)
  }

  it('少一列', () => differs((t) => t.columns.splice(1, 1), '少一列没被发现 —— 那一列的值会被静默丢掉'))
  it('多一列', () =>
    differs(
      (t) => t.columns.push({ name: 'extra', type: 'TEXT', notNull: false, dflt: null, pk: 0 }),
      '多一列没被发现'
    ))
  it('改可空性', () => differs((t) => (t.columns[1]!.notNull = false), '可空性变了没被发现'))
  it('改类型', () => differs((t) => (t.columns[1]!.type = 'BLOB'), '类型变了没被发现'))
  it('改默认值', () => differs((t) => (t.columns[2]!.dflt = "'word'"), '默认值变了没被发现'))
  it('改主键位', () => differs((t) => (t.columns[0]!.pk = 0), '主键变了没被发现'))
  it('少一个唯一索引', () =>
    differs((t) => t.indexes.splice(0, 1), '少了 idx_items_uid 没被发现 —— 跨设备身份就没有唯一性了'))
  it('唯一索引变成普通索引', () => differs((t) => (t.indexes[0]!.unique = false), '唯一性丢了没被发现'))
  it('少一个普通索引', () => differs((t) => t.indexes.splice(1, 1), '少一个索引没被发现'))
  it('少一条触发器', () => differs((t) => (t.triggers = []), '少了 uid 触发器没被发现 —— 新行会没有 uid'))
  it('少一条外键', () => differs((t) => (t.fks = []), '外键没了没被发现'))
  it('外键指到别的表', () => differs((t) => (t.fks[0]!.parent = 'lectures'), '外键指向变了没被发现'))
  it('外键动作变了', () => differs((t) => (t.fks[0]!.onDelete = 'CASCADE'), 'on delete 变了没被发现'))
  it('少一张表', () => {
    const two = [base(), { ...base(), name: 'lectures' }]
    assert.notEqual(fp(two), fp([base()]), '少一张表没被发现')
  })
  it('表改名', () => differs((t) => (t.name = 'items2'), '表名变了没被发现'))
})
