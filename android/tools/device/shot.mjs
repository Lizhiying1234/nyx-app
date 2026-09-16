/** 让 WebView 自己截一张页面图 —— 绕开系统合成层，只看页面画了什么 */
import { writeFileSync } from 'node:fs'
const [, , wsUrl, out] = process.argv
const ws = new WebSocket(wsUrl)
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
})
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== 1) return
  const d = m.result?.data
  if (!d) {
    console.error(JSON.stringify(m, null, 1))
    process.exit(1)
  }
  writeFileSync(out, Buffer.from(d, 'base64'))
  console.log('saved', out)
  ws.close()
  process.exit(0)
})
setTimeout(() => {
  console.error('timeout')
  process.exit(1)
}, 15000)
