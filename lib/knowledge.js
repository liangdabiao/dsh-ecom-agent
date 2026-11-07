// 本地知识库检索：knowledge/ 目录 markdown，零依赖词面打分。
// 移植自 amazon-ecom-agent 的 server/tools/knowledge.py（AGPL-3.0）。
// 原版注释：原系统走本地向量检索；简化版用词面重合度，对"查政策/费用/流程"足够且完全离线。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const CHUNK = 600
const OVERLAP = 80

function loadDocs(knowledgeDir, docs = []) {
  if (!existsSafe(knowledgeDir)) return docs
  for (const entry of readdirSync(knowledgeDir, { withFileTypes: true })) {
    const p = join(knowledgeDir, entry.name)
    if (entry.isDirectory()) loadDocs(p, docs)
    else if (entry.name.endsWith('.md')) {
      let text = ''
      try { text = readFileSync(p, 'utf8') } catch { continue }
      const rel = relative(knowledgeDir, p).split(/[\\/]/).join('/')
      for (let i = 0; i < Math.max(text.length, 1); i += CHUNK - OVERLAP) {
        const chunk = text.slice(i, i + CHUNK)
        if (chunk.trim()) docs.push({ source: rel, offset: i, text: chunk })
        if (i + CHUNK >= text.length) break
      }
    }
  }
  return docs
}
function existsSafe(p) { try { readdirSync(p); return true } catch { return false } }

/** 中文按 2-gram、英文按小写单词切 */
export function terms(query) {
  const low = query.toLowerCase()
  const words = low.match(/[a-z0-9]{2,}/g) || []
  const cjk = (low.match(/[\u4e00-\u9fff]/g) || [])
  const bigrams = cjk.slice(0, -1).map((c, i) => c + cjk[i + 1])
  return [...new Set([...words, ...bigrams])]
}

/** 检索：Top4 命中块 {source, relevance, excerpt} */
export function knowledgeSearch(knowledgeDir, query) {
  const docs = loadDocs(knowledgeDir)
  if (docs.length === 0) return { query, results: [], empty: true }
  const termsList = terms(query)
  if (termsList.length === 0) return { query, results: [], tooShort: true }
  const scored = []
  for (const doc of docs) {
    const low = doc.text.toLowerCase()
    let score = 0
    for (const t of termsList) {
      let idx = 0
      while ((idx = low.indexOf(t, idx)) !== -1) { score++; idx += t.length }
    }
    if (score > 0) scored.push({ score, doc })
  }
  scored.sort((a, b) => b.score - a.score)
  const results = scored.slice(0, 4).map(({ score, doc }) => ({
    source: doc.source,
    relevance: score,
    excerpt: doc.text.trim(),
  }))
  return { query, results, empty: results.length === 0 }
}
