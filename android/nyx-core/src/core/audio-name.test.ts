import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkAudioName, isAllowedAudioName } from './audio-name.ts'

/**
 * 同步音频的文件名白名单 · Step 1D / F-08
 *
 * 判据是「只认本机命名规则能产生的名字」，不是「排除 ../」——
 * 黑名单永远漏，白名单不会。下面这些用例大部分是为了证明这一点。
 */

const good = 'a'.repeat(40) + '.mp3'
const real = '1f3b8c2d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c.mp3'

describe('放行', () => {
  it('40 位小写 hex + .mp3', () => {
    assert.equal(isAllowedAudioName(good), true)
    assert.equal(isAllowedAudioName(real), true)
  })
})

describe('拒绝', () => {
  const bad: [string, unknown][] = [
    ['上级目录（/）', '../evil.mp3'],
    ['上级目录（\\）', '..\\evil.mp3'],
    ['藏在中间的上级目录', 'aaaa/../../evil.mp3'],
    ['绝对路径（盘符）', 'C:\\evil.mp3'],
    ['绝对路径（/ 开头）', '/etc/passwd.mp3'],
    ['带正斜杠', 'sub/' + good],
    ['带反斜杠', 'sub\\' + good],
    ['扩展名不对', 'a'.repeat(40) + '.exe'],
    ['双扩展名', 'a'.repeat(40) + '.mp3.exe'],
    ['没有扩展名', 'a'.repeat(40)],
    ['hex 太短', 'a'.repeat(39) + '.mp3'],
    ['hex 太长', 'a'.repeat(41) + '.mp3'],
    ['大写 hex', 'A'.repeat(40) + '.mp3'],
    ['非 hex 字符', 'z'.repeat(40) + '.mp3'],
    ['空字符串', ''],
    ['空字节', 'a'.repeat(40) + '.mp3\u0000'],
    ['不是字符串', 42],
    ['null', null],
    ['undefined', undefined],
    ['只有点', '..'],
    ['当前目录', './' + good]
  ]

  for (const [why, name] of bad) {
    it(`${why} → 拒`, () => {
      assert.equal(isAllowedAudioName(name), false, `${JSON.stringify(name)} 被放行了`)
    })
  }

  it('★ 拒绝时要说得出为什么 —— 报进 sync problem 的就是这句', () => {
    const v = checkAudioName('../evil.mp3')
    assert.equal(v.ok, false)
    assert.ok(v.ok === false && v.why.length > 0)
  })
})

describe('这条判据本身的形状', () => {
  it('URL 编码过的 ../ 不会被「还原」—— 它本来就不该匹配白名单', () => {
    assert.equal(isAllowedAudioName('..%2Fevil.mp3'), false)
    assert.equal(isAllowedAudioName('%2e%2e%2fevil.mp3'), false)
  })

  it('Unicode 同形字也过不去（白名单只认 [0-9a-f]）', () => {
    assert.equal(isAllowedAudioName('ａ'.repeat(40) + '.mp3'), false)
  })
})
