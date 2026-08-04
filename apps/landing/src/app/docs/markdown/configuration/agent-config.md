# Agent 配置

Agent 是 Openwork 的核心组件，负责处理用户请求和执行任务。

## 基础配置

```json
{
  "name": "My Agent",
  "model": "gpt-4",
  "temperature": 0.7,
  "maxTokens": 2000,
  "systemPrompt": "You are a helpful assistant."
}
```

## 配置选项

- **name**: Agent 显示名称
- **model**: 使用的语言模型
- **temperature**: 控制输出的随机性 (0-1)
- **maxTokens**: 最大响应长度
- **systemPrompt**: 系统提示词

## 高级配置

### 工具调用

配置 Agent 可以使用的工具：

```json
{
  "tools": [
    {
      "name": "filesystem",
      "enabled": true,
      "permissions": ["read", "write"]
    }
  ]
}
```
