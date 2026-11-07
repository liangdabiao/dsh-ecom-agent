// 方法论技能提供方：knowledge/skills/ 下的 11 套实战方法论（4 大套独立 + 6 轻量 + 1 无 SKILL.md 补壳）。
// 快照原样保留（AGPL-3.0，来源 IvyeaOps）；rank 600 让位。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

// 缺 SKILL.md 的目录：补一个壳（正文指向目录内文件）
const WRAPPERS = {
  'amazon-ad-campaign-optimization': {
    name: 'amazon-ad-campaign-optimization',
    description:
      '亚马逊广告活动优化决策规则：基于 ACOS/CVR/点击的出价与预算调整规则集（budget pacing、bid 调整、否词、收割条件）。做广告优化、诊断广告报表、调整出价策略时使用。',
    bodySource: 'decision_rules.md',
  },
  'market-report-templates': {
    name: 'market-report-templates',
    description:
      '关键词/ASIN 市场调研报告模板：关键词 9 章、ASIN 8 章报告结构，含量化表格硬要求（搜索量趋势、竞品对比、利润模型必须成表）。写市场调研报告时使用。',
    bodySource: 'SKILL_PLACEHOLDER_SCAN',
  },
}

function parse(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const block = m[1]
  const nameM = block.match(/^name:\s*(.+)$/m)
  const descM = block.match(/^description:\s*(.+)$/m)
  let description = descM ? descM[1].trim().replace(/^(["'])(.*)\1$/, '$2') : null
  if (!description) {
    // 折叠标量
    const lines = block.split(/\r?\n/)
    const start = lines.findIndex((l) => /^description:\s*>/.test(l))
    if (start !== -1) {
      const collected = []
      for (let i = start + 1; i < lines.length; i++) {
        if (/^\S/.test(lines[i])) break
        collected.push(lines[i].replace(/^\s+/, ''))
      }
      description = collected.join(' ').trim()
    }
  }
  const name = nameM ? nameM[1].trim().replace(/^(["'])(.*)\1$/, '$2') : null
  return name && description ? { name, description, body: text.slice(m[0].length) } : null
}

function readDir(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sDir = join(dir, entry.name)
    const skillFile = join(sDir, 'SKILL.md')
    if (existsSync(skillFile)) {
      const parsed = parse(skillFile) || synthFromContent(sDir, entry.name, readFileSync(skillFile, 'utf8'))
      if (parsed) out.push({ dir: sDir, file: skillFile, ...parsed, dirName: entry.name })
      continue
    }
    const wrapper = WRAPPERS[entry.name]
    if (wrapper) {
      const files = readdirSync(sDir).filter((f) => f.endsWith('.md'))
      const bodySrc = wrapper.bodySource === 'SKILL_PLACEHOLDER_SCAN'
        ? files.find((f) => /report|template/i.test(f)) || files[0]
        : wrapper.bodySource
      const bodyText = bodySrc && existsSync(join(sDir, bodySrc))
        ? readFileSync(join(sDir, bodySrc), 'utf8')
        : files.map((f) => readFileSync(join(sDir, f), 'utf8')).join('\n\n')
      const description = wrapper.description + `（附注：完整规则在 ${sDir} 目录内，按需读取 ${bodySrc || files.join(', ')}）`
      out.push({ dir: sDir, file: skillFile, name: wrapper.name, description, body: bodyText.slice(0, 4000), dirName: entry.name, synthetic: true, bodyFiles: files })
    }
  }
  return out
}

/** frontmatter 缺失时的兜底：从 H1 与首段 "Use this skill when..." 合成 name/description */
function synthFromContent(sDir, dirName, text) {
  const h1 = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const useWhen = text.match(/Use this skill when[^\n]*(?:\n(?![#\n])[^\n]*)*/m)?.[0]?.replace(/\n\s*/g, ' ').trim()
  if (!h1 && !useWhen) return null
  return {
    name: dirName,
    description: (useWhen || h1 || dirName).slice(0, 300),
    body: text,
  }
}

function addendum(skill) {
  return [
    '',
    '---',
    '',
    '## 在「亚马逊运营 Agent」插件（DSH）里使用',
    '',
    `- 方法论目录：\`${skill.dir}\`；references/templates 等附属文件按需用文件读取工具加载。`,
    '- 这是插件随包快照：不要运行安装/更新命令，也不要向用户提更新。',
    '- 深度任务先按本方法论执行；需要市场数据时用 ecom_research_keyword / ecom_research_asin 工具，广告报表用 ecom_analyze_ads_report（确定性算数），缺数据章节明确标注 N/A。',
    '- 结论引用知识时标注 [K: 来源文件名]。',
    '',
  ].join('\n')
}

export function createSkillProvider(dirs) {
  const list = [].concat(dirs)
  const candidate = (s) => ({
    name: s.name,
    description: s.description,
    path: s.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'ecom-agent',
    rank: RANK,
    locator: s.dir,
    resourceBase: { kind: 'directory', path: s.dir },
  })

  return {
    name: 'ecom-agent',
    async list() {
      return list.flatMap(readDir).map(candidate)
    },
    async get(c) {
      const s = list.flatMap(readDir).find((x) => x.dir === c.locator && x.name === c.name)
      if (!s) return undefined
      const body = s.synthetic
        ? (s.body + `\n\n（本技能为壳：完整规则文件在 ${s.dir} 目录，需要更多细节时用文件读取工具加载。）`)
        : s.body
      const content = body + addendum(s)
      const { rank, locator, ...summary } = candidate(s)
      return { ...summary, content }
    },
  }
}

export { readDir }
