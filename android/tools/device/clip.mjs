/** 截页面的一小块并放大 —— 缩略图看不准的时候用 */
import { writeFileSync } from 'node:fs'
const [, , wsUrl, out, x, y, w, h, scale] = process.argv
const ws = new WebSocket(wsUrl)
ws.addEventListener('open', () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Page.captureScreenshot',
      params: {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: +x, y: +y, width: +w, height: +h, scale: +scale }
      }
    })
  )
})
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== 1) return
  if (!m.result?.data) {
    console.error(JSON.stringify(m, null, 1))
    process.exit(1)
  }
  writeFileSync(out, Buffer.from(m.result.data, 'base64'))
  console.log('saved')
  ws.close()
  process.exit(0)
})
setTimeout(() => {
  console.error('timeout')
  process.exit(1)
}, 15000)
