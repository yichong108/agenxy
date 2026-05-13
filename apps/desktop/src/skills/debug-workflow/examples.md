# Debug Workflow 示例

## 示例 1：TypeError 报错

### 用户输入

> 点击“保存”后报错：`Cannot read properties of undefined (reading 'id')`

### 期望输出（结构示例）

1. 问题复现结论
   - 在未选择记录直接点击保存时可稳定复现。

2. 根因说明
   - `selectedItem` 在空状态下未做空值保护，直接读取 `selectedItem.id` 触发异常。

3. 修改点与意图
   - `src/renderer/src/pages/edit.tsx`：在提交前增加空值校验并提前返回提示。

4. 验证步骤与结果
   - 手动验证：空选择点击保存，不再崩溃，出现提示。
   - 回归验证：有选择时保存成功，行为不变。

5. 剩余风险与后续建议
   - 建议补充“空选择提交”单测，防止回归。

---

## 示例 2：构建失败

### 用户输入

> CI 构建失败：`TS2345: Argument of type 'number | undefined' is not assignable to parameter of type 'number'`

### 期望输出（结构示例）

1. 问题复现结论
   - 本地运行类型检查可复现同样错误。

2. 根因说明
   - 新增参数为可选类型，但调用方未提供兜底值，导致类型不匹配。

3. 修改点与意图
   - `src/main/agent/agent-service.ts`：调用前提供默认值，保持原有业务语义。

4. 验证步骤与结果
   - 运行类型检查：通过。
   - 运行构建：通过。

5. 剩余风险与后续建议
   - 若默认值在不同场景语义不同，建议后续改为显式参数约束。
