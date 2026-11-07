// 市场调研工具逻辑：5 条管线 + 数据源选择 + 预算内渲染（工具与面板共用）。
// 移植自 amazon-ecom-agent 的 server/tools/market.py（AGPL-3.0）。
import * as sorftime from './sorftime.js'
import * as sellersprite from './sellersprite.js'

export const DEFAULT_BUDGET = 42_000

export function pickSource(config) {
  if (config?.sorftimeKey) return 'sorftime'
  if (config?.sellerspriteKey) return 'sellersprite'
  throw new sorftime.SorftimeError('市场数据源未配置：请在插件 Configuration 填 sorftimeKey 或 sellerspriteKey（至少一个）')
}

function render(data, errors, budget = DEFAULT_BUDGET) {
  const parts = [sorftime.summarizeForPrompt(sorftime.compactAll(data), budget)]
  if (errors?.length) {
    parts.push('\n\n[以下数据源本次获取失败，分析时请如实说明数据缺口]\n- ' + errors.join('\n- '))
  }
  return parts.join('\n')
}

export async function researchKeyword(config, keyword, marketplace = 'US', fetchImpl) {
  const source = pickSource(config)
  if (source === 'sellersprite') {
    const { data, errors } = await sellersprite.keywordPipeline(config, keyword, marketplace, fetchImpl)
    let body = JSON.stringify(data, null, 2)
    if (body.length > 30_000) body = body.slice(0, 30_000) + '\n…(截断)'
    return { source, keyword, marketplace, body: `# 关键词调研原始数据：${keyword}（${marketplace}，来源 ${source}）\n\n${body}\n${errors.length ? '\n[数据缺口]\n- ' + errors.join('\n- ') : ''}` }
  }
  const { data, errors } = await sorftime.keywordPipeline(config, keyword, marketplace, fetchImpl)
  return { source, keyword, marketplace, body: `# 关键词调研原始数据：${keyword}（${marketplace}，来源 ${source}）\n\n${render(data, errors)}` }
}

export async function researchAsin(config, asin, marketplace = 'US', fetchImpl) {
  const source = pickSource(config)
  if (source === 'sellersprite') {
    const { data, errors } = await sellersprite.asinPipeline(config, asin, marketplace, fetchImpl)
    let body = JSON.stringify(data, null, 2)
    if (body.length > 30_000) body = body.slice(0, 30_000) + '\n…(截断)'
    return { source, asin, marketplace, body: `# ASIN 调研原始数据：${asin}（${marketplace}，来源 ${source}）\n\n${body}` }
  }
  const { data, errors } = await sorftime.asinPipeline(config, asin, marketplace, fetchImpl)
  return { source, asin, marketplace, body: `# ASIN 调研原始数据：${asin}（${marketplace}，来源 ${source}）\n\n${render(data, errors)}` }
}

export async function keywordCompetition(config, keyword, marketplace = 'US', fetchImpl) {
  const mk = String(marketplace).toUpperCase()
  const { data, errors } = await sorftime.quickCalls(config, [
    ['keyword_detail', { keyword, keyword_support_site: mk }],
    ['keyword_trend', { keyword, keyword_support_site: mk }],
    ['keyword_extends', { keyword, keyword_support_site: mk }],
    ['keyword_search_results', { keyword, keyword_support_site: mk }],
  ], fetchImpl)
  return { body: `# 关键词竞争数据：${keyword}（${marketplace}）\n\n${render(data, errors, 20_000)}` }
}

export async function competitorReverse(config, asin, marketplace = 'US', fetchImpl) {
  const mk = String(marketplace).toUpperCase()
  const { data, errors } = await sorftime.quickCalls(config, [
    ['product_traffic_terms', { asin, amz_site: mk }],
    ['competitor_product_keywords', { asin, keyword_support_site: mk }],
    ['product_detail', { asin, amz_site: mk }],
  ], fetchImpl)
  return { body: `# 竞品反查数据：${asin}（${marketplace}）\n\n${render(data, errors, 20_000)}` }
}

export async function trafficDiagnosis(config, asin, marketplace = 'US', fetchImpl) {
  const mk = String(marketplace).toUpperCase()
  const { data, errors } = await sorftime.quickCalls(config, [
    ['product_traffic_terms', { asin, amz_site: mk }],
    ['product_trend', { asin, amz_site: mk }],
    ['product_detail', { asin, amz_site: mk }],
  ], fetchImpl)
  return { body: `# 流量诊断数据：${asin}（${marketplace}）\n\n${render(data, errors, 20_000)}` }
}
