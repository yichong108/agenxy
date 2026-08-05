/**
 * 用户级 Openwork 配置路径 — `~/.openwork/` 下的 skills / mcp.json。
 *
 * createAgent.send 内部按此约定加载；宿主写入 MCP 配置或预热时也应使用同一路径。
 */

import { homedir } from 'node:os'
import path from 'node:path'

/** 用户主目录下的 `.openwork` 根目录名 */
const OPENWORK_DIR_NAME = '.openwork'

/**
 * 解析用户主目录下的 `.openwork` 根目录绝对路径。
 *
 * @returns `~/.openwork` 绝对路径
 */
export function getOpenworkDir(): string {
  return path.join(homedir(), OPENWORK_DIR_NAME)
}

/**
 * 解析用户 skills 扫描根目录。
 *
 * createAgent.send 在 build 模式下从此目录递归加载 SKILL.md。
 *
 * @returns `~/.openwork/skills` 绝对路径
 */
export function getOpenworkSkillsPath(): string {
  return path.join(getOpenworkDir(), 'skills')
}

/**
 * 解析用户 MCP 配置文件路径。
 *
 * createAgent.send 在 build 模式下读取此文件并绑定 MCP 工具；
 * 宿主 warmup / 设置落盘应写入同一路径。
 *
 * @returns `~/.openwork/mcp.json` 绝对路径
 */
export function getOpenworkMcpConfigPath(): string {
  return path.join(getOpenworkDir(), 'mcp.json')
}
