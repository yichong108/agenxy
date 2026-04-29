# Skills 使用说明

本项目会自动扫描以下目录中的技能：

- `.agent-weave/skills`
- `.cursor/skills`
- `skills`

仅识别文件名为 `SKILL.md` 的技能文档，并读取其 frontmatter 元数据。

## 最小结构

每个技能建议放在独立目录中，例如：

```text
skills/
  bug-fix/
    SKILL.md
  code-review/
    SKILL.md
  feature-implement/
    SKILL.md
```

## Frontmatter 示例

```md
---
name: code_review
description: 用于执行代码评审，优先发现 bug、回归风险和缺失测试。
---
```

`name` 与 `description` 会被用于工具注册与匹配。

## 快速验证

1. 新建一个技能目录并写入 `SKILL.md`
2. 启动应用并向 Agent 提问（例如：`请按 code review 方式审查这次改动`）
3. 在时间线中确认是否出现对应 `skill_*` 工具调用

## 示例提问

- `请使用 bug fix 技能修复这个报错：...`
- `请按 code review 技能审查最近修改`
- `请用 feature implement 技能实现这个需求：...`

## 工具工作流技能化模板（推荐）

你可以把内置工具能力（读文件、搜索、终端执行、写文件）组织成稳定流程技能。

本仓库已提供以下模板：

- `skills/debug-workflow/SKILL.md`：故障修复流程（复现 -> 定位 -> 修复 -> 验证）
- `skills/release-workflow/SKILL.md`：发布流程（变更确认 -> 门禁 -> 发布 -> 回滚）
- `skills/triage-workflow/SKILL.md`：分诊流程（收集 -> 评估 -> 排序 -> 执行清单）

### 典型触发语句

- `请按 debug workflow 处理这个报错`
- `请用 release workflow 给我一套发版检查和命令`
- `请按 triage workflow 对这些问题排优先级`

### 边界说明

- Skill 可以标准化“如何调用工具”的流程与输出结构。
- Skill 不能替代底层工具本身的执行权限和系统能力。
