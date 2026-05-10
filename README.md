# Agenxy

[中文说明](README.zh-CN.md)

**Agenxy** is an Electron desktop application for working with AI agents. The UI is built with React and Ant Design; the main process integrates LangChain providers and the Model Context Protocol (MCP) for tools and skills.

## UI preview

![Agenxy main window with workspace sidebar, session tree, and agent chat](assets/agenxy-ui-screenshot.png)

## Features

- Workspace-oriented layout (file tree, editor, agent chat)
- MCP server management and runtime integration
- Skills hub and skills market catalog
- Terminal and filesystem tooling from the main process
- Packaged installers for Windows (NSIS), macOS (DMG), and Linux (AppImage)

## Requirements

- [Node.js](https://nodejs.org/) (LTS recommended; aligns with `engines` if the project adds one)

## Getting started

```bash
npm install
npm run dev
```

## Scripts

| Command | Description |
| -------- | ----------- |
| `npm run dev` | Start the app in development with HMR |
| `npm run dev:debug` | Dev with Node/Electron inspector ports |
| `npm run build` | Production build plus `electron-builder` |
| `npm run build:app` | Build main/preload/renderer only (no installer) |
| `npm run preview` | Preview the built renderer bundle |
| `npm run typecheck` | TypeScript check for web and node configs |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run format` / `npm run format:check` | Prettier |

Built installers are emitted under `release/` (see `electron-builder` config in `package.json`).

## Repository layout

| Path | Role |
| ---- | ---- |
| `src/main/` | Electron main process, agent service, MCP, tools, persistence |
| `src/renderer/` | React UI |
| `src/preload/` | Preload scripts and IPC bridges |
| `src/shared/` | Types and code shared between processes |
| `electron.vite.config.ts` | electron-vite bundling for main, preload, and renderer |

Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md). Contributor notes for AI assistants and humans: see [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
