// ============================================================================
// 亚马逊运营 Agent 工具箱 · 浏览器半边。
// 三块功能：📊 广告报表诊断（路径输入→确定性聚合结果表）、📚 知识库检索、🖼 生成图库。
// ============================================================================
const h = require('react').createElement
const { useState, useEffect, useCallback } = require('react')

const PANEL_ID = 'ecom-agent'
const BASE = 'ecom-agent'

function PanelIcon(props) {
  return h('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', ...props },
    h('rect', { x: 2.5, y: 2.5, width: 19, height: 19, rx: 5, fill: '#1a6f4b' }),
    h('path', { d: 'M7 9h10M7 12.5h10M7 16h6', stroke: '#fff', 'stroke-width': 1.7, 'stroke-linecap': 'round' }),
    h('circle', { cx: 16.5, cy: 8, r: 2.4, fill: '#ffd24a', stroke: '#1a6f4b' }))
}

async function fetchJson(path, body) {
  const res = await fetch(BASE + path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
  return data
}

// ---------- 知识库检索 ----------
function KnowledgeTab() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const search = async () => {
    if (!query.trim()) return
    setBusy(true); setError(''); setResults(null)
    try { setResults(await fetchJson('/api/knowledge', { query: query.trim() })) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return h('div', null,
    h('div', { style: styles.row },
      h('input', { placeholder: '如 FBA fees / 跟卖政策 / 标题字符限制', value: query, onChange: (e) => setQuery(e.target.value), style: { ...styles.input, flex: 1 }, onKeyDown: (e) => { if (e.key === 'Enter') search() } }),
      h('button', { style: styles.button, onClick: search, disabled: busy || !query.trim() }, busy ? '检索中…' : '检索知识库')),
    error ? h('div', { style: styles.error }, error) : null,
    results === null ? h('div', { style: styles.muted }, '检索 86 篇运营知识（政策/费用/FBA/Listing 规则/广告）。回答事实性问题前先查这里。') : null,
    results && results.results?.length === 0 ? h('div', { style: styles.muted }, '没有相关内容。换英文术语或更具体的关键词试试。') : null,
    results?.results?.map((r, i) => h('div', { key: i, style: styles.card },
      h('div', { style: styles.skillName }, `[K: ${r.source}]`, h('span', { style: styles.skillCategory }, `相关度 ${r.relevance}`)),
      h('div', { style: { ...styles.skillDesc, whiteSpace: 'pre-wrap' } }, r.excerpt.slice(0, 500)))))
}

// ---------- 图库 ----------
function ImagesTab() {
  const [images, setImages] = useState(null)
  const load = useCallback(() => {
    fetchJson('/api/images').then((d) => setImages(d.images)).catch((e) => setError(e.message))
  }, [])
  const [error, setError] = useState('')
  useEffect(() => { load() }, [load])

  return h('div', null,
    h('div', { style: styles.row },
      h('button', { style: styles.buttonSecondary, onClick: load }, '刷新')),
    images === null ? h('div', { style: styles.muted }, '加载中…')
      : images.length === 0 ? h('div', { style: styles.muted }, '还没有生成过图片。对话里用「生成一张场景主图」即可。')
        : h('div', { style: styles.imageGrid },
            images.map((img) => h('div', { key: img.path, style: styles.imageCard },
              h('img', { src: `${BASE}/images/${encodeURIComponent(img.name)}`, style: { width: '100%', borderRadius: 6 }, loading: 'lazy' }),
              h('div', { style: styles.muted }, img.name)))))
}

// ---------- 报表诊断 ----------
function AdsTab() {
  const [path, setPath] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const diagnose = async () => {
    if (!path.trim()) return
    setBusy(true); setError(''); setResult(null)
    try { setResult(await fetchJson('/api/ads', { path: path.trim() })) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const r = result?.result
  return h('div', null,
    h('div', { style: styles.row },
      h('input', { placeholder: '广告报表的绝对路径（xlsx/csv，如工作区里的搜索词报表）', value: path, onChange: (e) => setPath(e.target.value), style: { ...styles.input, flex: 1 }, onKeyDown: (e) => { if (e.key === 'Enter') diagnose() } }),
      h('button', { style: styles.button, onClick: diagnose, disabled: busy || !path.trim() }, busy ? '解析中…' : '确定性诊断')),
    h('div', { style: styles.muted }, '解析是确定性的（算数不经过大模型）；拿到聚合后按系统提示词的阈值出诊断。也可以直接在对话里说「诊断这份广告报表」并给出路径。'),
    error ? h('div', { style: styles.error }, error) : null,
    r ? h('div', null,
      h('div', { style: styles.row },
        h('span', { style: styles.sectionTitle }, `${r.file}：${r.total.term_rows} 行 · 花费 ${r.total.spend} · ACOS ${r.total.acos} · CVR ${r.total.cvr}`)),
      r.campaigns?.length ? h('div', { style: styles.card },
        h('div', { style: styles.sectionTitle }, 'Campaign 效率（按花费降序）'),
        h('table', { style: styles.table },
          h('thead', null, h('tr', null, ['Campaign', '花费', '点击', '订单', '销售额', 'ACOS', 'CVR'].map((th) => h('th', { key: th, style: styles.th }, th)))),
          h('tbody', null, r.campaigns.slice(0, 10).map((c) => h('tr', { key: c.campaign },
            h('td', { style: styles.td }, c.campaign), h('td', { style: styles.td }, c.spend), h('td', { style: styles.td }, c.clicks),
            h('td', { style: styles.td }, c.orders), h('td', { style: styles.td }, c.sales), h('td', { style: styles.td }, c.acos), h('td', { style: styles.td }, c.cvr)))))) : null,
      r.top_wasted_terms?.length ? h('div', { style: styles.card },
        h('div', { style: styles.sectionTitle }, `烧钱无单 Top ${Math.min(30, r.top_wasted_terms.length)}（≥15 点击 0 单建议否词）`),
        r.top_wasted_terms.slice(0, 15).map((t, i) => h('div', { key: i, style: styles.statRow },
          h('span', { style: { fontWeight: 600 } }, t.term),
          h('span', { style: { marginLeft: 'auto', color: '#c0392b' } }, `花费 ${t.spend} · ${t.clicks} 点击 · 0 单`)))) : null,
      r.top_performing_terms?.length ? h('div', { style: styles.card },
        h('div', { style: styles.sectionTitle }, `出单词 Top ${Math.min(30, r.top_performing_terms.length)}`),
        r.top_performing_terms.slice(0, 15).map((t, i) => h('div', { key: i, style: styles.statRow },
          h('span', { style: { fontWeight: 600 } }, t.term),
          h('span', { style: { marginLeft: 'auto', color: '#1a6f4b' } }, `订单 ${t.orders} · 销售额 ${t.sales} · 花费 ${t.spend}`)))) : null) : null)
}

// ---------- 主面板 ----------

// ---------- 服务配置：面板内直配各数据源密钥（存本机 $DSH_HOME，永不上传/回显明文） ----------
const SETTING_FIELDS = [
  { key: 'sorftimeKey', label: 'Sorftime key', secret: true },
  { key: 'sellerspriteKey', label: '卖家精灵 key', secret: true },
  { key: 'imageBaseUrl', label: '生图中转地址', secret: false },
  { key: 'imageApiKey', label: '生图中转 key', secret: true },
  { key: 'lingxingHost', label: '领星 ERP 地址', secret: false },
  { key: 'lingxingAppId', label: '领星 AppId', secret: false },
  { key: 'lingxingAppSecret', label: '领星 AppSecret', secret: true },
]

function SettingsTab() {
  const [info, setInfo] = useState(null)
  const [values, setValues] = useState({})
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    fetchJson('/api/config').then(setInfo).catch((e) => setError(e.message))
  }, [])
  const save = async () => {
    setError(''); setMsg('')
    try {
      const d = await fetch(BASE + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) }).then(r => r.json())
      if (d.error) throw new Error(d.error)
      setInfo(d.credentials); setValues({})
      setMsg('已保存（存本机 $DSH_HOME/ecom-agent/settings.json，不会上传）。立即生效。')
    } catch (e) { setError(e.message) }
  }
  const clear = async () => {
    setError(''); setMsg('')
    try {
      const d = await fetch(BASE + '/api/config', { method: 'DELETE' }).then(r => r.json())
      if (d.error) throw new Error(d.error)
      setInfo(d.credentials); setValues({}); setMsg('已清除本机保存的全部密钥。')
    } catch (e) { setError(e.message) }
  }
  return h('div', null,
    h('div', { style: styles.card },
      h('div', { style: styles.sectionTitle }, '⚙️ 服务配置（市场调研 / AI 生图 / 领星 ERP）'),
      info === null ? h('div', { style: styles.muted }, '加载中…')
        : h('div', { style: styles.muted },
            info.anyConfigured ? '已保存以下配置（留空的项沿用已存值）：' : '尚未配置。填好对应项并保存即可启用对应工具。'),
      SETTING_FIELDS.map(({ key, label }) => h('div', { key: key, style: styles.field },
        h('div', { style: styles.mutedSmall },
          label,
          info && info.configured && info.configured[key] ? h('span', { style: styles.ok }, ' · 已配置 ' + (info[key] || '✓')) : null),
        h('input', {
          type: 'password',
          placeholder: info && info.configured && info.configured[key] ? '已保存（输入新值可覆盖）' : label,
          value: values[key] || '',
          onChange: (e) => setValues((v) => ({ ...v, [key]: e.target.value })),
          style: styles.input,
        }))),
      h('div', { style: styles.row },
        h('button', { style: styles.button, onClick: save }, '保存配置'),
        info?.anyConfigured ? h('button', { style: styles.tab, onClick: clear }, '清除全部') : null),
      msg ? h('div', { style: styles.ok }, msg) : null,
      error ? h('div', { style: styles.error }, error) : null,
      h('div', { style: { ...styles.muted, fontSize: 12, lineHeight: 1.8 } },
        'Sorftime / 卖家精灵：对应官网控制台获取 API key；生图中转：需 gpt-image 权限的中转地址+key；领星 ERP：管理后台的应用凭证。',
        h('br'), '全部只存本机（$DSH_HOME/ecom-agent/settings.json），任何接口不回显明文。')))
}

function Panel() {
  const [tab, setTab] = useState('knowledge')
  const [health, setHealth] = useState(null)
  useEffect(() => { fetchJson('/api/health').then(setHealth).catch(() => setHealth({ sources: {} })) }, [])
  const src = health?.sources || {}
  return h('div', { style: styles.wrap },
    h('div', { style: styles.row },
      h('button', { style: tab === 'knowledge' ? styles.tabActive : styles.tab, onClick: () => setTab('knowledge') }, '📚 知识库'),
      h('button', { style: tab === 'ads' ? styles.tabActive : styles.tab, onClick: () => setTab('ads') }, '📊 报表诊断'),
      h('button', { style: tab === 'images' ? styles.tabActive : styles.tab, onClick: () => setTab('images') }, '🖼 图库'),
      h('button', { style: tab === 'settings' ? styles.tabActive : styles.tab, onClick: () => setTab('settings') }, '⚙️ 服务配置'),
      h('span', { style: { ...styles.muted, marginLeft: 'auto' } },
        `数据源：调研 ${src.sorftime ? 'Sorftime' : src.sellersprite ? '卖家精灵' : '未配'} · 生图 ${src.image ? '✓' : '未配'} · 领星 ${src.lingxing ? '✓' : '未配'}`)),
    tab === 'knowledge' ? h(KnowledgeTab) : tab === 'ads' ? h(AdsTab) : tab === 'settings' ? h(SettingsTab) : h(ImagesTab))
}

const styles = {
  ok: { color: '#1a7f37' },
  field: { marginBottom: 10 },
  mutedSmall: { color: '#a0a0a8', fontSize: 12, marginBottom: 4 },
  wrap: { padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box', fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif', fontSize: 13, color: '#1a1a1a' },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 },
  input: { padding: '6px 10px', border: '1px solid #d9d9de', borderRadius: 8, background: '#fff', color: '#1a1a1a', outline: 'none' },
  button: { padding: '6px 14px', border: 'none', borderRadius: 8, background: '#1a6f4b', color: '#fff', cursor: 'pointer', fontSize: 13 },
  buttonSecondary: { padding: '6px 14px', border: '1px solid #d9d9de', borderRadius: 8, background: '#f0f0f2', color: '#1a1a1a', cursor: 'pointer', fontSize: 13 },
  tab: { padding: '8px 16px', border: '1px solid #d9d9de', borderRadius: 8, background: '#fff', color: '#1a1a1a', cursor: 'pointer', fontSize: 13 },
  tabActive: { padding: '8px 16px', border: '1px solid #1a6f4b', borderRadius: 8, background: '#e6f2ec', color: '#0e4d34', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  sectionTitle: { fontWeight: 700, marginBottom: 6 },
  muted: { color: '#8a8a92' },
  error: { color: '#c0392b' },
  card: { background: '#fff', border: '1px solid #e3e3e6', borderRadius: 10, padding: 10, marginBottom: 10 },
  skillName: { fontWeight: 700, color: '#0e4d34' },
  skillCategory: { display: 'inline-block', marginLeft: 8, padding: '1px 8px', borderRadius: 999, background: '#e6f2ec', color: '#0e4d34', fontSize: 11 },
  skillDesc: { marginTop: 4, color: '#4a4a50', lineHeight: 1.5 },
  imageGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 },
  imageCard: { background: '#fff', border: '1px solid #e3e3e6', borderRadius: 8, padding: 6 },
  statRow: { display: 'flex', gap: 8, alignItems: 'center', background: '#fafafa', borderRadius: 8, padding: '6px 10px', marginBottom: 4 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 8px' },
  td: { borderBottom: '1px solid #eee', padding: '4px 8px' },
}

function apply(ctx) {
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => '运营 Agent' }, PanelIcon))
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel))
}

exports.isPlugin = true
exports.inject = ['slots']
exports.apply = apply
