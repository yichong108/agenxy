/**
 * 技能意图标签注册表（与 desktop skills 目录对应）。
 *
 * 属于 Desktop 可选增强：用于按用户意图筛选要加载的 skills，不属于 @agenwork/agent 核心。
 */

export type UserIntent = 'coding' | 'general'

export type SkillTagEntry = {
  id: string
  tags: UserIntent[]
}

/** 技能意图标签注册表 */
export const SKILLS_WITH_TAGS: readonly SkillTagEntry[] = [
  { id: 'bug_fix', tags: ['coding'] },
  { id: 'code_review', tags: ['coding'] },
  { id: 'debug_workflow', tags: ['coding'] },
  { id: 'feature_implement', tags: ['coding'] },
  { id: 'release_workflow', tags: ['coding'] },
  { id: 'triage_workflow', tags: ['coding'] },
  { id: 'frontend_slides', tags: ['general'] },
  { id: 'frontend_slides_ppt_controlled', tags: ['general'] }
]
