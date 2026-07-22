# @agenxy/api

Agenxy 后端 API 服务（Node.js + Express + MySQL + Redis）。

## 快速开始

```bash
# 在仓库根目录安装依赖
pnpm install

# 复制环境变量
cp services/api/.env.example services/api/.env

# 启动开发服务
pnpm api:dev
```

默认监听 `http://127.0.0.1:3100`。

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

## 脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm --filter @agenxy/api dev` | 开发模式（tsx watch） |
| `pnpm --filter @agenxy/api build` | 编译到 `dist/` |
| `pnpm --filter @agenxy/api start` | 运行编译产物 |
| `pnpm --filter @agenxy/api typecheck` | TypeScript 类型检查 |
