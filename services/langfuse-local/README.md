# Langfuse Local Service

本地 Langfuse 可观测性服务，基于 Docker Compose 部署。

## 目录

```
.
├── docker-compose.yml          # Docker Compose 配置
├── setup-langfuse-local.js     # 管理脚本
├── .env.example                # 环境变量模板
└── README.md                   # 本文档
```

## 快速开始

```bash
# 从项目根目录运行

# 1. 初始化配置
pnpm langfuse:init

# 2. 启动服务
pnpm langfuse:start

# 3. 访问 http://localhost:3000
```

## 命令

| 命令 | 说明 |
|------|------|
| `pnpm langfuse:init` | 创建 .env.langfuse.local |
| `pnpm langfuse:start` | 启动所有服务 |
| `pnpm langfuse:stop` | 停止所有服务 |
| `pnpm langfuse:status` | 查看服务状态 |
| `pnpm langfuse:logs` | 查看日志 |
| `pnpm langfuse:reset` | 重置所有数据 ⚠️ |

## 服务说明

- **Langfuse Web**: http://localhost:3000
- **MinIO Console**: http://localhost:9001
- **Postgres**: localhost:5432
- **Redis**: localhost:6379

## 详细文档

见 [docs/langfuse.md](../../docs/langfuse.md)
