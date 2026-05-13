# Agenxy

Agenxy — AI Agent 套件，包含桌面应用、落地页和本地可观测性服务。

## 项目结构 (Monorepo)

```
agenxy/
├── apps/
│   ├── desktop/          # Electron 桌面应用
│   └── landing/          # 落地页 (Next.js)
├── packages/
│   ├── shared-types/     # 共享类型定义
│   ├── ui/               # 共享 UI 组件
│   └── config/           # 共享配置 (ESLint, Prettier, TS)
├── services/
│   └── langfuse-local/   # 本地 Langfuse 服务
├── docs/                 # 文档
└── package.json          # Workspace root
```

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 9+
- [Docker](https://www.docker.com/) (如需本地 Langfuse 服务)

### 安装依赖

```bash
pnpm install
```

### 开发桌面应用

```bash
# 启动桌面应用
pnpm desktop:dev

# 调试模式
pnpm --filter @agenxy/desktop dev:debug
```

### 开发落地页

```bash
# 启动落地页
pnpm landing:dev
```

### 本地 Langfuse 服务

```bash
# 初始化配置
pnpm langfuse:init

# 启动服务
pnpm langfuse:start

# 查看状态
pnpm langfuse:status
```

## 常用命令

| 命令             | 说明                         |
| ---------------- | ---------------------------- |
| `pnpm dev`       | 并行启动所有应用的开发服务器 |
| `pnpm build`     | 构建所有应用                 |
| `pnpm lint`      | 运行所有包的 lint            |
| `pnpm typecheck` | 运行所有包的类型检查         |
| `pnpm format`    | 格式化所有代码               |

## 文档

- [Langfuse 配置说明](./docs/langfuse.md)

## 贡献

请阅读 [AGENTS.md](./AGENTS.md) 了解代码规范。

## License

MIT
