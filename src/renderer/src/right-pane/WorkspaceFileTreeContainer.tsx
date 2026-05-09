/**
 * react-arborist 的虚拟列表滚动发生在 react-window 的外层节点；在 Windows/Electron 下需用
 * SimpleBar 自绘滚动条（与主栏消息区一致），故复制 DefaultContainer 并替换 outerElementType。
 */
import {
  forwardRef,
  useCallback,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import { Cursor } from 'react-arborist/dist/module/components/cursor.js'
import { ListInnerElement } from 'react-arborist/dist/module/components/list-inner-element.js'
import { RowContainer } from 'react-arborist/dist/module/components/row-container.js'
import { useDataUpdates, useTreeApi } from 'react-arborist/dist/module/context.js'
import { focusNextElement, focusPrevElement } from 'react-arborist/dist/module/utils.js'
import { FixedSizeList } from 'react-window'
import SimpleBar from 'simplebar-react'

let focusSearchTerm = ''
let typeaheadTimeoutId: ReturnType<typeof setTimeout> | null = null

function FileTreeDropContainer() {
  const tree = useTreeApi()
  return (
    <div
      style={{
        height: tree.visibleNodes.length * tree.rowHeight,
        width: '100%',
        position: 'absolute',
        left: 0,
        right: 0
      }}
    >
      <Cursor />
    </div>
  )
}

/** react-window 的外层：滚动与 ref 落在 SimpleBar 的 content-wrapper 上 */
const FileTreeSimpleBarListOuter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function FileTreeSimpleBarListOuter(props, ref) {
    const { children, className, onClick, onScroll, style, ...rest } = props
    const tree = useTreeApi()

    const handleClick = useCallback(
      (e: MouseEvent<HTMLDivElement>) => {
        onClick?.(e)
        if (e.currentTarget === e.target) {
          tree.deselectAll()
        }
      },
      [onClick, tree]
    )

    const outerStyle =
      style && typeof style === 'object'
        ? {
            height: (style as React.CSSProperties).height,
            width: (style as React.CSSProperties).width,
            minHeight: 0,
            minWidth: 0
          }
        : undefined

    return (
      <SimpleBar
        className="app-right-file-tree-simplebar"
        autoHide={false}
        style={outerStyle}
        scrollableNodeProps={{
          ...rest,
          ref,
          className,
          style,
          onScroll,
          onClick: handleClick
        }}
      >
        <FileTreeDropContainer />
        {children}
      </SimpleBar>
    )
  }
)

export function WorkspaceFileTreeContainer() {
  useDataUpdates()
  const tree = useTreeApi()

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (tree.isEditing) {
      return
    }
    if (e.key === 'Backspace') {
      if (!tree.props.onDelete) return
      const ids = Array.from(tree.selectedIds)
      if (ids.length > 1) {
        let nextFocus = tree.mostRecentNode
        while (nextFocus && nextFocus.isSelected) {
          nextFocus = nextFocus.nextSibling
        }
        if (!nextFocus) nextFocus = tree.lastNode
        tree.focus(nextFocus, { scroll: false })
        tree.delete(Array.from(ids))
      } else {
        const node = tree.focusedNode
        if (node) {
          const sib = node.nextSibling
          const parent = node.parent
          tree.focus(sib || parent, { scroll: false })
          tree.delete(node)
        }
      }
      return
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      focusNextElement(e.currentTarget)
      return
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      focusPrevElement(e.currentTarget)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = tree.nextNode
      if (e.metaKey) {
        tree.select(tree.focusedNode)
        tree.activate(tree.focusedNode)
        return
      }
      if (!e.shiftKey || tree.props.disableMultiSelection) {
        tree.focus(next)
        return
      }
      if (!next) return
      const current = tree.focusedNode
      if (!current) {
        tree.focus(tree.firstNode)
      } else if (current.isSelected) {
        tree.selectContiguous(next)
      } else {
        tree.selectMulti(next)
      }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = tree.prevNode
      if (!e.shiftKey || tree.props.disableMultiSelection) {
        tree.focus(prev)
        return
      }
      if (!prev) return
      const current = tree.focusedNode
      if (!current) {
        tree.focus(tree.lastNode)
      } else if (current.isSelected) {
        tree.selectContiguous(prev)
      } else {
        tree.selectMulti(prev)
      }
      return
    }
    if (e.key === 'ArrowRight') {
      const node = tree.focusedNode
      if (!node) return
      if (node.isInternal && node.isOpen) {
        tree.focus(tree.nextNode)
      } else if (node.isInternal) tree.open(node.id)
      return
    }
    if (e.key === 'ArrowLeft') {
      const node = tree.focusedNode
      if (!node || node.isRoot) return
      if (node.isInternal && node.isOpen) tree.close(node.id)
      else if (!node.parent?.isRoot) {
        tree.focus(node.parent)
      }
      return
    }
    if (e.key === 'a' && e.metaKey && !tree.props.disableMultiSelection) {
      e.preventDefault()
      tree.selectAll()
      return
    }
    if (e.key === 'a' && !e.metaKey && tree.props.onCreate) {
      tree.createLeaf()
      return
    }
    if (e.key === 'A' && !e.metaKey) {
      if (!tree.props.onCreate) return
      tree.createInternal()
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      tree.focus(tree.firstNode)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      tree.focus(tree.lastNode)
      return
    }
    if (e.key === 'Enter') {
      const node = tree.focusedNode
      if (!node) return
      if (!node.isEditable || !tree.props.onRename) return
      setTimeout(() => {
        if (node) tree.edit(node)
      })
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      const node = tree.focusedNode
      if (!node) return
      if (node.isLeaf) {
        node.select()
        node.activate()
      } else {
        node.toggle()
      }
      return
    }
    if (e.key === '*') {
      const node = tree.focusedNode
      if (!node) return
      tree.openSiblings(node)
      return
    }
    if (e.key === 'PageUp') {
      e.preventDefault()
      tree.pageUp()
      return
    }
    if (e.key === 'PageDown') {
      e.preventDefault()
      tree.pageDown()
    }

    if (typeaheadTimeoutId !== null) {
      clearTimeout(typeaheadTimeoutId)
    }
    focusSearchTerm += e.key
    typeaheadTimeoutId = setTimeout(() => {
      focusSearchTerm = ''
      typeaheadTimeoutId = null
    }, 600)
    const node = tree.visibleNodes.find((n) => {
      const name = (n.data as { name?: string }).name
      if (typeof name === 'string') {
        return name.toLowerCase().startsWith(focusSearchTerm)
      }
      return false
    })
    if (node) tree.focus(node.id)
  }

  return (
    <div
      role="tree"
      style={{
        height: tree.height,
        width: tree.width,
        minHeight: 0,
        minWidth: 0
      }}
      onContextMenu={tree.props.onContextMenu}
      onClick={tree.props.onClick}
      tabIndex={0}
      onFocus={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          tree.onFocus()
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          tree.onBlur()
        }
      }}
      onKeyDown={onKeyDown}
    >
      <FixedSizeList
        className={tree.props.className}
        outerRef={tree.listEl}
        itemCount={tree.visibleNodes.length}
        height={tree.height}
        width={tree.width}
        itemSize={tree.rowHeight}
        overscanCount={tree.overscanCount}
        itemKey={(index: number) => tree.visibleNodes[index]?.id ?? index}
        outerElementType={FileTreeSimpleBarListOuter}
        innerElementType={ListInnerElement}
        onScroll={tree.props.onScroll}
        onItemsRendered={tree.onItemsRendered.bind(tree)}
        ref={tree.list}
      >
        {RowContainer}
      </FixedSizeList>
    </div>
  )
}
