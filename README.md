# dsh-ecom-agent · 亚马逊运营 Agent 工具箱

DeepSeek Harness（dsh）插件：**15 个实战运营工具**（市场调研/商品采集/广告报表确定性诊断/AI 生图/领星 ERP 只读/知识库检索）+ **86 篇运营知识库** + **11 套方法论技能** + 硬规则系统提示注入。移植自 [amazon-ecom-agent](https://github.com/liangdabiao/amazon-ecom-agent)（AGPL-3.0，上游 IvyeaOps）。

> 原版是一个独立的 Agent 应用（OpenAI Agents SDK）；本插件只移植其核心资产（工具/知识库/系统提示词硬规则），思考循环由 dsh 本身的 Agent 循环承担——这正是 dsh「无特权内核」设计的意义。

## 15 个工具一览

| 工具 | 功能 | 外部依赖 |
|---|---|---|
| `ecom_research_keyword` | 关键词 10 项数据两阶段采集 | Sorftime key（或降级卖家精灵） |
| `ecom_research_asin` | ASIN 深度调研 9 项 | 同上 |
| `ecom_keyword_competition` | 轻量 4 项竞争分析 | 仅 Sorftime |
| `ecom_competitor_reverse` | 竞品流量词反查 | 仅 Sorftime |
| `ecom_traffic_diagnosis` | 流量异动诊断 | 仅 Sorftime |
| `ecom_scrape_product` | 采集商品页 + 主图下载（三级反爬链：curl 直连→浏览器渲染→数据源兜底） | **零 key** |
| `ecom_generate_image` | AI 生图（参考图保真前言 + input_fidelity 降级重试 + 画布裁剪安全区提示） | 生图中转 key |
| `ecom_generate_image_set` | 整套图顺序生成（7 图叙事 / A+，单张失败不中断） | 同上 |
| `ecom_translate_image` | 图片翻译（换文字不换版式，一套图铺多站点） | 同上 |
| `ecom_list_images` | 列出已生成的图片 | **零 key** |
| `ecom_list_reports` | 列出 reports/ 目录的广告报表 | **零 key** |
| `ecom_analyze_ads_report` | **确定性**解析搜索词报表：总消耗/ACOS/CTR/CVR、Campaign 效率对比、烧钱无单 Top30、出单词 Top30（**算数不经过大模型**） | **零 key** |
| `ecom_lingxing_sellers` | 列出领星授权店铺（拿 sid） | 领星三凭证 |
| `ecom_lingxing_query` | 只读 OpenAPI 查询（写路由硬闸拒绝） | 领星三凭证 |
| `ecom_knowledge_search` | 检索 86 篇运营知识（词面打分 Top4 命中块） | **零 key** |

## 知识库与方法论

- **86 篇运营知识**随包检索（政策/费用/FBA/广告/Listing 规则/SP-API），词面打分零依赖完全离线。
- **11 套方法论**注册为 dsh 技能（rank 600 让位）：搜索词报表诊断（zach 决策规则）、ASIN COSMO/Rufus 审计、市场调研报告模板、Listing 创意策略、广告活动优化、预算调价、新品上架、否词守护……深度任务先检索方法论再动手。
- **硬规则系统提示注入**（可开关）：Listing 2026-07 新政字符限制、广告诊断确定性阈值（否词 15 点击 0 单 / 目标 ACOS=0.7×毛利 / 调幅 ≤20%）、7 图生成纪律、[K: 来源] 引用军规。

## 配置

全部通过插件 Configuration 卡片（**不硬编码不回显**）：

| 配置项 | 必填 | 用途 |
|---|---|---|
| sorftimeKey | 市场调研 | [Sorftime](https://www.sorftime.com) MCP 数据源 |
| sellerspriteKey | — | [卖家精灵](https://www.sellersprite.com)（无 Sorftime 时自动降级） |
| imageBaseUrl / imageApiKey | AI 生图 | gpt-image 权限中转 |
| lingxingHost / lingxingAppId / lingxingAppSecret | 领星查询 | [领星 ERP](https://erp.lingxing.com) OpenAPI（严格只读） |
| defaultMarket | — | 默认站点代码（US） |
| injectRules | — | 是否注入硬规则（默认 true） |

不配任何 key 也能用：商品采集、广告报表诊断、知识库检索、图库。

## 安全设计

- 领星 OpenAPI **只读闸**：写路由（create/update/delete/archive 等）一律硬拒，签名 = 参数 MD5 → AES-128-ECB → base64（复刻领星 SignService）。
- 数据源密钥只在 Host 进程内使用，任何 API/回执都不回显。
- 商品页采集：只访问亚马逊官方域名（白名单 16 站点），反爬验证页识别并给可读错误。
- 图片来源校验：dataURI/URL/本地路径三通道，URL 走公网白名单检查。

## 自检

```bash
npm install && npm test && npm run selftest && npm run build
```

- `npm test`：21 个单测（列名模糊匹配/聚合计算/CSV 解析/知识检索/camelCase→snake_case/体积压缩/路由读写闸/签名确定性/生图保真前言/HTML 解析/15 工具 schema）
- `npm run selftest`：写真实 xlsx → 确定性聚合校验 + 知识检索 + 11 技能注册，零网络零 key
- `npm run build`：打包 dist/client.js 并做产物三自检

## 许可

**AGPL-3.0**——上游 [amazon-ecom-agent](https://github.com/liangdabiao/amazon-ecom-agent)（衍生自 IvyeaOps）为 AGPL-3.0，本插件作为衍生作品同样按 AGPL-3.0 传播，保留上游 LICENSE。知识库文档平移自 ivyea-agent（MIT），方法论文本来自 IvyeaOps（AGPL-3.0）。

特别致谢社区支持：https://linux.do
