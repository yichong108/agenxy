/**
 * 用户级 Openworker 配置路径 — `~/.openworker/` 下的 skills / mcp.json。
 *
 * createAgent.send 内部按此约定加载；宿主写入 MCP 配置或预热时也应使用同一路径。
 */

import { homedir } from 'node:os'
import path from 'node:path'

/** 用户主目录下的 `.openworker` 根目录名 */
const OPENWORKERER_DIR_NAME = '.openworker'

/**
 * 解析用户主目录下的 `.openworker` 根目录绝对路径。
 *
 * @returns `~/.openworker` 绝对路径
 */
export function getOpenworkerDir(): string {
  return path.join(homedir(), OPENWORKERER_DIR_NAME)
}

/**
 * 解析用户 skills 扫描根目录。
 *
 * createAgent.send 在 build 模式下从此目录递归加载 SKILL.md。
 *
 * @returns `~/.openworker/skills` 绝对路径
 */
export function getOpenworkerSkillsPath(): string {
  return path.join(getOpenworkerDir(), 'skills')
}

/**
 * 解析用户 MCP 配置文件路径。
 *
 * createAgent.send 在 build 模式下读取此文件并绑定 MCP 工具；
 * 宿主 warmup / 设置落盘应写入同一路径。
 *
 * @returns `~/.openworker/mcp.json` 绝对路径
 */
export function getOpenworkerMcpConfigPath(): string {
  return path.join(getOpenworkerDir(), 'mcp.json')
}
