// 面板数据面：/ecom-agent 前缀路由（知识检索/图库/报表诊断/健康）。
// 每请求鉴权三件套（connection.requestRejection + Origin 同源 + sec-fetch-site）。
import { join, extname } from 'node:path'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { knowledgeSearch } from './knowledge.js'
import { analyzeAdsReport } from './ads.js'
import { listGeneratedImages } from './imagegen.js'

const BASE = '/ecom-agent'
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' }

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

function readJson(req, max = 16 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') return reject(Object.assign(new Error('只接受 POST'), { status: 405 }))
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return reject(Object.assign(new Error('要 application/json'), { status: 415 }))
    }
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') {
      return reject(Object.assign(new Error('拒绝跨站请求'), { status: 403 }))
    }
    const origin = req.headers.origin
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
      return reject(Object.assign(new Error('Origin 与 Host 不同源'), { status: 403 }))
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > max) { req.destroy(); return reject(Object.assign(new Error('请求体过大'), { status: 413 })) }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('JSON 解析失败'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

export function registerApi(ctx, rt) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { error: '未授权' })
        const url = new URL(req.url, 'http://x')
        const path = url.pathname.slice(BASE.length) || '/'

        if (path === '/api/health' && req.method === 'GET') {
          return json(res, 200, {
            ok: true,
            sources: {
              sorftime: Boolean(rt.sorftimeKey),
              sellersprite: Boolean(rt.sellerspriteKey),
              image: Boolean(rt.imageBaseUrl && rt.imageApiKey),
              lingxing: Boolean(rt.lingxingHost && rt.lingxingAppId && rt.lingxingAppSecret),
            },
          })
        }
        if (path === '/api/knowledge' && req.method === 'POST') {
          const body = await readJson(req)
          return json(res, 200, knowledgeSearch(rt.knowledgeDir, String(body.query || '')))
        }
        if (path === '/api/images' && req.method === 'GET') {
          const images = listGeneratedImages(rt).map((f) => ({ name: f.name, path: f.file }))
          return json(res, 200, { images })
        }
        if (path === '/api/ads' && req.method === 'POST') {
          const body = await readJson(req)
          const path2 = String(body.path || '')
          if (!existsSync(path2)) return json(res, 400, { error: `报表文件不存在：${path2}` })
          const result = await analyzeAdsReport(path2, body.path || path2)
          return json(res, 200, { ok: true, result })
        }
        // 图库静态伺服：只允许 imagesDir 内的文件（safeFile 语义）
        const rel = path.startsWith('/') ? path.slice(1) : path
        if (rel.startsWith('images/')) {
          const file = join(rt.imagesDir, rel.slice('images/'.length))
          if (existsSync(file) && statSync(file).isFile()) {
            const real = file
            if (real.startsWith(rt.imagesDir)) {
              const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
              res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size, 'cache-control': 'no-cache' })
              if (req.method === 'HEAD') return res.end()
              return createReadStream(file).pipe(res)
            }
          }
        }
        json(res, 404, { error: 'not found' })
      } catch (err) {
        json(res, typeof err?.status === 'number' ? err.status : 500, { error: err?.message || '内部错误' })
      }
    },
  })
}
