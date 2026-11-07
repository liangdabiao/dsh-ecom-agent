// 广告报表工具：解析 SP 搜索词报表（xlsx/csv）→ 确定性聚合。
// 移植自 amazon-ecom-agent 的 server/tools/ads.py（AGPL-3.0）。
// 原则与原实现一致：**工具管读表和算数（不能错），诊断结论由 agent 按系统提示词阈值产出。**
import ExcelJS from 'exceljs'
import { readFileSync } from 'node:fs'

// 报表列名 → 规范字段（亚马逊搜索词报表的中英文表头都覆盖）
const COLUMN_ALIASES = {
  campaign: ['campaign', 'campaign name', '广告活动', '广告活动名称', '推广活动'],
  ad_group: ['ad group', 'ad group name', '广告组', '广告组名称'],
  term: ['customer search term', 'search term', 'search terms', '搜索词', '客户搜索词', '关键词'],
  match_type: ['match type', '匹配类型'],
  impressions: ['impressions', '展示量', '曝光量'],
  clicks: ['clicks', '点击量', '点击次数'],
  ctr: ['ctr', '点击率'],
  cpc: ['cpc', 'cost per click', '平均点击费用'],
  spend: ['spend', 'cost', '花费', '总花费'],
  orders: ['7 day total orders', 'orders', 'total orders', '订单量', '7天总订单数', '订单数'],
  sales: ['7 day total sales', 'sales', 'total sales', '销售额', '7天总销售额'],
  acos: ['acos', '广告投入产出比'],
}

function toNum(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = parseFloat(String(v).replace(/[, $]/g, '').replace('%', ''))
  return Number.isFinite(n) ? n : 0
}

export function matchColumns(headers) {
  const norm = headers.map((h) => String(h ?? '').trim().toLowerCase())
  const out = {}
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      for (let i = 0; i < norm.length; i++) {
        const low = norm[i]
        if (low === alias || (alias && low.includes(alias) && alias.length >= 4)) {
          if (!(field in out)) out[field] = headers[i]
          break
        }
      }
      if (field in out) break
    }
  }
  return out
}

/** 读 xlsx/csv → { headers, rows }。xlsx 走流式读防大表爆内存。 */
export async function readRows(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    const wb = new ExcelJS.Workbook()
    // exceljs 流式读：readFile 整载对小中表即可；大表可换 stream。data_only 等价于取公式计算值。
    await wb.xlsx.readFile(path)
    const ws = wb.worksheets[0]
    if (!ws) throw new Error('工作表为空')
    let headers = []
    const rows = []
    let headerDone = false
    ws.eachRow((row, rowNum) => {
      const values = []
      row.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = cell.value })
      const maxCol = values.length
      if (!headerDone) {
        for (let i = 0; i < maxCol; i++) headers.push(String(values[i] ?? ''))
        headerDone = true
        return
      }
      if (values.every((c) => c === null || c === undefined || String(c).trim() === '')) return
      const obj = {}
      for (let i = 0; i < headers.length; i++) obj[headers[i]] = i >= values.length || values[i] === null || values[i] === undefined ? '' : values[i]
      rows.push(obj)
    })
    return { headers, rows }
  }
  if (lower.endsWith('.csv')) {
    const raw = readFileSync(path)
    let text = raw.toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // utf-8-sig
    const { headers, rows } = parseCsv(text)
    return { headers, rows }
  }
  throw new Error(`不支持的报表格式: ${path.slice(path.lastIndexOf('.'))}（支持 xlsx / csv）`)
}

/** CSV 解析（支持引号字段与 , \t ; 分隔符探测，对齐原实现的 csv.Sniffer；自动剥 BOM） */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const sample = text.slice(0, 4096)
  const candidates = [',', '\t', ';']
  let delimiter = ','
  let best = -1
  for (const d of candidates) {
    const count = sample.split(d).length - 1
    if (count > best) { best = count; delimiter = d }
  }
  const rows = []
  let cur = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === delimiter) { cur.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      cur.push(field); field = ''
      if (cur.some((c) => String(c).trim() !== '')) rows.push(cur)
      cur = []
    } else field += ch
  }
  if (field !== '' || cur.length) { cur.push(field); if (cur.some((c) => String(c).trim() !== '')) rows.push(cur) }
  if (rows.length === 0) return { headers: [], rows: [] }
  const headers = rows[0].map((h) => String(h ?? '').replace(/\r$/, ''))
  return {
    headers,
    rows: rows.slice(1).map((r) => {
      const obj = {}
      for (let i = 0; i < headers.length; i++) obj[headers[i]] = i < r.length ? r[i] : ''
      return obj
    }),
  }
}

const ratio = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : a > 0 ? 'N/A' : '0.0%')
const round2 = (v) => Math.round(v * 100) / 100

export function aggregate(headers, rows, col) {
  const total = { impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0 }
  const campaigns = new Map()
  const terms = []
  const get = (r, f) => (f in col ? toNum(r[col[f]]) : 0)

  for (const r of rows) {
    const rec = {}
    for (const f of Object.keys(total)) rec[f] = get(r, f)
    for (const k of Object.keys(total)) total[k] += rec[k]
    const camp = 'campaign' in col ? String(r[col.campaign] ?? '(未知活动)') : '(未知活动)'
    if (!campaigns.has(camp)) campaigns.set(camp, { impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0, terms: 0 })
    const slot = campaigns.get(camp)
    for (const k of Object.keys(total)) slot[k] += rec[k]
    slot.terms++
    if ('term' in col) {
      terms.push({
        campaign: camp,
        term: String(r[col.term] ?? '').slice(0, 100),
        match: String(r[col.match_type ?? ''] ?? ''),
        impressions: Math.round(rec.impressions),
        clicks: Math.round(rec.clicks),
        spend: round2(rec.spend),
        orders: Math.round(rec.orders),
        sales: round2(rec.sales),
      })
    }
  }

  const campaignStats = [...campaigns.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .map(([name, s]) => ({
      campaign: name,
      spend: round2(s.spend),
      clicks: Math.round(s.clicks),
      orders: Math.round(s.orders),
      sales: round2(s.sales),
      acos: ratio(s.spend, s.sales),
      cvr: ratio(s.orders, s.clicks),
      cost_per_order: s.orders ? round2(s.spend / s.orders) : null,
    }))

  terms.sort((a, b) => b.spend - a.spend)
  const wasted = terms.filter((t) => t.spend > 0 && t.orders === 0) // 烧钱无单放最前——诊断最需要
  const performing = terms.filter((t) => t.orders > 0)

  return {
    total: {
      impressions: Math.round(total.impressions),
      clicks: Math.round(total.clicks),
      spend: round2(total.spend),
      orders: Math.round(total.orders),
      sales: round2(total.sales),
      acos: ratio(total.spend, total.sales),
      ctr: ratio(total.clicks, total.impressions),
      cvr: ratio(total.orders, total.clicks),
      term_rows: rows.length,
    },
    campaigns: campaignStats,
    top_wasted_terms: wasted.slice(0, 30),
    top_performing_terms: performing.slice(0, 30),
  }
}

export async function analyzeAdsReport(path, fileName) {
  const { headers, rows } = await readRows(path)
  const col = matchColumns(headers)
  const missing = ['campaign', 'spend', 'clicks'].filter((f) => !(f in col))
  if (missing.length) {
    throw new Error(`报表 ${fileName} 缺少关键列（${missing.join(', ')}）。\n识别到的表头：${headers.slice(0, 20).join(' | ')}`)
  }
  const result = aggregate(headers, rows, col)
  result.file = fileName
  result.matched_columns = col
  return result
}
