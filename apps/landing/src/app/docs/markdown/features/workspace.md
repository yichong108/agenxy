# Workspace 管理

Workspace 是 Luneto 中的工作空间概念，每个 Workspace 可以包含多个 Agent 和对话。

## 创建 Workspace

1. 点击左侧边栏的 "+" 按钮
2. 输入 Workspace 名称
3. 选择初始配置

## Workspace 设置

每个 Workspace 都有独立的配置：

- **Agent 配置**: 定义 Agent 的行为和能力
- **MCP 服务器**: 配置可用的工具和服务
- **环境变量**: 设置运行时环境变量
- **权限管理**: 控制文件和系统访问权限

## 导入导出

您可以导出 Workspace 配置，方便分享或备份：

```json
{
  "name": "My Workspace",
  "agents": [...],
  "mcpServers": [...],
  "settings": {...}
}
```

## 团队协作

Workspace 配置可以通过 Git 进行版本控制，便于团队协作。
