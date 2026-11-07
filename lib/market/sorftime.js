// Sorftime MCP-over-SSE 客户端 + 两阶段数据管线。
// 移植自 amazon-ecom-agent 的 server/legacy/sorftime.py（AGPL-3.0，IvyeaOps 平移），
// 保留全部踩坑经验：SSE data: 行解析、snake_case 参数（camelCase 被静默忽略）、
// "成功信封包散文"显式拒绝、每行列表截 30、按预算均分压缩、两阶段编排、单工具 30s 超时。
import { setTimeout as sleep } from 'node:timers/promises'
void sleep // 预留：部分部署需要请求间隔

const SORFTIME_BASE = 'https://mcp.sorftime.com'
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
const TOOL_TIMEOUT_MS = 30_000
const CONN_TIMEOUT_MS = 10_000

const ROW_KEYS = ['data', 'items', 'results', 'list', 'top100_products', 'analysis_results']
const NON_DATA_MARKERS = [
  'please specify the site',
  'parameter description in the method signature',
  'authentication required',
  'call the following tools to combine their data',
]

export class SorftimeError extends Error {}

export function requireKey(config) {
  if (!config?.sorftimeKey) {
    throw new SorftimeError('SORFTIME key 未配置：插件 → dsh-ecom-agent → Configuration 填入 sorftimeKey（市场调研工具不可用）')
  }
  return `https://${SORFTIME_BASE.split('//')[1]}?key=${config.sorftimeKey}`
}

const camelRe = /(?<!^)(?=[A-Z])/g
export function normalizeArgs(args = {}) {
  const out = {}
  for (const [k, v] of Object.entries(args)) out[k.replace(camelRe, '_').toLowerCase()] = v
  return out
}

function isNonDataText(text) {
  const low = String(text).trim().toLowerCase()
  return NON_DATA_MARKERS.some((marker) => low.includes(marker))
}

function parseSseBody(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) {
      const raw = trimmed.slice(5).trim()
      if (raw) {
        try { return JSON.parse(raw) } catch { /* 下一个 data: 行 */ }
      }
    }
  }
  return null
}

/** 单次 tools/call（先 initialize 握手——由 ensureInitialized 在管线开始时做一次） */
export async function callTool(url, toolName, args = {}, callId = 1, fetchImpl = fetch) {
  const payload = { jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name: toolName, arguments: normalizeArgs(args) } }
  const res = await fetchImpl(url, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  })
  if (!res.ok) throw new SorftimeError(`sorftime/${toolName}: HTTP ${res.status}`)
  const body = parseSseBody(await res.text())
  if (!body) throw new SorftimeError(`sorftime/${toolName}: SSE 响应解析失败`)
  if (body.error) throw new SorftimeError(`sorftime/${toolName} error: ${JSON.stringify(body.error).slice(0, 300)}`)

  const result = body.result || {}
  if (result.isError) {
    const msg = (result.content || []).find((c) => typeof c === 'object' && c.type === 'text')?.text || 'unknown error'
    throw new SorftimeError(`sorftime/${toolName}: ${msg}`)
  }
  const content = result.content
  if (Array.isArray(content) && content.length) {
    const first = content[0]
    if (typeof first === 'object' && first.type === 'text') {
      try { return JSON.parse(first.text) } catch {
        if (isNonDataText(first.text)) throw new SorftimeError(`sorftime/${toolName}: ${String(first.text).trim().slice(0, 300)}`)
        return first.text
      }
    }
  }
  return result
}

/** MCP initialize 握手（Sorftime 要求先握手再 tools/call）。失败旁路——部分部署不需要。 */
export async function ensureInitialized(url, fetchImpl = fetch) {
  try {
    await fetchImpl(url, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-ecom-agent', version: '1.0' } } }),
      signal: AbortSignal.timeout(CONN_TIMEOUT_MS),
    })
  } catch { /* 旁路 */ }
}

export function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload && payload.doc && typeof payload.doc === 'object') return payload.data
  return payload
}

export function rows(payload) {
  const node = unwrap(payload)
  if (Array.isArray(node)) return node.filter((r) => r && typeof r === 'object')
  if (node && typeof node === 'object') {
    for (const key of ROW_KEYS) {
      const arr = node[key]
      if (Array.isArray(arr)) return arr.filter((r) => r && typeof r === 'object')
    }
  }
  return []
}

export function record(payload) {
  const node = unwrap(payload)
  if (node && typeof node === 'object' && !Array.isArray(node)) return node
  if (Array.isArray(node) && node.length && node[0] && typeof node[0] === 'object') return node[0]
  return {}
}

export function compact(payload, limit = 30) {
  const node = unwrap(payload)
  let trimmed = node
  if (Array.isArray(node) && node.length > limit) trimmed = node.slice(0, limit)
  else if (node && typeof node === 'object') {
    for (const key of ROW_KEYS) {
      const arr = node[key]
      if (Array.isArray(arr) && arr.length > limit) {
        if (trimmed === node) trimmed = { ...node }
        trimmed[key] = arr.slice(0, limit)
      }
    }
  }
  if (trimmed === node) return payload
  if (payload && typeof payload === 'object' && 'data' in payload && payload.doc && typeof payload.doc === 'object') {
    return { ...payload, data: trimmed }
  }
  return trimmed
}

export function compactAll(data, limit = 30) {
  const out = {}
  for (const [name, value] of Object.entries(data || {})) {
    out[name] = name.endsWith('_list') && Array.isArray(value) ? value.map((item) => compact(item, limit)) : compact(value, limit)
  }
  return out
}

/** 把整条管线结果压进 budget 字符且每个来源都在场：均分预算、行数减半稀释循环。 */
export function summarizeForPrompt(data, budget = 45_000) {
  const sources = Object.entries(data || {})
  if (sources.length === 0) return '{}'
  const share = Math.max(Math.floor(budget / sources.length), 800)
  const parts = []
  for (const [name, value] of sources) {
    let limit = 30
    let text = JSON.stringify(value, null, 2)
    while (text.length > share && limit > 1) {
      limit = Math.max(1, Math.floor(limit / 2))
      const trimmed = name.endsWith('_list') && Array.isArray(value)
        ? value.map((v) => compact(v, limit))
        : compact(value, limit)
      text = JSON.stringify(trimmed, null, 2)
    }
    if (text.length > share) text = text.slice(0, share) + '\n…(本项已截断)'
    parts.push(`  "${name}": ${text}`)
  }
  return '{\n' + parts.join(',\n') + '\n}'
}

export function firstField(payload, ...names) {
  for (const src of [record(payload), ...rows(payload).slice(0, 1)]) {
    for (const name of names) {
      const val = src?.[name]
      if (val !== null && val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)) return String(val)
    }
  }
  return ''
}

/** 单工具失败不拖垮管线：返回 [name, data|null, error|null] */
async function safeCall(url, toolName, args, callId, fetchImpl) {
  try {
    const data = await callTool(url, toolName, args, callId, fetchImpl)
    return [toolName, data, null]
  } catch (err) {
    return [toolName, null, `${toolName}: ${err.message}`]
  }
}

async function gather(url, tasks, data, errors, fetchImpl) {
  for (const [name, val, err] of await Promise.all(tasks.map(([n, a, id]) => safeCall(url, n, a, id, fetchImpl)))) {
    if (err) errors.push(err)
    else data[name] = val
  }
}

/** 关键词调研全管线：P1 并发 6 → P2 依赖 P1 的 4 项。返回 {data, errors} */
export async function keywordPipeline(config, keyword, marketplace, fetchImpl = fetch) {
  const url = requireKey(config)
  await ensureInitialized(url, fetchImpl)
  const errors = []
  const data = {}

  await gather(url, [
    ['keyword_detail', { keyword, keyword_support_site: marketplace }, 1],
    ['keyword_trend', { keyword, keyword_support_site: marketplace }, 2],
    ['keyword_extends', { keyword, keyword_support_site: marketplace }, 3],
    ['keyword_search_results', { keyword, keyword_support_site: marketplace }, 4],
    ['category_search_from_product_name', { product_name: keyword, amz_site: marketplace }, 5],
    ['similar_product_feature', { product_name: keyword, amz_site: marketplace }, 6],
  ], data, errors, fetchImpl)

  const topAsins = rows(data.keyword_search_results).slice(0, 2).map((r) => String(r.asin)).filter(Boolean)
  const nodeId = firstField(data.category_search_from_product_name, 'node_id')

  const phase2 = []
  topAsins.slice(0, 2).forEach((asin, i) => phase2.push(['product_detail', { asin, amz_site: marketplace }, 10 + i]))
  phase2.push(['potential_product', { search_name: keyword, amz_site: marketplace }, 12])
  if (nodeId) phase2.push(['category_report', { node_id: nodeId, amz_site: marketplace }, 13])

  const results = await Promise.all(phase2.map(([n, a, id]) => safeCall(url, n, a, id, fetchImpl)))
  for (const [name, val, err] of results) {
    if (err) errors.push(err)
    else if (name === 'product_detail') (data.product_detail_list ||= []).push(val)
    else data[name] = val
  }
  return { data, errors }
}

/** ASIN 调研全管线：P1 并发 5 → P2 4 项（按主流量词补查）。 */
export async function asinPipeline(config, asin, marketplace, fetchImpl = fetch) {
  const url = requireKey(config)
  await ensureInitialized(url, fetchImpl)
  const errors = []
  const data = {}

  await gather(url, [
    ['product_detail', { asin, amz_site: marketplace }, 1],
    ['product_trend', { asin, amz_site: marketplace }, 2],
    ['product_traffic_terms', { asin, amz_site: marketplace }, 3],
    ['product_reviews', { asin, amz_site: marketplace }, 4],
    ['product_variations', { asin, amz_site: marketplace }, 5],
  ], data, errors, fetchImpl)

  const mainKw = firstField(data.product_traffic_terms, 'keyword', 'term', 'search_term')
  const nodeId = firstField(data.product_detail, 'node_id')

  const phase2 = []
  if (mainKw) {
    phase2.push(['keyword_detail', { keyword: mainKw, keyword_support_site: marketplace }, 10])
    phase2.push(['keyword_search_results', { keyword: mainKw, keyword_support_site: marketplace }, 11])
  }
  phase2.push(['competitor_product_keywords', { asin, keyword_support_site: marketplace }, 12])
  if (nodeId) phase2.push(['category_report', { node_id: nodeId, amz_site: marketplace }, 13])

  await gather(url, phase2, data, errors, fetchImpl)
  return { data, errors }
}

/** 一组并发工具调用（轻量组合）。 */
export async function quickCalls(config, calls, fetchImpl = fetch) {
  const url = requireKey(config)
  await ensureInitialized(url, fetchImpl)
  const errors = []
  const data = {}
  await gather(url, calls.map(([n, a], i) => [n, a, i + 1]), data, errors, fetchImpl)
  return { data, errors }
}
