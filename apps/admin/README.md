# @openwork/admin

Openwork 后台管理前端（Vite + React + Ant Design）。

## 功能

- 侧栏菜单：用户列表
- 用户列表页：调用 `GET /users` 展示用户公开信息

## 快速开始

```bash
# 仓库根目录安装依赖
pnpm install

# 确保 API 已启动
pnpm api:dev

# 启动后台管理（默认 http://127.0.0.1:5174）
pnpm admin:dev
```

## 环境变量

复制 `.env.example` 为 `.env`：

| 变量                         | 说明            | 默认                    |
| ---------------------------- | --------------- | ----------------------- |
| `VITE_OPENWORK_API_BASE_URL` | 后端 API 根地址 | `http://127.0.0.1:3100` |

## 脚本

| 命令                                      | 说明              |
| ----------------------------------------- | ----------------- |
| `pnpm --filter @openwork/admin dev`       | 开发模式          |
| `pnpm --filter @openwork/admin build`     | 生产构建          |
| `pnpm --filter @openwork/admin typecheck` | TypeScript 检查   |
| `pnpm lint` / `pnpm lint:fix`             | 仓库根目录 Oxlint |
