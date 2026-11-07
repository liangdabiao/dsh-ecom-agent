// 运行时路径装配：把 Config + $DSH_HOME 组装成 lib 层用的运行时配置对象。
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export function dataDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ecom-agent')
}

/** Config（schemastery 校验后的对象）→ lib 层运行时配置（补齐路径派生） */
export function runtimeConfig(config) {
  const data = dataDir()
  return {
    ...config,
    dataDir: data,
    imagesDir: join(data, 'images'),
    reportsDir: join(data, 'reports'),
    knowledgeDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge'),
  }
}
