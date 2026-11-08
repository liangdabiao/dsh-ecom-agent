// ============================================================================
// 亚马逊运营 Agent 工具箱 · Host 半边。
// 15 个工具（市场调研 5 / 商品采集与生图 4 / 广告报表 2 / 领星 2 / 知识库 1 / 图列表 1）
// + 11 套方法论技能快照（knowledge/skills/）+ 硬规则系统提示注入 + 面板数据面。
// 移植自 amazon-ecom-agent（AGPL-3.0）；思考循环不移植——dsh 本身就是 agent harness。
// ============================================================================
import Schema from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { runtimeConfig } from './paths.js'
import { resolveConfig, maskSettings, saveSettings, clearSettings, getSettings } from '../lib/settings.js'
import { systemSection } from './systemPrompt.js'
import { registerApi } from '../lib/api.js'
import { createSkillProvider } from '../lib/skills.js'
import * as market from '../lib/market/market.js'
import { analyzeAdsReport } from '../lib/ads.js'
import { knowledgeSearch } from '../lib/knowledge.js'
import { scrapeProduct, downloadImages } from '../lib/scrape.js'
import * as imagegen from '../lib/imagegen.js'
import * as lingxing from '../lib/lingxing.js'

export const name = 'ecom-agent' // = cordis.patch.yml 的 id

export const inject = ['tools', 'skills', 'systemPrompt', 'webServer', 'connection']

export const Config = Schema.object({
  sorftimeKey: Schema.string().default('').description('Sorftime key（市场调研数据源）'),
  sellerspriteKey: Schema.string().default('').description('卖家精灵 key（无 Sorftime 时自动降级）'),
  imageBaseUrl: Schema.string().default('').description('生图中转地址（需 gpt-image 权限）'),
  imageApiKey: Schema.string().default('').description('生图中转 key（敏感）'),
  lingxingHost: Schema.string().default('').description('领星 ERP 地址'),
  lingxingAppId: Schema.string().default('').description('领星 AppId'),
  lingxingAppSecret: Schema.string().default('').description('领星 AppSecret（敏感）'),
  defaultMarket: Schema.string().default('US').description('默认站点代码'),
  injectRules: Schema.boolean().default(true).description('注入亚马逊运营硬规则到系统提示'),
})

const configRef = { base: Config, rt: runtimeConfig(Config) }
// 每次 execute 实时合并：面板 settings.json 非空字段覆盖 Config（保存后立即生效，无需重启）
const liveCfg = () => resolveConfig(configRef.base)
const liveRt = () => runtimeConfig(liveCfg())

// 手写参数校验（原生注册工具 dsh 不代验）
function check(args, spec) {
  const problems = []
  for (const key of spec.required || []) {
    if (args?.[key] === undefined) problems.push(`缺少必填参数 ${key}`)
  }
  for (const [key, rule] of Object.entries(spec.properties || {})) {
    const value = args?.[key]
    if (value === undefined) continue
    if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} 只能是 ${rule.enum.join(' / ')} 之一`)
  }
  for (const key of Object.keys(args || {})) {
    if (!spec.properties || !(key in spec.properties)) problems.push(`未知参数 ${key}`)
  }
  if (problems.length) throw new Error(`参数有误：${problems.join('；')}。`)
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的回执' },
      data: { type: 'string', description: '结构化结果（JSON/表格文本）' },
    },
  },
  render: (_args, value) => text(value.data ? `${value.summary}\n\n${value.data}` : value.summary),
}

const result = (ok, summary, data = '') => ({ ok, summary, data })

// 报表文件定位：reportsDir 下按名字找（不带扩展名时补 .xlsx）
function resolveReport(rt, file_name) {
  let path = join(rt.reportsDir, file_name)
  if (!existsSafe(path)) {
    const lower = String(file_name).toLowerCase()
    const withExt = lower.endsWith('.xlsx') || lower.endsWith('.csv') ? file_name : file_name + '.xlsx'
    path = join(rt.reportsDir, withExt)
  }
  return existsSafe(path) ? path : null
}
function existsSafe(p) { try { require0(p); return true } catch { return false } }
import { statSync as _statSync } from 'node:fs'
function require0(p) { _statSync(p) }

// ── 市场调研（5 个，需 Sorftime/卖家精灵 key）────────────────────────────
const mkts = str('站点代码 US/UK/DE/JP/FR/IT/ES/CA 等，默认 US')

export const researchKeywordTool = {
  name: 'ecom_research_keyword',
  description: '关键词市场调研：搜索量、趋势、拓展词、竞品、类目报告（10 项数据一次采集）。适合「帮我调研 XX 关键词/市场」。需配置 Sorftime 或卖家精灵 key。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['keyword'],
    properties: { keyword: str('调研的关键词（如 "yoga mat"）'), marketplace: mkts },
  },
  timeoutMs: 200_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const out = await market.researchKeyword(liveRt(), args.keyword, args.marketplace || liveCfg().defaultMarket)
    return result(true, `关键词调研完成（来源 ${out.source}）。数据已按预算压缩，直接按系统提示词方法论分析。`, out.body)
  },
}

export const researchAsinTool = {
  name: 'ecom_research_asin',
  description: 'ASIN 深度调研：商品详情、销量趋势、流量词、评论、变体、竞品关键词、类目 top100。适合「分析这个 ASIN / 这个竞品」。需配置数据源 key。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['asin'],
    properties: { asin: str('10 位亚马逊 ASIN'), marketplace: mkts },
  },
  timeoutMs: 200_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const out = await market.researchAsin(liveRt(), args.asin, args.marketplace || liveCfg().defaultMarket)
    return result(true, `ASIN 调研完成（来源 ${out.source}）。`, out.body)
  },
}

export const keywordCompetitionTool = {
  name: 'ecom_keyword_competition',
  description: '关键词竞争分析（轻量 4 项）：详情、12 个月趋势、拓展词、搜索结果页。比全量调研快，适合快速判断一个词能不能做。需 Sorftime key。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['keyword'],
    properties: { keyword: str('关键词'), marketplace: mkts },
  },
  timeoutMs: 120_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const out = await market.keywordCompetition(liveRt(), args.keyword, args.marketplace || liveCfg().defaultMarket)
    return result(true, '关键词竞争数据完成。', out.body)
  },
}

export const competitorReverseTool = {
  name: 'ecom_competitor_reverse',
  description: '竞品反查：一个 ASIN 的流量关键词 + 竞品共用词 + 商品详情。回答「这个竞品的流量词怎么构成」。需 Sorftime key。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['asin'],
    properties: { asin: str('竞品 ASIN'), marketplace: mkts },
  },
  timeoutMs: 120_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const out = await market.competitorReverse(liveRt(), args.asin, args.marketplace || liveCfg().defaultMarket)
    return result(true, '竞品反查数据完成。', out.body)
  },
}

export const trafficDiagnosisTool = {
  name: 'ecom_traffic_diagnosis',
  description: '流量异动诊断：流量词 + 销量/流量趋势 + 商品详情。回答「这个 ASIN 最近流量为什么涨/跌」。需 Sorftime key。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['asin'],
    properties: { asin: str('ASIN'), marketplace: mkts },
  },
  timeoutMs: 120_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const out = await market.trafficDiagnosis(liveRt(), args.asin, args.marketplace || liveCfg().defaultMarket)
    return result(true, '流量诊断数据完成。', out.body)
  },
}

// ── 商品采集（1 个，零 key，三级反爬链）──────────────────────────────────
export const scrapeProductTool = {
  name: 'ecom_scrape_product',
  description: '采集 Amazon 商品页：标题、五点描述、全套主图（自动下载到本地供生图参考）。采集链：本机直连 → 本机浏览器渲染 → Sorftime 兜底。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['asin'],
    properties: { asin: str('10 位 ASIN'), marketplace: mkts },
  },
  timeoutMs: 180_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const rt = liveRt()
    const mkt = args.marketplace || liveCfg().defaultMarket
    const data = await scrapeProduct(rt, args.asin, mkt)
    if (!data) {
      return result(false, `采集失败：${args.asin} 三级采集链（直连/浏览器渲染/数据源兜底）都没拿到页面。` +
        '亚马逊反爬或网络不可达——请用户换网络重试，或直接粘贴 Listing 文案。')
    }
    const local = data.imageUrls?.length ? await downloadImages(rt, data.imageUrls, args.asin) : []
    return result(true,
      `采集完成（来源 ${data.scrape_source || 'none'}）：${data.title?.slice(0, 80) || '(无标题)'}，${data.bullets?.length || 0} 条五点，${data.imageUrls?.length || 0} 张图${local.length ? `（已下载 ${local.length} 张作生图参考）` : ''}。` +
      (local.length ? '生成主图时把第一个本地图作为参考图。' : ''),
      JSON.stringify({ asin: args.asin, title: data.title, bullets: data.bullets, image_urls: data.imageUrls, local_images: local, scrape_source: data.scrape_source || 'none' }, null, 1))
  },
}

// ── 生图（3 个，需生图中转 key）──────────────────────────────────────────
export const generateImageTool = {
  name: 'agent_generate_image',
  description: 'AI 生成电商图片（主图/A+图/场景图）。有参考图时严格保持产品一致。需配置生图中转 key。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['prompt'],
    properties: {
      prompt: str('画面描述（英文效果更好）：场景、构图、光线、图上要出现的文字'),
      size: str('目标尺寸 "宽x高"，如 1024x1024（主图）、1600x1600（画廊图）、1464x600（A+）'),
      reference_image: str('参考图本地路径（如采集到的产品白底图），可选'),
      presence: str('产品出场：supporting=产品为主角 / environmental=产品小、场景为主', { enum: ['supporting', 'environmental'] }),
    },
  },
  timeoutMs: 600_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const out = await imagegen.generateImage(liveRt(), args.prompt, args.size || '1024x1024', args.reference_image || '', args.presence || 'supporting')
    return result(true, `图片已生成：${out.file}（${out.size}）。用户可在侧栏面板「图库」回看。`)
  },
}

export const generateImageSetTool = {
  name: 'ecom_generate_image_set',
  description: '整套图顺序生成（Listing 7 图 / A+）。传入分镜 JSON 数组，逐张生成、单张失败不中断。用同一张白底参考图保证产品一致。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['shots_json'],
    properties: {
      shots_json: str('分镜数组 JSON，每项 {"name":"卖点图","prompt":"英文画面描述","size":"1600x1600","presence":"supporting","reference_image":"可选"}，最多 9 张'),
      default_reference: str('全套共用的产品白底参考图路径，可选'),
    },
  },
  timeoutMs: 600_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    let shots
    try { shots = JSON.parse(args.shots_json) } catch (e) { return result(false, `shots_json 不是合法 JSON: ${e.message}`) }
    if (!Array.isArray(shots) || shots.length === 0) return result(false, 'shots_json 必须是非空数组')
    const results = await imagegen.generateImageSet(liveRt(), shots, args.default_reference || '')
    const ok = results.filter((r) => r.ok).length
    return result(true, `${ok}/${results.length} 张成功${ok < results.length ? '（失败项见明细，可单独重生成）' : ''}。用户可在侧栏「图库」回看。`,
      JSON.stringify(results.map(({ name, ok: o, file, error }) => ({ name, ok: o, file, error })), null, 1))
  },
}

export const translateImageTool = {
  name: 'ecom_translate_image',
  description: '图片翻译：图上文字译成目标语言，版式/产品/配色完全不变。用于一套图铺多站点。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['image_path', 'target_language'],
    properties: {
      image_path: str('源图路径（本地路径或采集返回的图片路径）'),
      target_language: str('目标语言，如 German / French / Japanese / Spanish'),
    },
  },
  timeoutMs: 600_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const out = await imagegen.translateImage(liveRt(), args.image_path, args.target_language)
    return result(true, `翻译完成：${out.file}。`)
  },
}

export const listImagesTool = {
  name: 'ecom_list_images',
  description: '列出已生成的所有图片文件（供用户回看/作参考图）。零依赖。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  timeoutMs: 10_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const files = imagegen.listGeneratedImages(liveRt())
    if (files.length === 0) return result(true, '还没有生成过图片。这不是错误：用 agent_generate_image 或整套图工具生成后这里就有了。')
    return result(true, `共 ${files.length} 张（最近 30 张内）：`, files.map((f) => f.file).join('\n'))
  },
}

// ── 广告报表（2 个，零 key 确定性解析）──────────────────────────────────
export const listReportsTool = {
  name: 'ecom_list_reports',
  description: '列出已保存的广告报表文件（xlsx/csv）。用户把亚马逊搜索词报表放到插件数据目录 reports/ 下后，先用本工具看有哪些。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  timeoutMs: 10_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const rt = liveRt()
    const files = listReports(rt)
    if (files.length === 0) {
      return result(true, `reports 目录（${rt.reportsDir}）为空。请用户把亚马逊广告搜索词报表（xlsx/csv）放到该目录后重试。这不是错误。`)
    }
    return result(true, `共 ${files.length} 份报表：`, files.map((f) => `${f.file}（${f.size_kb} KB）`).join('\n'))
  },
}

import { readdirSync } from 'node:fs'
function listReports(rt) {
  try {
    return readdirSync(rt.reportsDir)
      .filter((f) => /\.(xlsx|xlsm|csv)$/i.test(f))
      .map((f) => {
        const st = _statSync(join(rt.reportsDir, f))
        return { file: f, path: join(rt.reportsDir, f), size_kb: Math.round(st.size / 102.4) / 10 }
      })
  } catch { return [] }
}

export const analyzeAdsTool = {
  name: 'ecom_analyze_ads_report',
  description: '确定性解析一份广告搜索词报表（xlsx/csv）：总消耗/ACOS/CTR/CVR、每个 Campaign 效率对比、烧钱无单搜索词 Top30、出单词 Top30。**算数不经过大模型**。拿到数据后按系统提示词的阈值（否词 15 点击 0 单、目标 ACOS=0.7×毛利、调幅 ≤20%）出结论。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['file_name'],
    properties: { file_name: str('报表文件名（ecom_list_reports 列出的名字）') },
  },
  timeoutMs: 60_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const rt = liveRt()
    const path = resolveReport(rt, args.file_name)
    if (!path) return result(false, `找不到报表 ${args.file_name}。请先用 ecom_list_reports 查看可用文件。`)
    const resultData = await analyzeAdsReport(path, args.file_name)
    const t = resultData.total
    const summary = `「${args.file_name}」聚合完成：${t.term_rows} 行、总花费 ${t.spend}、ACOS ${t.acos}、CVR ${t.cvr}；烧钱无单词 ${resultData.top_wasted_terms.length} 个、出单词 ${resultData.top_performing_terms.length} 个。按系统提示词广告阈值出诊断。`
    return result(true, summary, JSON.stringify(resultData, null, 1))
  },
}

// ── 领星 ERP（2 个，严格只读，需三凭证）─────────────────────────────────
const LX_NOT_CONFIGURED = '领星未配置：插件 → dsh-ecom-agent → Configuration 填 lingxingHost / lingxingAppId / lingxingAppSecret'
const LX_ROUTES = '常用只读路由（GET）：/erp/sc/data/seller/lists（店铺）、/erp/sc/data/mws/orderV2（订单 sdate/edate）、/erp/sc/data/sales/report（销量 sid+sdate/edate）、/erp/sc/statistics/ads（广告）、/erp/sc/data/storage/list（库存）'

export const lingxingSellersTool = {
  name: 'ecom_lingxing_sellers',
  description: '列出领星 ERP 里授权的亚马逊店铺（返回的 sid 是后续店铺级查询的参数）。严格只读。需配置领星三凭证。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  timeoutMs: 90_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const rt = liveRt()
    if (!lingxing.isConfigured(rt)) return result(false, LX_NOT_CONFIGURED)
    try {
      const data = await lingxing.callRead(rt, '/erp/sc/data/seller/lists', {})
      return result(true, '已获取授权店铺列表：', JSON.stringify(data, null, 1).slice(0, 8000))
    } catch (err) {
      return result(false, `领星查询失败: ${err.message}`)
    }
  },
}

export const lingxingQueryTool = {
  name: 'ecom_lingxing_query',
  description: `查询领星 ERP 真实经营数据（严格只读，写路由直接拒绝）。返回原始 JSON，超 40000 字符截断。${LX_ROUTES}`,
  parameters: {
    type: 'object', additionalProperties: false, required: ['route'],
    properties: {
      route: str('领星 OpenAPI 路由，如 /erp/sc/data/sales/report'),
      params_json: str('查询参数 JSON，如 {"sdate":"2026-10-01","edate":"2026-10-20","sid":"123"}'),
    },
  },
  timeoutMs: 90_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const rt = liveRt()
    if (!lingxing.isConfigured(rt)) return result(false, LX_NOT_CONFIGURED)
    let params = {}
    if (args.params_json) {
      try { params = JSON.parse(args.params_json) } catch (e) { return result(false, `params_json 不是合法 JSON: ${e.message}`) }
    }
    try {
      const data = await lingxing.callRead(rt, args.route, params)
      let body = JSON.stringify(data, null, 1)
      if (body.length > 40_000) body = body.slice(0, 40_000) + '\n…(截断)'
      return result(true, '领星查询完成（只读）：', body)
    } catch (err) {
      return result(false, `领星查询失败: ${err.message}`)
    }
  },
}

// ── 知识库（1 个，零 key 本地检索）───────────────────────────────────────
export const knowledgeSearchTool = {
  name: 'ecom_knowledge_search',
  description: '检索随包知识库（86 篇亚马逊运营 markdown：政策/费用/FBA/Listing 规则/广告/SP-API 等）。回答事实性问题前先查这里，引用标注 [K: 来源文件名]。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['query'],
    properties: { query: str('问题关键词，如 "FBA fees" / "跟卖政策" / "标题字符限制"') },
  },
  timeoutMs: 15_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const out = knowledgeSearch(liveRt().knowledgeDir, args.query)
    if (out.empty) return result(true, `知识库里没有找到与「${args.query}」相关的内容。这不是错误：换关键词（如英文术语）再试，或按已有知识回答并注明未检索到。`)
    if (out.tooShort) return result(true, '查询词太短，请给出更具体的关键词。')
    return result(true, `检索到 ${out.results.length} 个相关片段（按相关度排序）：`,
      JSON.stringify(out.results, null, 1))
  },
}

// ── 注册 ────────────────────────────────────────────────────────────────
const TOOLS = [
  researchKeywordTool, researchAsinTool, keywordCompetitionTool, competitorReverseTool, trafficDiagnosisTool,
  scrapeProductTool, generateImageTool, generateImageSetTool, translateImageTool, listImagesTool,
  listReportsTool, analyzeAdsTool,
  lingxingSellersTool, lingxingQueryTool,
  knowledgeSearchTool,
]

export function apply(ctx, config) {
  const rt = runtimeConfig(config)
  configRef.base = config
  configRef.rt = rt

  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider([join(rt.knowledgeDir, 'skills')])), `${name}: skills`)

  for (const tool of TOOLS) ctx.tools.register(tool)

  if (config.injectRules !== false) {
    ctx.effect(() => ctx.systemPrompt.section(systemSection()), `${name}: rules`)
  }

  ctx.effect(() => registerApi(ctx, rt), `${name}: routes`)
}

// 供测试
export { TOOLS }
