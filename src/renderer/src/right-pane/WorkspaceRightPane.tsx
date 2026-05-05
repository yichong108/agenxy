import { FileOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, Spin, Tag, Tree, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { WorkspaceFileNode } from '@/shared/ipc'

import '@/renderer/src/right-pane/WorkspaceRightPane.scss'

const { Text } = Typography

type FileTreeDataNode = {
  key: string
  title: string
  isLeaf?: boolean
  children?: FileTreeDataNode[]
}

function toAntdFileTree(nodes: WorkspaceFileNode[]): FileTreeDataNode[] {
  return nodes.map((node) => ({
    key: node.path,
    title: node.name,
    isLeaf: node.kind === 'file',
    children: node.kind === 'directory' ? toAntdFileTree(node.children ?? []) : undefined
  }))
}

type WorkspaceRightPaneProps = {
  bridge: Window['bridge']
  activeWorkspaceId: string | null
  activeWorkspacePath: string | null
  width: number
}

export function WorkspaceRightPane(props: WorkspaceRightPaneProps) {
  const { bridge, activeWorkspaceId, activeWorkspacePath, width } = props
  const { message: msgApi } = AntdApp.useApp()
  const [fileTreeVisible, setFileTreeVisible] = useState(false)
  const [fileTreeLoading, setFileTreeLoading] = useState(false)
  const [fileTree, setFileTree] = useState<WorkspaceFileNode[]>([])
  const [fileTreeExpandedKeys, setFileTreeExpandedKeys] = useState<string[]>([])
  const [filePreviewPath, setFilePreviewPath] = useState('')
  const [filePreviewContent, setFilePreviewContent] = useState('')
  const [filePreviewLoading, setFilePreviewLoading] = useState(false)
  const [filePreviewTruncated, setFilePreviewTruncated] = useState(false)
  const [filePreviewError, setFilePreviewError] = useState('')
  const fileTreeData = useMemo(() => toAntdFileTree(fileTree), [fileTree])

  const loadWorkspaceTree = useCallback(async () => {
    if (!activeWorkspacePath) {
      setFileTree([])
      setFileTreeExpandedKeys([])
      return
    }
    setFileTreeLoading(true)
    try {
      const payload = await bridge.getWorkspaceFileTree()
      setFileTree(payload.nodes)
      setFileTreeExpandedKeys(payload.nodes.slice(0, 8).map((node) => node.path))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      msgApi.error(`读取文件树失败：${msg}`)
    } finally {
      setFileTreeLoading(false)
    }
  }, [activeWorkspacePath, bridge, msgApi])

  const previewWorkspaceFile = useCallback(
    async (relPath: string) => {
      setFilePreviewLoading(true)
      setFilePreviewError('')
      try {
        const result = await bridge.readWorkspaceFile(relPath)
        if (!result.ok) {
          setFilePreviewPath(relPath)
          setFilePreviewContent('')
          setFilePreviewTruncated(false)
          setFilePreviewError(result.error)
          return
        }
        setFilePreviewPath(result.path)
        setFilePreviewContent(result.content)
        setFilePreviewTruncated(result.truncated)
      } finally {
        setFilePreviewLoading(false)
      }
    },
    [bridge]
  )

  useEffect(() => {
    if (!fileTreeVisible) return
    void loadWorkspaceTree()
  }, [fileTreeVisible, loadWorkspaceTree])

  useEffect(() => {
    setFileTree([])
    setFileTreeExpandedKeys([])
    setFilePreviewPath('')
    setFilePreviewContent('')
    setFilePreviewTruncated(false)
    setFilePreviewError('')
  }, [activeWorkspaceId])

  return (
    <aside className="app-right-pane" style={{ width: `${width}px` }}>
      <div className="app-right-toolbar">
        <Button
          size="small"
          icon={<FileOutlined />}
          type={fileTreeVisible ? 'primary' : 'default'}
          onClick={() => setFileTreeVisible((prev) => !prev)}
        >
          文件
        </Button>
      </div>
      <div className="app-right-content">
        <div className="app-right-tree-panel">
          {fileTreeVisible ? (
            <div className="app-right-tree-wrap">
              {fileTreeLoading ? (
                <div className="app-right-tree-loading">
                  <Spin size="small" />
                  <Text type="secondary">正在加载文件树...</Text>
                </div>
              ) : fileTreeData.length ? (
                <Tree
                  showLine
                  className="app-right-tree"
                  treeData={fileTreeData}
                  expandedKeys={fileTreeExpandedKeys}
                  onExpand={(keys) => setFileTreeExpandedKeys(keys.map((x) => String(x)))}
                  onSelect={(_, info) => {
                    const relPath = String(info.node.key)
                    if (!info.node.isLeaf) return
                    void previewWorkspaceFile(relPath)
                  }}
                />
              ) : (
                <Text type="secondary" className="app-right-empty-tip">
                  当前工作区暂无可展示文件
                </Text>
              )}
            </div>
          ) : (
            <Text type="secondary" className="app-right-empty-tip">
              点击上方“文件”按钮显示文件树
            </Text>
          )}
        </div>
        <div className="app-right-preview-wrap">
          <div className="app-right-preview-header">
            <Text strong>{filePreviewPath || '文件内容'}</Text>
            {filePreviewTruncated ? <Tag color="warning">已截断</Tag> : null}
          </div>
          <div className="app-right-preview-body">
            {filePreviewLoading ? (
              <div className="app-right-preview-loading">
                <Spin size="small" />
                <Text type="secondary">正在读取文件...</Text>
              </div>
            ) : filePreviewError ? (
              <Text type="danger">{filePreviewError}</Text>
            ) : filePreviewContent ? (
              <pre className="app-right-preview-code">{filePreviewContent}</pre>
            ) : (
              <Text type="secondary" className="app-right-empty-tip">
                点击文件树中的文件即可预览内容
              </Text>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
