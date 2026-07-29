# MCP 协议支持

Agenwork 完全支持 Model Context Protocol (MCP)，这是一个开放的标准，允许 AI Agent 与外部工具和服务进行交互。

## 什么是 MCP？

MCP (Model Context Protocol) 是一个标准化的协议，定义了 AI Agent 如何与外部系统通信。它提供了一套统一的接口，使得开发者可以轻松地为 Agent 添加新的能力。

## 配置 MCP 服务器

在 Workspace 设置中，您可以添加 MCP 服务器：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]
    }
  }
}
```

## 可用的 MCP 服务器

- **文件系统**: 读取和写入本地文件
- **数据库**: 连接和查询数据库
- **API**: 调用外部 API 服务
- **Git**: 版本控制操作

## 开发自定义 MCP 服务器

您可以开发自己的 MCP 服务器来扩展 Agenwork 的功能。详细文档请参考 [MCP 官方文档](https://modelcontextprotocol.io)。
