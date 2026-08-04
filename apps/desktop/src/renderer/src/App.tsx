import '@/renderer/src/App.scss'
import { BugOutlined } from '@ant-design/icons'
import { App as AntdApp, ConfigProvider, FloatButton, Menu, MenuProps, Spin } from 'antd'
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { AboutOpenworkModal } from '@/renderer/src/AboutOpenworkModal'
import openworkLogoUrl from '@/renderer/src/assets/openwork-logo.png'
import { LoginPage } from '@/renderer/src/auth/LoginPage'
import { WorkspaceCenterPane } from '@/renderer/src/center-pane'
import { WorkspaceLeftPane } from '@/renderer/src/left-pane'
import { renderLog } from '@/renderer/src/logger'
import {
  installCaptionBlockingOverlayObserver,
  resetNativeTitlebarModalStack
} from '@/renderer/src/native-titlebar-bridge'
import { WorkspaceRightPane } from '@/renderer/src/right-pane/WorkspaceRightPane'
import { useAuthStore } from '@/renderer/src/store/auth-store'
import { useUiStore } from '@/renderer/src/store/ui-store'
import { useWorkspaceStore } from '@/renderer/src/store/workspace-store'
import { type AboutAppInfo, HOME_WORKSPACE_ID } from '@/shared/ipc'

/** Windows 标题栏子菜单弹层 class，与 App.scss 中 `.ant-menu-submenu-popup.app-win-menubar-popup` 对应 */
const WIN_MENUBAR_POPUP_CLASS_NAME = 'app-win-menubar-popup'

const WIN_MENUBAR_MENU_THEME = {
  components: {
    Menu: {
      itemHeight: 28,
      itemMarginBlock: 0,
      itemMarginInline: 0,
      itemPaddingInline: 10
    }
  }
} as const

export function App() {
  const authHydrated = useAuthStore((s) => s.hydrated)
  const accessToken = useAuthStore((s) => s.accessToken)
  const hydrateAuth = useAuthStore((s) => s.hydrate)

  useEffect(() => {
    void hydrateAuth()
  }, [hydrateAuth])

  if (!authHydrated) {
    return (
      <div className="app-auth-boot">
        <Spin size="large" />
      </div>
    )
  }

  if (!accessToken) {
    return <LoginPage />
  }

  return <AuthenticatedAppShell />
}

/**
 * 已登录后的主工作区壳（三栏布局）
 *
 * 与登录闸门分离，避免未登录时仍初始化工作区相关副作用。
 */
function AuthenticatedAppShell() {
  const RIGHT_PANE_MIN_WIDTH = 420
  const RIGHT_PANE_MAX_WIDTH = 860
  const RIGHT_PANE_DEFAULT_WIDTH = 560

  const { message: msgApi } = AntdApp.useApp()
  const preloadOk = typeof window !== 'undefined' && typeof window.bridge !== 'undefined'
  const bridge = window.bridge
  const isWinCustomChrome = preloadOk && bridge.platform === 'win32'
  const isDevEnv = import.meta.env.DEV

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId)

  const composerSelectedWorkspaceId = useMemo(
    () => activeWorkspaceId ?? HOME_WORKSPACE_ID,
    [activeWorkspaceId]
  )

  const workspacesWithComposerHomeStub = useMemo(() => {
    if (workspaces.some((w) => w.id === HOME_WORKSPACE_ID)) return workspaces
    return [
      {
        id: HOME_WORKSPACE_ID,
        name: '主目录',
        path: null,
        createdAt: 0,
        updatedAt: 0
      },
      ...workspaces
    ]
  }, [workspaces])

  useEffect(() => {
    if (!preloadOk) return
    resetNativeTitlebarModalStack()
    return installCaptionBlockingOverlayObserver()
  }, [preloadOk])

  const [aboutOpen, setAboutOpen] = useState(false)
  const [aboutInfo, setAboutInfo] = useState<AboutAppInfo | null>(null)

  const openAboutOpenwork = useCallback(async () => {
    setAboutOpen(true)
    setAboutInfo(null)
    try {
      const info = await bridge.showAbout()
      setAboutInfo(info)
    } catch (e) {
      renderLog.warn('[about] 拉取版本信息失败', e)
      setAboutOpen(false)
      msgApi.error('无法加载关于信息')
    }
  }, [bridge, msgApi])

  const winMenubarItems: MenuProps['items'] = useMemo(() => {
    if (!isWinCustomChrome) return []
    const viewChildren: MenuProps['items'] = [
      {
        key: 'reload',
        label: '重新加载',
        onClick: () => {
          void bridge.windowAction('reload')
        }
      }
    ]
    return [
      {
        key: 'file',
        label: '文件',
        popupClassName: WIN_MENUBAR_POPUP_CLASS_NAME,
        children: [
          {
            key: 'quit',
            label: '退出',
            onClick: () => {
              void bridge.windowAction('quit')
            }
          }
        ]
      },
      {
        key: 'view',
        label: '视图',
        popupClassName: WIN_MENUBAR_POPUP_CLASS_NAME,
        children: viewChildren
      },
      {
        key: 'help',
        label: '帮助',
        popupClassName: WIN_MENUBAR_POPUP_CLASS_NAME,
        children: [
          {
            key: 'about',
            label: '关于 Openwork',
            onClick: () => void openAboutOpenwork()
          }
        ]
      }
    ]
  }, [bridge, isWinCustomChrome, openAboutOpenwork])

  const [rightPaneWidth, setRightPaneWidth] = useState(RIGHT_PANE_DEFAULT_WIDTH)
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(true)
  const [isRightPaneResizing, setIsRightPaneResizing] = useState(false)
  const rightPaneResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const rightPaneExpandedWidthRef = useRef(RIGHT_PANE_DEFAULT_WIDTH)
  const [leftTogglePortalHost, setLeftTogglePortalHost] = useState<HTMLDivElement | null>(null)

  const handleRightPaneResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isRightPaneCollapsed) return
      if (event.button !== 0) return
      event.preventDefault()
      rightPaneResizeStartRef.current = {
        startX: event.clientX,
        startWidth: rightPaneWidth
      }
      setIsRightPaneResizing(true)
    },
    [isRightPaneCollapsed, rightPaneWidth]
  )

  const handleRightPaneCollapseToggle = useCallback(() => {
    setIsRightPaneCollapsed((prev) => {
      if (prev) {
        setRightPaneWidth(rightPaneExpandedWidthRef.current)
        return false
      }
      rightPaneExpandedWidthRef.current = rightPaneWidth
      return true
    })
  }, [rightPaneWidth])

  const handleRightPaneExpand = useCallback(() => {
    if (!isRightPaneCollapsed) return
    handleRightPaneCollapseToggle()
  }, [handleRightPaneCollapseToggle, isRightPaneCollapsed])

  useEffect(() => {
    if (!isRightPaneResizing) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const dragState = rightPaneResizeStartRef.current
      if (!dragState) return
      const delta = event.clientX - dragState.startX
      const nextWidth = Math.min(
        RIGHT_PANE_MAX_WIDTH,
        Math.max(RIGHT_PANE_MIN_WIDTH, dragState.startWidth - delta)
      )
      setRightPaneWidth(nextWidth)
      rightPaneExpandedWidthRef.current = nextWidth
    }

    const handleMouseUp = () => {
      rightPaneResizeStartRef.current = null
      setIsRightPaneResizing(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleMouseUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [isRightPaneResizing, RIGHT_PANE_MAX_WIDTH, RIGHT_PANE_MIN_WIDTH])

  const toggleDevtools = async () => {
    bridge
      .toggleDevtools()
      .then(() => {
        setTimeout(() => {
          window.location.reload()
        }, 1000)
      })
      .catch((err: Error) => {
        console.error('打开 DevTools 失败:', err)
      })
  }

  return (
    <div className="app-shell">
      {isWinCustomChrome ? (
        <div className="app-win-titlebar">
          <span className="app-brand-logo-visual app-brand-logo-visual--titlebar">
            <img
              src={openworkLogoUrl}
              alt=""
              width={15}
              height={15}
              className="app-win-titlebar-brand-logo"
              draggable={false}
            />
          </span>
          <ConfigProvider theme={WIN_MENUBAR_MENU_THEME}>
            <Menu
              mode="horizontal"
              selectable={false}
              triggerSubMenuAction="click"
              items={winMenubarItems}
              className="app-win-menubar"
            />
          </ConfigProvider>
          <div className="app-win-titlebar-spacer" aria-hidden />
        </div>
      ) : null}
      <div className={`app-body ${isRightPaneResizing ? 'is-right-resizing' : ''}`}>
        <WorkspaceLeftPane leftTogglePortalHost={leftTogglePortalHost} />
        <WorkspaceCenterPane
          isWinCustomChrome={isWinCustomChrome}
          isRightPaneCollapsed={isRightPaneCollapsed}
          onRightPaneExpand={handleRightPaneExpand}
          onLeftTogglePortalHostChange={setLeftTogglePortalHost}
        />
        {!isRightPaneCollapsed ? (
          <div
            className={`app-right-resizer ${isRightPaneResizing ? 'is-dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整右侧栏宽度"
            onMouseDown={handleRightPaneResizeStart}
          />
        ) : null}
        <WorkspaceRightPane
          bridge={bridge}
          activeWorkspaceId={composerSelectedWorkspaceId}
          activeWorkspacePath={
            workspacesWithComposerHomeStub.find((x) => x.id === composerSelectedWorkspaceId)
              ?.path ?? null
          }
          width={isRightPaneCollapsed ? 0 : rightPaneWidth}
          isCollapsed={isRightPaneCollapsed}
          onToggleCollapse={handleRightPaneCollapseToggle}
        />
      </div>

      <AboutOpenworkModal
        open={aboutOpen}
        info={aboutInfo}
        onClose={() => {
          setAboutOpen(false)
          setAboutInfo(null)
        }}
      />

      {isDevEnv && (
        <FloatButton
          icon={<BugOutlined />}
          tooltip="切换开发者工具"
          onClick={() => void toggleDevtools()}
          className="app-devtools-float"
        />
      )}
    </div>
  )
}
