import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkRows, classifyChunk, SYNC_PROTOCOL_VERSION, type ChunkHeader } from './sync-protocol.ts'

/**
 * 收包判据 · Step 1A
 *
 * 这里守的是一句话：**结构或协议对不上时，整包不收，而且不许标成已处理。**
 * 收一半、丢几列、标 applied —— 三件事任何一件发生，两端就永久差一截，
 * 而且四个数全对、体检不亮。
 */

const local = { schemaVersion: 27, schemaFingerprint: 'b2fdc1106ddbccb3', protocolVersion: 1 }

const head = (o: Partial<ChunkHeader> = {}): ChunkHeader => ({
  device: 'devA',
  at: 1,
  schemaVersion: 27,
  schemaFingerprint: 'b2fdc1106ddbccb3',
  protocolVersion: 1,
  ...o
})

describe('包头分类', () => {
  it('三样都对 → 收', () => {
    assert.equal(classifyChunk(head(), local).kind, 'accept')
  })

  it('没有版本头 → 当 legacy（老版本推的包，允许收）', () => {
    assert.equal(classifyChunk({ device: 'devA', at: 1 }, local).kind, 'legacy')
  })

  it('★ 协议版本不同 → 拒，而且话要说清是「另一台要升级」', () => {
    const v = classifyChunk(head({ protocolVersion: 2 }), local)
    assert.equal(v.kind, 'reject')
    if (v.kind !== 'reject') return
    assert.equal(v.code, 'protocol-mismatch')
    assert.match(v.reason, /协议版本不兼容/)
    assert.match(v.reason, /升级/, '没告诉他下一步该做什么')
    assert.doesNotMatch(v.reason, /^同步失败/, '泛化成「同步失败」等于没说')
  })

  it('★ 结构指纹不同 → 拒，并且明说「整包没有收」', () => {
    const v = classifyChunk(head({ schemaFingerprint: 'deadbeefdeadbeef' }), local)
    assert.equal(v.kind, 'reject')
    if (v.kind !== 'reject') return
    assert.equal(v.code, 'schema-mismatch')
    assert.match(v.reason, /结构/)
    assert.match(v.reason, /整包没有收/)
  })

  it('★ 先判协议再判结构 —— 两个都不对时，给的是「去升级」那句', () => {
    const v = classifyChunk(head({ protocolVersion: 9, schemaFingerprint: 'x' }), local)
    assert.equal(v.kind === 'reject' && v.code, 'protocol-mismatch')
  })

  it('半个包头（只有协议 / 只有指纹）→ 拒，不猜', () => {
    const a = classifyChunk({ device: 'd', protocolVersion: 1 }, local)
    const b = classifyChunk({ device: 'd', schemaFingerprint: 'b2fdc1106ddbccb3' }, local)
    assert.equal(a.kind === 'reject' && a.code, 'partial-header')
    assert.equal(b.kind === 'reject' && b.code, 'partial-header')
  })

  it('包头不是对象 / 是 null → 拒', () => {
    assert.equal(classifyChunk(null, local).kind, 'reject')
    assert.equal(classifyChunk(undefined, local).kind, 'reject')
  })

  it('协议版本不是数、指纹是空串 → 拒', () => {
    assert.equal(classifyChunk(head({ protocolVersion: 'one' }), local).kind, 'reject')
    assert.equal(classifyChunk(head({ schemaFingerprint: '' }), local).kind, 'reject')
  })

  it('schemaVersion 只是诊断信息 —— 指纹一致就收', () => {
    assert.equal(classifyChunk(head({ schemaVersion: 99 }), local).kind, 'accept')
  })

  it('本文件导出的版本号就是本机在用的那个（防止两处各写一份）', () => {
    assert.equal(typeof SYNC_PROTOCOL_VERSION, 'number')
    assert.ok(SYNC_PROTOCOL_VERSION >= 1)
  })
})

describe('包里的行合不合法', () => {
  const tables = ['items', 'lectures']
  const row = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    uid: 'items-abc',
    table: 'items',
    updatedAt: 10,
    data: { id: 1, uid: 'items-abc' },
    ...o
  })

  it('正常的一批 → 过', () => {
    const r = checkRows([row(), row({ uid: 'items-def' })], tables)
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.rows.length, 2)
  })

  it('data 为 null（这一行被删了）→ 过', () => {
    assert.equal(checkRows([row({ data: null })], tables).ok, true)
  })

  it('rows 不是数组 → 整包拒', () => {
    assert.equal(checkRows(undefined, tables).ok, false)
    assert.equal(checkRows({}, tables).ok, false)
  })

  it('★ 一行没有 uid → 整包拒，不是「跳过这一行」', () => {
    const r = checkRows([row(), row({ uid: '' })], tables)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.code, 'bad-rows')
    assert.match(r.ok === false ? r.reason : '', /第 2 行/)
  })

  it('表名本机不认识 → 整包拒', () => {
    const r = checkRows([row({ table: 'evil' })], tables)
    assert.equal(r.ok, false)
    assert.match(r.ok === false ? r.reason : '', /不认识的表/)
  })

  it('时间戳不是数 → 整包拒（合并全靠它）', () => {
    assert.equal(checkRows([row({ updatedAt: 'soon' })], tables).ok, false)
    assert.equal(checkRows([row({ updatedAt: NaN })], tables).ok, false)
  })

  it('data 是数组 / 是字符串 → 整包拒', () => {
    assert.equal(checkRows([row({ data: [] })], tables).ok, false)
    assert.equal(checkRows([row({ data: 'x' })], tables).ok, false)
  })

  it('★ 新包老包同一份行判据 —— 老包也不许缺必要字段', () => {
    // legacy 的宽容只体现在「本机没有的列可以丢」，不体现在「行可以缺身份」
    assert.equal(checkRows([{ table: 'items', updatedAt: 1, data: {} }], tables).ok, false)
  })
})
