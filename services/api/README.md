# @agenwork/api

Agenwork 后端 API 服务（Node.js + Express + MySQL + Redis）。

## 快速开始

```bash
# 在仓库根目录安装依赖
pnpm install

# 复制环境变量
cp services/api/.env.example services/api/.env

# 启动本地 MySQL + Redis（独立于 langfuse-local）
pnpm --filter @agenwork/api docker:up

# 启动开发服务
pnpm api:dev
```

默认监听 `http://127.0.0.1:3100`。

## 本地依赖（Docker）

`docker-compose.yml` 仅编排 API 所需的 MySQL 与 Redis，容器名为 `agenwork-mysql` / `agenwork-redis`，与 `services/langfuse-local` 互不共用。

| 服务 | 默认端口 | 默认凭证 |
| --- | --- | --- |
| MySQL 8.4 | `3306` | root / `password`，库名 `agenwork` |
| Redis 7 | `6379` | 无密码（可用 `REDIS_PASSWORD` 开启） |

端口与凭证读取本目录 `.env`（与 `.env.example` 对齐）。若与本机其它服务冲突，修改 `.env` 中的 `MYSQL_PORT` / `REDIS_PORT` 后重新 `docker:up`。

## 健康检查

```bash
curl http://127.0.0.1:3100/health
```

成功示例：

```json
{
  "status": "ok",
  "timestamp": "2026-07-22T02:00:00.000Z",
  "checks": {
    "mysql": "up",
    "redis": "up"
  }
}
```

当 MySQL 或 Redis 不可用时返回 HTTP `503`，`status` 为 `degraded`。

## Auth API

账号密码登录（暂无注册）。启动时 `ensureSchema()` 会创建 `users` 表，并在不存在时种子写入默认管理员：

| 字段 | 值 |
| --- | --- |
| username | `admin` |
| password | `admin` |
| role | `admin` |

密码以 bcrypt 哈希存储。JWT 相关配置见 `JWT_SECRET` / `JWT_EXPIRES_IN`。

### `POST /auth/login`

请求体：

```json
{ "username": "admin", "password": "admin" }
```

成功（200，`code === 0`）：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "accessToken": "<jwt>",
    "user": { "id": "...", "username": "admin", "role": "admin" }
  }
}
```

失败（仍为 HTTP 200，`code !== 0`）：

```json
{ "code": 40101, "message": "Invalid username or password", "data": null }
```

### `GET /auth/me`

请求头：`Authorization: Bearer <accessToken>`

成功返回：

```json
{ "code": 0, "message": "ok", "data": { "user": { "id": "...", "username": "admin", "role": "admin" } } }
```

## Settings API

全局应用配置（与桌面端 `@agenwork/shared` 的 `AppSettings` 同构）。当前 settings 路由仍无鉴权，读写同一条 `default` 记录，落库于 MySQL `app_settings`，并用 Redis 短缓存。

### `GET /settings`

返回：

```json
{ "data": { "provider": "deepseek", "providerProfiles": { "...": "..." }, "...": "..." } }
```

### `PUT /settings`

请求体为 `Partial<AppSettings>`（JSON 对象），服务端与现有记录合并后规范化并保存。

```bash
curl -X PUT http://127.0.0.1:3100/settings \
  -H "Content-Type: application/json" \
  -d '{"tavilyApiKey":"tvly-xxx"}'
```

## 脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm --filter @agenwork/api dev` | 开发模式（tsx watch） |
| `pnpm --filter @agenwork/api build` | 编译到 `dist/` |
| `pnpm --filter @agenwork/api start` | 运行编译产物 |
| `pnpm --filter @agenwork/api typecheck` | TypeScript 类型检查 |
| `pnpm --filter @agenwork/api docker:up` | 启动 MySQL + Redis |
| `pnpm --filter @agenwork/api docker:down` | 停止并移除容器 |
| `pnpm --filter @agenwork/api docker:logs` | 跟踪容器日志 |
| `pnpm --filter @agenwork/api docker:reset` | 停止并删除数据卷 |
