# Langfuse 可观测性（归档）

本文档归档 **Agenxy 主进程** 接入 [Langfuse](https://langfuse.com) 的方式：如何获取公钥/私钥、如何在本地配置、行为说明与相关代码位置。

## 作用

启用后，LangChain 执行链（意图摘要流式、意图分类、ReAct Agent 等）会通过 **OpenTelemetry** 与 **`@langfuse/langchain` 的 `CallbackHandler`** 将 trace 上报到 Langfuse 控制台，便于排查延迟、工具调用与模型 I/O。

未配置密钥时，应用行为与未接入 Langfuse 时一致（不启动 OTEL、不注册回调）。

## 如何获取 Public Key / Secret Key

1. 登录 Langfuse：**[Langfuse Cloud](https://cloud.langfuse.com)**（或你所在区域的控制台，例如美国区 `https://us.cloud.langfuse.com`），或自托管实例的管理界面。
2. 进入目标 **Project** → **Settings** → **API Keys**（名称可能随版本略有差异）。
3. 创建或查看 API key，通常会看到：
   - **Public Key**：形如 `pk-lf-...`
   - **Secret Key**：形如 `sk-lf-...`
4. **Secret Key 仅保存在本机环境变量或本地 `.env` 中**，勿提交到 Git、勿粘贴到公开渠道。

自托管时，除密钥外还需将 **`LANGFUSE_BASE_URL`** 设为你的实例根 URL（例如 `https://langfuse.example.com`）。

## 在本仓库如何配置

### 开源仓库与密钥文件

根目录 `.gitignore` 已忽略 `.env` 与 `.env.*`（**例外**：`!.env.example` 可提交，其中只有占位符）。请把真实密钥写在本地文件里，**不要**把含 `LANGFUSE_SECRET_KEY` 的文件推送到远程。

推荐流程：复制模板 → 填入密钥 → 保存为本地文件名之一。

```bash
cp .env.example .env.development.local
# 编辑 `.env.development.local`，填入从 Langfuse 控制台复制的公钥/私钥
```

### 加载顺序

主进程在启动时会通过 `src/main/env-bootstrap.ts` 合并仓库根目录下的环境文件（后者不覆盖已存在于 `process.env` 的键）：

- `.env`
- `.env.development`
- `.env.development.local`

任选其一即可；**本地开发建议使用 `.env.development.local`**（已被 `.gitignore` 忽略，不易误提交）。

模板变量说明见仓库根目录 **`.env.example`**。填入示例：

```env
LANGFUSE_PUBLIC_KEY=pk-lf-你的公钥
LANGFUSE_SECRET_KEY=sk-lf-你的私钥

# 可选：与账号区域或自托管地址一致；省略时默认为欧盟区云端
# LANGFUSE_BASE_URL=https://cloud.langfuse.com
# LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
# LANGFUSE_BASE_URL=https://jp.cloud.langfuse.com

# 可选：已有密钥但临时不上报时设为 true / 1 / yes
# LANGFUSE_TRACING_DISABLED=true
```

保存后 **重启 Electron 应用**。若成功启动上报，主进程日志中会出现类似：

`[langfuse] OpenTelemetry 已启动，将上报至 <baseUrl>`

在 Langfuse 控制台的 **Traces** 中应能看到新产生的 trace。

## 环境变量一览

| 变量 | 必填 | 说明 |
|------|------|------|
| `LANGFUSE_PUBLIC_KEY` | 启用上报时必填 | 项目公钥 |
| `LANGFUSE_SECRET_KEY` | 启用上报时必填 | 项目私钥 |
| `LANGFUSE_BASE_URL` | 否 | 默认 `https://cloud.langfuse.com` |
| `LANGFUSE_TRACING_DISABLED` | 否 | `true` / `1` / `yes` 时关闭上报（即使已填密钥） |

## 实现位置（便于维护）

| 内容 | 路径 |
|------|------|
| OTEL 启动 / 关闭、回调构造 | `src/main/langfuse.ts` |
| 加载 `.env`、关闭 LangSmith 内置追踪 | `src/main/env-bootstrap.ts` |
| 启动 Langfuse、退出时 `shutdown` | `src/main/index.ts` |
| 单次用户消息共用一个 `CallbackHandler`（意图流、分类、Agent） | `src/main/agent/agent-service.ts` |
| 分类模型 `invoke` 透传回调 | `src/main/agent/intent-classifier.ts` |

依赖包（节选）：`@langfuse/langchain`、`@langfuse/otel`、`@opentelemetry/sdk-node` 等，见根目录 `package.json`。

## 安全提示

- **Secret Key** 仅保存在本机；含真实密钥的 `.env` / `.env.development` / `.env.development.local` 等已由 `.gitignore` 排除，提交前仍建议 `git status` 确认无敏感文件被误加。
- 若密钥曾出现在公开仓库、Issue 或聊天中，应在 Langfuse 控制台**立即轮换**并更新本地环境变量。
- 仓库中只应出现 **`.env.example`**（空值或占位符），不要提交真实 key。

## 参考链接

- Langfuse 文档（LangChain 集成）：https://langfuse.com/docs/integrations/langchain/tracing  
- Langfuse Cloud：https://langfuse.com/cloud  

---

*归档主题：Langfuse 公钥/私钥获取与本地环境配置。*
