// 离线自检：15 工具注册 + 知识库 + 广告聚合 + 面板 API。不依赖 dsh、不花积分、不发网络请求。
// 运行：node scripts/selftest.mjs
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.tmp')
mkdirSync(TMP, { recursive: true })
process.env.DSH_HOME = join(TMP, 'selftest-dsh-home')

const { TOOLS } = await import('../src/host.js')
const { createSkillProvider } = await import('../lib/skills.js')
const { knowledgeSearch } = await import('../lib/knowledge.js')
const { analyzeAdsReport } = await import('../lib/ads.js')

let failed = 0
const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `)
  try {
    await fn()
    console.log('ok')
  } catch (err) {
    failed++
    console.log('失败')
    console.error(`  ${err.message}`)
  }
}

await step('15 个工具注册齐全且命名合规', () => {
  if (TOOLS.length !== 15) throw new Error(`工具数 ${TOOLS.length} ≠ 15`)
  for (const t of TOOLS) {
    if (!/^[a-z][a-z0-9_]*$/.test(t.name)) throw new Error(`工具名不合规：${t.name}`)
    if (typeof t.execute !== 'function') throw new Error(`${t.name} 缺 execute`)
    if (t.parameters.additionalProperties !== false) throw new Error(`${t.name} parameters 缺 additionalProperties:false`)
  }
})

await step('知识库随包（86 篇文档 + 11 套方法论）', () => {
  const kb = join(ROOT, 'knowledge')
  const mdCount = countMd(kb)
  if (mdCount < 100) throw new Error(`知识 md 只有 ${mdCount} 篇`)
  const skillsDir = join(kb, 'skills')
  if (!existsSync(skillsDir)) throw new Error('缺 knowledge/skills/')
  if (!existsSync(join(kb, 'index.json'))) throw new Error('缺 index.json（文档索引）')
})
function countMd(dir) {
  let n = 0
  try {
    for (const e of readdirRecursive(dir)) if (e.endsWith('.md')) n++
  } catch { /* 空 */ }
  return n
}
import { readdirSync } from 'node:fs'
function* readdirRecursive(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* readdirRecursive(p)
    else yield p
  }
}

await step('11 套方法论技能可注册可读取（2 个补壳）', async () => {
  const provider = createSkillProvider([join(ROOT, 'knowledge', 'skills')])
  const candidates = await provider.list()
  if (candidates.length !== 11) throw new Error(`技能数 ${candidates.length} ≠ 11`)
  for (const c of candidates) {
    const skill = await provider.get(c)
    if (!skill.content || skill.content.length < 200) throw new Error(`${c.name} 正文异常`)
  }
  const zach = await provider.get(candidates.find((c) => c.name.includes('zach')))
  if (!zach.content.includes('decision') && !zach.content.includes('规则')) throw new Error('zach 技能应含决策规则')
})

await step('knowledge_search 命中随包知识（真实检索）', () => {
  const out = knowledgeSearch(join(ROOT, 'knowledge'), 'FBA fees')
  if (out.results.length === 0) throw new Error('零命中')
  if (!out.results[0].source.endsWith('.md')) throw new Error('来源格式异常')
})

await step('广告报表确定性聚合（真实 xlsx 文件）', async () => {
  // 用 exceljs 写一份真实 xlsx 再解析
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  ws.addRow(['Campaign', 'Customer Search Term', 'Clicks', 'Spend', '7 Day Total Orders', '7 Day Total Sales'])
  ws.addRow(['C1', 'yoga mat', 20, 10, 3, 60])
  ws.addRow(['C1', 'yoga mat cheap', 15, 9, 0, 0])
  ws.addRow(['C2', 'exercise mat', 30, 12, 5, 90])
  const dir = join(process.env.DSH_HOME, 'reports')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'selftest.xlsx')
  await wb.xlsx.writeFile(file)
  const result = await analyzeAdsReport(file, 'selftest.xlsx')
  if (result.total.term_rows !== 3) throw new Error(`行数 ${result.total.term_rows}`)
  if (result.top_wasted_terms.length !== 1) throw new Error('烧钱无单词应为 1 个')
  if (result.top_wasted_terms[0].term !== 'yoga mat cheap') throw new Error('烧钱词识别错误')
})

await step('面板 API 健康与知识接口（内存 ctx 模拟）', async () => {
  const { registerApi } = await import('../lib/api.js')
  const captured = []
  const fakeRes = {
    writeHead() { return this },
    end(chunk) { captured.push(chunk) },
  }
  const fakeCtx = {
    get: () => ({ requestRejection: () => false }),
    webServer: { register: async ({ handler }) => { globalThis.__handler = handler } },
  }
  const rt = {
    sorftimeKey: '', sellerspriteKey: '', imageBaseUrl: '', imageApiKey: '',
    lingxingHost: '', lingxingAppId: '', lingxingAppSecret: '',
    dataDir: process.env.DSH_HOME, imagesDir: join(process.env.DSH_HOME, 'images'),
    reportsDir: join(process.env.DSH_HOME, 'reports'), knowledgeDir: join(ROOT, 'knowledge'),
  }
  await registerApi(fakeCtx, rt)
  const handler = globalThis.__handler
  if (!handler) throw new Error('路由未注册')
  await handler({ method: 'GET', url: '/ecom-agent/api/health', headers: {} }, fakeRes)
  const health = JSON.parse(captured.at(-1))
  if (health.ok !== true || health.sources.sorftime !== false) throw new Error('health 语义错误')
})

if (failed > 0) {
  console.error(`\n自检失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n全部通过。')
