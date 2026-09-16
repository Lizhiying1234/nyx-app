import { applyReadingGrade, newCardState } from '../../2-可移植资产/core/sm2-item.ts'
import { canonicalUid } from '../../2-可移植资产/core/builtin-identity.ts'
const o = applyReadingGrade(newCardState(), 3)
console.log(JSON.stringify({ ok: true, interval: o.intervalDays, reason: o.reason, uid: canonicalUid('qtypes', { builtin: 1, key: '造句' }) }))
