# Agenxy

[English README](README.md)

**Agenxy** 是一款基于 Electron 的 AI Agent 桌面应用。界面使用 React 与 Ant Design；主进程集成 LangChain 与各模型提供商，并支持 **MCP（Model Context Protocol）** 以接入外部工具与能力。

## 界面预览

![Agenxy 主界面：工作区侧栏、会话树与对话区](assets/agenxy-ui-screenshot.png)

## 功能概览

- 面向工作区的布局（文件树、编辑器、对话区）
- MCP 服务的管理与运行时接入
- Skills 中心与技能市场目录
- 主进程提供的终端、文件系统等工具能力
- 打包安装包：Windows（NSIS）、macOS（DMG）、Linux（AppImage）

## 环境要求

- [Node.js](https://nodejs.org/)（建议使用 LTS；若仓库后续增加 `engines` 字段请以之为准）

## 快速开始

```bash
npm install
npm run dev
```

## 常用脚本

| 命令 | 说明 |
| ---- | ---- |
| `npm run dev` | 开发模式启动应用（含热更新） |
| `npm run dev:debug` | 开发模式并开启 Node/Electron 调试端口 |
| `npm run build` | 生产构建并执行 `electron-builder` 打安装包 |
| `npm run build:app` | 仅构建主进程 / preload / 渲染进程，不打安装包 |
| `npm run preview` | 预览已构建的渲染端产物 |
| `npm run typecheck` | TypeScript 检查（web 与 node 配置） |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run format` / `npm run format:check` | Prettier |

安装包输出目录为 `release/`（具体目标见 `package.json` 中的 `electron-builder` 配置）。

## 目录结构

| 路径 | 作用 |
| ---- | ---- |
| `src/main/` | Electron 主进程：Agent 服务、MCP、工具、存储等 |
| `src/renderer/` | React 渲染进程 UI |
| `src/preload/` | Preload 与 IPC 桥接 |
| `src/shared/` | 跨进程共享的类型与逻辑 |
| `electron.vite.config.ts` | electron-vite 对主进程、preload、渲染端的打包配置 |

参与贡献的流程与约定见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）；给贡献者与 AI 助手的仓库级说明见 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)
