// 电商运营 Agent · 面板侧服务配置（$DSH_HOME/ecom-agent/settings.json）。
// 面板「⚙️ 服务配置」直接配 Sorftime/卖家精灵/生图中转/领星密钥——比插件 Config 的隐藏入口可发现性强得多。
// 安全：API 只回掩码与是否已配置，绝不回明文。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ecom-agent')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

// 可在面板里配置的字段（白名单）。
export const SETTING_FIELDS = [
  { key: 'sorftimeKey', label: 'Sorftime key（市场调研数据源）', secret: true },
  { key: 'sellerspriteKey', label: '卖家精灵 key（无 Sorftime 时自动降级）', secret: true },
  { key: 'imageBaseUrl', label: '生图中转地址（需 gpt-image 权限）', secret: false },
  { key: 'imageApiKey', label: '生图中转 key', secret: true },
  { key: 'lingxingHost', label: '领星 ERP 地址', secret: false },
  { key: 'lingxingAppId', label: '领星 AppId', secret: false },
  { key: 'lingxingAppSecret', label: '领星 AppSecret', secret: true },
]

function load() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function save(settings) {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${SETTINGS_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
  renameSync(tmp, SETTINGS_FILE)
  try { chmodSync(SETTINGS_FILE, 0o600) } catch { /* Windows 上忽略 */ }
}

export function getSettings() {
  const s = load()
  const out = {}
  for (const { key } of SETTING_FIELDS) out[key] = typeof s[key] === 'string' ? s[key] : ''
  return out
}

// 保存：空串字段保留原值；非白名单字段忽略。返回掩码视图。
export function saveSettings(input = {}) {
  const prev = getSettings()
  const next = { ...prev }
  for (const { key } of SETTING_FIELDS) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) next[key] = v.trim()
  }
  save(next)
  return maskSettings(next)
}

export function clearSettings() {
  const blank = {}
  for (const { key } of SETTING_FIELDS) blank[key] = ''
  save(blank)
}

// 合并生效配置：面板 settings 非空字段覆盖插件 Config。
export function resolveConfig(config = {}) {
  const s = getSettings()
  const merged = { ...config }
  for (const { key } of SETTING_FIELDS) {
    if (s[key]) merged[key] = s[key]
  }
  return merged
}

export function maskSettings(s = getSettings()) {
  const mask = (v) => (v ? `${v.slice(0, 4)}****${v.slice(-4)}` : '')
  const out = { configured: {} }
  for (const { key, secret } of SETTING_FIELDS) {
    out[key] = secret ? mask(s[key]) : (s[key] || '')
    out.configured[key] = Boolean(s[key])
  }
  out.anyConfigured = SETTING_FIELDS.some(({ key }) => Boolean(s[key]))
  return out
}
