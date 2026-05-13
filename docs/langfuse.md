# Langfuse 可观测性

本文档说明 **Agenxy** 如何接入 [Langfuse](https://langfuse.com) 进行 LLM 调用追踪：支持云端服务或本地自托管，配置方式、启动流程与故障排查。

## 目录

- [快速开始](#快速开始)
- [两种部署模式](#两种部署模式)
  - [本地模式（推荐开发使用）](#本地模式推荐开发使用)
  - [云端模式](#云端模式)
- [环境变量配置](#环境变量配置)
- [本地服务 Docker 部署](#本地服务-docker-部署)
- [获取 API 密钥](#获取-api-密钥)
- [实现位置](#实现位置)
- [故障排查](#故障排查)
- [安全提示](#安全提示)

---

## 快速开始

### 方式一：本地部署（数据完全本地存储）

```bash
# 1. 创建本地环境配置
cp .env.example .env.langfuse.local

# 2. 启动本地 Langfuse 服务
docker-compose -f docker-compose.langfuse.yml --env-file .env.langfuse.local up -d

# 3. 访问 http://localhost:3000 创建项目并获取 API 密钥

# 4. 配置应用使用本地服务
cp .env.example .env.development.local
# 编辑 .env.development.local:
# LANGFUSE_MODE=local
# LANGFUSE_PUBLIC_KEY=pk-lf-xxxx  # 从本地 UI 复制
# LANGFUSE_SECRET_KEY=sk-lf-xxxx  # 从本地 UI 复制

# 5. 重启 Electron 应用
```

### 方式二：使用 Langfuse Cloud

```bash
# 1. 在 https://cloud.langfuse.com 注册并创建项目，获取 API 密钥

# 2. 配置应用
cp .env.example .env.development.local
# 编辑 .env.development.local:
# LANGFUSE_MODE=cloud
# LANGFUSE_BASE_URL=https://cloud.langfuse.com  # 或 us/jp 区域
# LANGFUSE_PUBLIC_KEY=pk-lf-xxxx
# LANGFUSE_SECRET_KEY=sk-lf-xxxx

# 3. 重启 Electron 应用
```

---

## 两种部署模式

### 本地模式（推荐开发使用）

通过 Docker Compose 在本地运行完整的 Langfuse 服务栈：

- **数据完全本地存储** - Postgres + MinIO，数据保留在本地机器
- **无需网络连接** - 追踪数据不上传到任何外部服务
- **零费用** - 无云端使用量限制或费用
- **完全控制** - 可自行管理数据保留策略

**包含服务：**
- Langfuse Web UI (`http://localhost:3000`)
- Postgres 16 数据库
- Redis 缓存
- MinIO 对象存储 (S3 兼容)

### 云端模式

使用 Langfuse 官方托管服务：

- **即用即付** - 无需维护基础设施
- **团队协作** - 共享项目、权限管理
- **多区域可选** - EU (默认)、US、Japan

---

## 环境变量配置

### 核心变量

| 变量 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `LANGFUSE_MODE` | 否 | 运行模式: `local` 或 `cloud`，默认 `cloud` | `local` |
| `LANGFUSE_PUBLIC_KEY` | 启用时必填 | 项目公钥 | `pk-lf-...` |
| `LANGFUSE_SECRET_KEY` | 启用时必填 | 项目私钥 | `sk-lf-...` |
| `LANGFUSE_TRACING_DISABLED` | 否 | `true` 时禁用追踪 | `false` |

### 本地模式专用变量

| 变量 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `LANGFUSE_BASE_URL` | 否 | 本地服务地址 | `http://localhost:3000` |

### 云端模式专用变量

| 变量 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `LANGFUSE_BASE_URL` | 否 | 云端区域地址 | `https://cloud.langfuse.com` |

### Docker 部署专用变量（仅用于 docker-compose.langfuse.yml）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `POSTGRES_USER/PORT` | Postgres 配置 | `langfuse/5432` |
| `REDIS_PASSWORD/PORT` | Redis 配置 | `langfuse/6379` |
| `MINIO_ROOT_USER/PASSWORD` | MinIO 配置 | `minio/minio123` |
| `LANGFUSE_PORT` | Langfuse Web 端口 | `3000` |
| `NEXTAUTH_SECRET` | NextAuth 加密密钥 | 需自定义 |
| `SALT` | 数据加密盐值 | 需自定义 |
| `ENCRYPTION_KEY` | 32字节加密密钥 | 需自定义 |

---

## 本地服务 Docker 部署

### 前提条件

- Docker Engine 20.10+
- Docker Compose 2.0+

### 启动服务

```bash
# 使用默认配置启动
docker-compose -f docker-compose.langfuse.yml up -d

# 或使用自定义环境文件
docker-compose -f docker-compose.langfuse.yml --env-file .env.langfuse.local up -d
```

### 查看服务状态

```bash
# 查看容器状态
docker-compose -f docker-compose.langfuse.yml ps

# 查看日志
docker-compose -f docker-compose.langfuse.yml logs -f langfuse-web

# 查看所有服务日志
docker-compose -f docker-compose.langfuse.yml logs -f
```

### 停止服务

```bash
# 停止并保留数据
docker-compose -f docker-compose.langfuse.yml stop

# 停止并删除容器（保留数据卷）
docker-compose -f docker-compose.langfuse.yml down

# 停止并删除所有数据（⚠️ 谨慎使用）
docker-compose -f docker-compose.langfuse.yml down -v
```

### 数据持久化

数据存储在 Docker 命名卷中：
- `langfuse-postgres-data` - 数据库文件
- `langfuse-redis-data` - 缓存数据
- `langfuse-minio-data` - 对象存储文件

备份数据：
```bash
# 备份 Postgres
docker exec langfuse-postgres pg_dump -U langfuse langfuse > backup.sql

# 备份数据卷（停止服务后）
docker run --rm -v langfuse-postgres-data:/data -v $(pwd):/backup alpine tar czf /backup/langfuse-backup.tar.gz /data
```

---

## 获取 API 密钥

### 本地模式

1. 访问 `http://localhost:3000`
2. 使用初始化配置的账号登录（默认：`admin@example.com` / `admin`）
3. 创建新项目或进入现有项目
4. 进入 **Settings** → **API Keys**
5. 点击 **Create new API key**
6. 复制 **Public Key** 和 **Secret Key** 到 `.env.development.local`

### 云端模式

1. 访问 [Langfuse Cloud](https://cloud.langfuse.com)（或对应区域）
2. 注册/登录账号
3. 创建新项目
4. 进入 **Settings** → **API Keys**
5. 创建并复制密钥

---

## 实现位置

| 内容 | 路径 |
|------|------|
| OTEL 启动 / 关闭、回调构造 | `src/main/langfuse.ts` |
| 加载 `.env`、关闭 LangSmith 内置追踪 | `src/main/env-bootstrap.ts` |
| 启动 Langfuse、退出时 `shutdown` | `src/main/index.ts` |
| 单次用户消息共用 `CallbackHandler` | `src/main/agent/agent-service.ts` |
| 分类模型 `invoke` 透传回调 | `src/main/agent/intent-classifier.ts` |
| IPC 类型定义 | `src/shared/ipc.ts` |
| Preload API 暴露 | `src/preload/index.ts` |
| Docker 部署配置 | `docker-compose.langfuse.yml` |

---

## 故障排查

### 本地服务无法连接

**现象：** 控制台提示 `本地 Langfuse 服务不可用`

**排查步骤：**

1. 检查 Docker 容器状态
   ```bash
   docker-compose -f docker-compose.langfuse.yml ps
   ```

2. 检查服务日志
   ```bash
   docker-compose -f docker-compose.langfuse.yml logs langfuse-web
   ```

3. 手动测试健康端点
   ```bash
   curl http://localhost:3000/api/public/health
   ```

4. 确认端口未被占用
   ```bash
   # Windows
   netstat -ano | findstr :3000

   # macOS/Linux
   lsof -i :3000
   ```

### 首次启动数据库连接失败

Langfuse Web 服务可能在 Postgres 完全启动前尝试连接。Docker Compose 已配置健康检查和服务依赖，正常情况下会自动重试。如仍失败：

```bash
# 重启服务
docker-compose -f docker-compose.langfuse.yml restart langfuse-web
```

### 密钥配置正确但无追踪数据

1. 检查追踪是否被禁用
   ```bash
   # 应返回空或 false
   echo $LANGFUSE_TRACING_DISABLED
   ```

2. 验证密钥有效性（本地模式）
   ```bash
   curl -H "Authorization: Basic $(echo -n 'pk-lf-xxx:sk-lf-xxx' | base64)" \
        http://localhost:3000/api/public/projects
   ```

3. 查看应用日志中的 `[langfuse]` 相关输出

### 切换到云端模式后无法上报

1. 确认 `LANGFUSE_MODE=cloud`
2. 确认 `LANGFUSE_BASE_URL` 指向正确区域
3. 检查网络连接（可能需要代理）

---

## 安全提示

1. **密钥管理**
   - Secret Key 仅保存在本机环境变量
   - 含真实密钥的文件已由 `.gitignore` 排除
   - 提交前运行 `git status` 确认无敏感文件

2. **本地部署安全**
   - 生产环境应修改默认密码和加密密钥
   - 定期备份 Postgres 数据卷
   - 考虑启用 MinIO 访问控制

3. **密钥轮换**
   - 如密钥曾意外泄露，立即在 Langfuse 控制台轮换
   - 本地模式：在 Web UI 的 Settings → API Keys 中删除并重新创建

---

## 参考链接

- [Langfuse 文档](https://langfuse.com/docs)
- [Langfuse 自托管指南](https://langfuse.com/docs/deployment/self-host)
- [LangChain 集成文档](https://langfuse.com/docs/integrations/langchain/tracing)
- [Langfuse Cloud](https://langfuse.com/cloud)
