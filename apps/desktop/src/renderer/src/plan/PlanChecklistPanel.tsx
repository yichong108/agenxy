import { Button, Tag, Typography } from 'antd'
import React, { useMemo } from 'react'

import { parseAgentPlan, type ParsedAgentPlan } from '@/renderer/src/plan/parse-plan'

const { Text } = Typography

type PlanChecklistPanelProps = {
  content: string
  streaming?: boolean
  /** 填入 Build 输入框并切换模式；不自动发送 */
  onExecutePlan?: () => void
  executeDisabled?: boolean
}

export function PlanChecklistPanel({
  content,
  streaming,
  onExecutePlan,
  executeDisabled
}: PlanChecklistPanelProps) {
  const plan = useMemo(() => parseAgentPlan(content), [content])

  if (!plan) {
    if (streaming) {
      return (
        <div className="app-plan-panel app-plan-panel--loading" aria-busy="true">
          <div className="app-plan-panel-head">
            <span className="app-plan-panel-title">Plan</span>
            <Tag className="app-plan-panel-tag">生成中…</Tag>
          </div>
          <div className="app-plan-panel-skeleton">
            <span />
            <span />
            <span />
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <PlanChecklistView
      plan={plan}
      streaming={streaming}
      onExecutePlan={onExecutePlan}
      executeDisabled={executeDisabled}
    />
  )
}

function PlanChecklistView({
  plan,
  streaming,
  onExecutePlan,
  executeDisabled
}: {
  plan: ParsedAgentPlan
  streaming?: boolean
  onExecutePlan?: () => void
  executeDisabled?: boolean
}) {
  const stepCount = plan.steps.length

  return (
    <div className="app-plan-panel" data-plan-steps={stepCount}>
      <div className="app-plan-panel-head">
        <span className="app-plan-panel-title">Plan</span>
        <Tag className="app-plan-panel-tag">
          {streaming ? '更新中…' : `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`}
        </Tag>
      </div>

      {plan.goal ? (
        <div className="app-plan-panel-goal">
          <Text type="secondary" className="app-plan-panel-section-label">
            目标
          </Text>
          <p className="app-plan-panel-goal-text">{plan.goal}</p>
        </div>
      ) : null}

      <ol className="app-plan-panel-list">
        {plan.steps.map((step) => (
          <li key={step.id} className="app-plan-panel-item">
            <span className="app-plan-panel-index" aria-hidden>
              {step.index}
            </span>
            <span className="app-plan-panel-bullet" aria-hidden />
            <div className="app-plan-panel-item-body">
              <span className="app-plan-panel-item-title">{step.title}</span>
              {step.detail ? (
                <span className="app-plan-panel-item-detail">{step.detail}</span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {plan.notes.length > 0 ? (
        <div className="app-plan-panel-notes">
          <Text type="secondary" className="app-plan-panel-section-label">
            风险与待确认
          </Text>
          <ul>
            {plan.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="app-plan-panel-footer">
        <Text type="secondary" className="app-plan-panel-footer-hint">
          只读计划，尚未修改工作区。点击「执行计划」将切换到 Build 并关联本计划；可在输入框补充修改后发送。
        </Text>
        {onExecutePlan && !streaming ? (
          <Button
            type="primary"
            size="small"
            className="app-plan-panel-execute-btn"
            disabled={executeDisabled}
            onClick={onExecutePlan}
          >
            执行计划
          </Button>
        ) : null}
      </div>
    </div>
  )
}

