// 卖家精灵 MCP 客户端 + 管线（Sorftime 的降级数据源）。
// 移植自 amazon-ecom-agent 的 server/legacy/sellersprite.py（AGPL-3.0）。
// 响应与 Sorftime 同构：POST JSON-RPC → SSE data: {...}；工具载荷 {"code":"OK","data":...}。
import { setTimeout as sleep } from 'node:timers/promises'
void sleep

const BASE = 'https://mcp.sellersprite.com/mcp'
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
const TOOL_TIMEOUT_MS = 40_000

export class SellerspriteError extends Error {}

function url(config) {
  if (!config?.sellerspriteKey) {
    throw new SellerspriteError('卖家精灵 key 未配置：插件 → dsh-ecom-agent → Configuration 填入 sellerspriteKey')
  }
  return `${BASE}?secret-key=${config.sellerspriteKey}`
}

/** 最近一个完整月 yyyyMM（卖家精灵数据滞后约 1 个月） */
export function recentMonth() {
  const now = new Date()
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  const y = last.getFullYear()
  const m = String(last.getMonth() + 1).padStart(2, '0')
  return `${y}${m}`
}

function parseSse(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) {
      const raw = trimmed.slice(5).trim()
      if (raw) {
        try { return JSON.parse(raw) } catch { /* 继续 */ }
      }
    }
  }
  try { return JSON.parse(text) } catch { return {} }
}

async function callTool(config, name, args, callId, fetchImpl) {
  const res = await fetchImpl(url(config), {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  })
  const body = parseSse(await res.text())
  if (body.error) throw new SellerspriteError(`${name}: ${JSON.stringify(body.error).slice(0, 200)}`)
  const result = body.result || {}
  const content = result.content || []
  const text = content.length && typeof content[0] === 'object' ? content[0].text || '' : ''
  if (result.isError) throw new SellerspriteError(`${name}: ${(text || '工具返回错误').slice(0, 200)}`)
  let parsed
  try { parsed = text ? JSON.parse(text) : {} } catch { return { _raw: String(text).slice(0, 4000) } }
  const code = String(parsed.code ?? '')
  if (code && code !== 'OK') throw new SellerspriteError(`${name} ${code}: ${parsed.message || ''}`)
  return parsed.data ?? parsed
}

async function runSteps(config, steps, fetchImpl) {
  const data = {}
  const errors = []
  try {
    await fetchImpl(url(config), {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-ecom-agent', version: '1.0' } } }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch { /* 旁路 */ }
  let callId = 1
  for (const [label, name, args] of steps) {
    try {
      data[label] = await callTool(config, name, args, callId++, fetchImpl)
    } catch (err) {
      errors.push(`${label}: ${err.message}`) // 单步失败不中断整条管线
    }
  }
  return { data, errors }
}

export function keywordPipeline(config, query, marketplace, fetchImpl) {
  const month = recentMonth()
  return runSteps(config, [
    ['关键词搜索/购买趋势', 'keyword_research_trends', { marketplace, keyword: query, month }],
    ['ABA 排名趋势', 'aba_research_trend', { marketplace, keyword: query, timeGranularity: 'month' }],
  ], fetchImpl)
}

export function asinPipeline(config, asin, marketplace, fetchImpl) {
  const month = recentMonth()
  return runSteps(config, [
    ['商品详情', 'asin_detail', { marketplace, asin }],
    ['销量趋势', 'asin_sales_trend', { marketplace, asin }],
    ['流量关键词概览', 'traffic_keyword_stat', { marketplace, asin, month }],
  ], fetchImpl)
}
