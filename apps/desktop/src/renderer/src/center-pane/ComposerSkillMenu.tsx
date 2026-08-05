import React, { useEffect, useRef } from 'react'

import type { SkillListItem } from '@/shared/ipc'

export type ComposerSkillMenuProps = {
  /** 过滤后的技能列表 */
  skills: SkillListItem[]
  /** 当前高亮项下标 */
  activeIndex: number
  /** 是否正在加载技能 */
  loading?: boolean
  /** 选择某项时回调 */
  onSelect: (skill: SkillListItem) => void
  /** 悬停某项时更新高亮 */
  onActiveIndexChange: (index: number) => void
}

/**
 * Composer 斜杠技能菜单 — 对齐 Cursor 的 `/` 技能选择体验。
 *
 * 锚定在输入框上方展示名称与描述；键盘导航由父组件处理，本组件负责渲染与点击/悬停。
 *
 * @param props - 菜单数据与交互回调
 * @returns 技能菜单节点
 */
export function ComposerSkillMenu({
  skills,
  activeIndex,
  loading = false,
  onSelect,
  onActiveIndexChange
}: ComposerSkillMenuProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div className="app-composer-skill-menu" role="listbox" aria-label="技能列表" ref={listRef}>
      <div className="app-composer-skill-menu-header">技能</div>
      {loading ? (
        <div className="app-composer-skill-menu-empty">加载中…</div>
      ) : skills.length === 0 ? (
        <div className="app-composer-skill-menu-empty">无匹配技能</div>
      ) : (
        <div className="app-composer-skill-menu-list">
          {skills.map((skill, index) => {
            const active = index === activeIndex
            return (
              <button
                key={`${skill.name}:${skill.source}`}
                type="button"
                role="option"
                aria-selected={active}
                className={
                  active ? 'app-composer-skill-menu-item is-active' : 'app-composer-skill-menu-item'
                }
                ref={active ? activeItemRef : undefined}
                onMouseEnter={() => onActiveIndexChange(index)}
                onMouseDown={(e) => {
                  // 避免抢夺 TextArea 焦点导致菜单闪断
                  e.preventDefault()
                }}
                onClick={() => onSelect(skill)}
              >
                <span className="app-composer-skill-menu-item-name">/{skill.name}</span>
                <span className="app-composer-skill-menu-item-desc">{skill.description}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
