/**
 * 开发用试验云（内存版）—— ④ 层两端对拷验收。
 *
 * 同时说两种方言（core/sync/store.ts 的两个后端都能连）：
 *   WebDAV：MKCOL · PROPFIND depth:1 · GET · PUT        —— PC/node 侧用
 *   Supabase Storage：bucket 检查 · object/list（分页）· object GET/POST
 *      —— ★ Android 侧只能用它：CapacitorHttp 的原生层（HttpURLConnection）
 *        不认 PROPFIND/MKCOL 这类自定方法。D-201 本来就 Supabase 默认。
 *
 * 两方言共用同一张 Map，键 = `<bucket>/<路径>` —— 一份数据两个门。
 * 不落盘：进程一停数据就没 —— 它是试验场，不是云。
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8722)
const files = new Map() // '<bucket>/<path>' -> body；目录 'dir:' 前缀（仅 dav 用）

const nFiles = () => [...files.keys()].filter((k) => !k.startsWith('dir:')).length
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a)

const srv = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').replace(/\/+$/, '').split('?')[0])

  // ── Supabase 方言 ─────────────────────────────────────────
  if (path.startsWith('storage/v1/bucket/')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    return
  }
  if (req.method === 'POST' && path.startsWith('storage/v1/object/list/')) {
    const bucket = path.slice('storage/v1/object/list/'.length)
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const q = JSON.parse(body || '{}')
      const prefix = `${bucket}/${q.prefix ?? ''}`.replace(/\/+$/, '/')
      const names = [...files.keys()]
        .filter((k) => !k.startsWith('dir:') && k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort()
      const page = names.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 1000))
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(page.map((name) => ({ name }))))
    })
    return
  }
  if (path.startsWith('storage/v1/object/')) {
    const rest = path.slice('storage/v1/object/'.length) // '<bucket>/<path>'
    if (req.method === 'GET') {
      const b = files.get(rest)
      if (b === undefined) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ statusCode: '404', error: 'not found', code: 'NoSuchKey' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(b)
      return
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        files.set(rest, body)
        log(`SUPA PUT ${rest} (${body.length}B) · 共 ${nFiles()}`)
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
      return
    }
  }

  // ── WebDAV 方言 ───────────────────────────────────────────
  if (req.method === 'MKCOL') {
    const had = files.has(`dir:${path}`)
    files.set(`dir:${path}`, '')
    res.writeHead(had ? 405 : 201).end()
    return
  }
  if (req.method === 'PROPFIND') {
    const kids = [...files.keys()].filter(
      (k) => !k.startsWith('dir:') && k.startsWith(path ? `${path}/` : '')
    )
    res
      .writeHead(207, { 'content-type': 'application/xml' })
      .end(
        `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${kids
          .map((k) => `<D:response><D:href>/${k}</D:href></D:response>`)
          .join('')}</D:multistatus>`
      )
    return
  }
  if (req.method === 'GET') {
    const b = files.get(path)
    if (b === undefined) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(b)
    return
  }
  if (req.method === 'PUT') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      files.set(path, body)
      log(`DAV PUT ${path} (${body.length}B) · 共 ${nFiles()}`)
      res.writeHead(201).end()
    })
    return
  }
  res.writeHead(405).end()
})

srv.listen(PORT, '127.0.0.1', () => {
  log(`dev-cloud 听着 http://127.0.0.1:${PORT}/ （dav + supabase 双方言）`)
})
