// 领星 ERP OpenAPI（严格只读）：MD5→AES-128-ECB 签名、token 缓存、写路由硬闸。
// 移植自 amazon-ecom-agent 的 server/legacy/lingxing_openapi.py（AGPL-3.0）。
import { createHash, createCipheriv } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const TOKEN_PATH_GET = '/api/auth-server/oauth/access-token'
const TOKEN_PATH_REFRESH = '/api/auth-server/oauth/refresh'
const TOKEN_SKEW_S = 120
const REQUEST_TIMEOUT_MS = 60_000

export class LingxingError extends Error {}

const WRITE_VERBS = new Set([
  'put', 'post', 'create', 'add', 'update', 'modify', 'edit', 'save', 'set',
  'delete', 'del', 'remove', 'archive', 'cancel', 'confirm', 'submit',
  'approve', 'reject', 'operate', 'adjust', 'enable', 'disable', 'bind',
  'unbind', 'push', 'sync', 'import', 'upload', 'batch',
])
const WRITE_SEGMENTS = new Set([
  'put', 'create', 'add', 'update', 'modify', 'edit', 'save', 'delete',
  'remove', 'archive', 'cancel', 'operate', 'adjust', 'import', 'upload',
])

/** 路由读写分类（避开 /manage/list 误判写、archiveNegatives 漏判写——历史翻车点） */
export function classifyRoute(route) {
  const r = String(route || '').trim()
  if (!r) return 'unknown'
  const segments = r.split('/').filter(Boolean)
  if (segments.length === 0) return 'unknown'
  for (const s of segments) {
    if (WRITE_SEGMENTS.has(s.toLowerCase())) return 'write'
  }
  const head = /^[a-z]+/.exec(segments[segments.length - 1])
  if (head && WRITE_VERBS.has(head[0])) return 'write'
  return 'read'
}

function filterNull(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out = {}
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) out[k] = filterNull(x)
    return out
  }
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(filterNull)
  return v
}

/** PHP 风格 JSON（无空格、不转义中文） */
function phpJson(v) {
  return JSON.stringify(v) // JSON.stringify 已是无空格 + 保留中文（ensure_ascii=False 等价）
}

/** 签名：参数按 key 排序 → 空值跳过 → k=v& 拼接 → MD5 大写 → appId 为 key 的 AES-128-ECB(PKCS7) → base64 */
export function makeSign(params, appId) {
  if (Buffer.byteLength(String(appId), 'utf8') !== 16) {
    throw new LingxingError(`领星 appId 长度应为 16 字符（AES-128 key），实际 ${String(appId).length}——请核对 Configuration 里的 lingxingAppId`)
  }
  const parts = []
  for (const k of Object.keys(params).sort()) {
    let v = params[k]
    if (v !== null && v !== undefined && typeof v === 'object') {
      parts.push(`${k}=` + phpJson(filterNull(v)))
      continue
    }
    if (v === '') continue
    if (typeof v === 'boolean') v = v ? 'true' : 'false'
    else if (v === null || v === undefined) v = 'null'
    parts.push(`${k}=${v}`)
  }
  const canonical = parts.join('&')
  const md5Upper = createHash('md5').update(canonical, 'utf8').digest('hex').toUpperCase()
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(appId, 'utf8'), null)
  cipher.setAutoPadding(true) // PKCS7
  const ct = Buffer.concat([cipher.update(md5Upper, 'utf8'), cipher.final()])
  return ct.toString('base64')
}

export function isConfigured(config) {
  return Boolean(config?.lingxingHost && config?.lingxingAppId && config?.lingxingAppSecret)
}

function tokenPath(config) {
  return join(config.dataDir, 'lingxing_token.json')
}

function loadToken(config) {
  try { return JSON.parse(readFileSync(tokenPath(config), 'utf8')) } catch { return {} }
}

function saveToken(config, tok) {
  const p = tokenPath(config)
  const tmp = p + '.tmp'
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(tmp, JSON.stringify(tok), 'utf8')
  renameSync(tmp, p)
}

async function fetchToken(config, refreshTk, fetchImpl) {
  const base = config.lingxingHost.replace(/\/$/, '')
  const params = refreshTk
    ? { appId: config.lingxingAppId, refreshToken: refreshTk }
    : { appId: config.lingxingAppId, appSecret: config.lingxingAppSecret }
  const path = refreshTk ? TOKEN_PATH_REFRESH : TOKEN_PATH_GET
  const res = await fetchImpl(`${base}${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(30_000) })
  if (res.status >= 400) throw new LingxingError(`令牌接口 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  let body
  try { body = await res.json() } catch { throw new LingxingError(`令牌响应非 JSON`) }
  if (!['200', '0'].includes(String(body.code))) {
    throw new LingxingError(`令牌接口错误 ${body.code}: ${body.msg || body.message || ''}`)
  }
  const data = body.data || {}
  const at = data.access_token
  if (!at) throw new LingxingError('令牌响应缺少 access_token')
  return { access_token: at, refresh_token: data.refresh_token || '', expire_at: Date.now() / 1000 + Number(data.expires_in || 0) }
}

async function ensureToken(config, fetchImpl) {
  if (!isConfigured(config)) {
    throw new LingxingError('领星未配置：插件 → dsh-ecom-agent → Configuration 填 lingxingHost / lingxingAppId / lingxingAppSecret')
  }
  let tok = loadToken(config)
  const now = Date.now() / 1000
  if (tok.access_token && Number(tok.expire_at || 0) - TOKEN_SKEW_S > now) return tok.access_token
  let fresh = null
  if (tok.refresh_token) {
    try { fresh = await fetchToken(config, tok.refresh_token, fetchImpl) } catch { fresh = null }
  }
  if (!fresh) fresh = await fetchToken(config, null, fetchImpl)
  saveToken(config, fresh)
  return fresh.access_token
}

/** 签名调用（POST 默认）。route 如 /erp/sc/data/seller/lists */
export async function call(config, route, params = {}, { method = 'POST', fetchImpl = fetch } = {}) {
  const access = await ensureToken(config, fetchImpl)
  const base = config.lingxingHost.replace(/\/$/, '')
  const common = { access_token: access, timestamp: Math.floor(Date.now() / 1000), app_key: config.lingxingAppId }
  const full = { ...params, ...common }
  const sign = makeSign(full, config.lingxingAppId)
  const url = `${base}/${String(route).replace(/^\/+/, '')}`
  const headers = { 'Content-Type': 'application/json' }
  let res
  try {
    if (method === 'GET') {
      res = await fetchImpl(`${url}?${new URLSearchParams({ ...full, sign })}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } else {
      res = await fetchImpl(`${url}?${new URLSearchParams(common)}&sign=${encodeURIComponent(sign)}`, {
        method, headers, body: phpJson(full), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    }
  } catch (err) {
    throw new LingxingError(`领星 OpenAPI 连接失败: ${err.message}`)
  }
  if (res.status >= 400) throw new LingxingError(`领星 OpenAPI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  let body
  try { body = await res.json() } catch { throw new LingxingError('领星 OpenAPI 响应非 JSON') }
  const code = String(body.code)
  if (!['200', '0', '1'].includes(code) && body.success !== true) {
    throw new LingxingError(`领星 OpenAPI 业务错误 code=${code} msg=${body.message || body.msg || ''}`)
  }
  return body
}

/** 只读闸内的调用：写路由一律拒绝。本系统对领星只有这一条入口。 */
export async function callRead(config, route, params = {}, fetchImpl) {
  if (classifyRoute(route) !== 'read') {
    throw new LingxingError(`拒绝调用写路由（本系统对领星只读）: ${route}`)
  }
  return call(config, route, params, { method: 'GET', fetchImpl })
}
