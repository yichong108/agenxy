import { UserOutlined } from '@ant-design/icons'
import { Layout, Menu, theme, Typography } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

const { Header, Sider, Content } = Layout

/** 侧栏菜单项：当前仅用户列表，后续可按需扩展 */
const MENU_ITEMS = [
  {
    key: '/users',
    icon: <UserOutlined />,
    label: '用户列表'
  }
]

/**
 * 后台管理主布局
 *
 * 左侧菜单 + 顶栏标题 + 内容区 Outlet。默认选中与当前路由对应的菜单项。
 */
export function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    token: { colorBgContainer, borderRadiusLG }
  } = theme.useToken()

  const selectedKey = location.pathname.startsWith('/users') ? '/users' : location.pathname

  return (
    <Layout style={{ minHeight: '100%' }}>
      <Sider breakpoint="lg" collapsedWidth={64} theme="dark">
        <div
          style={{
            height: 48,
            margin: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 600,
            letterSpacing: 0.5
          }}
        >
          OpenWorker
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            padding: '0 24px',
            background: colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            borderBottom: '1px solid #f0f0f0'
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            后台管理
          </Typography.Title>
        </Header>
        <Content style={{ margin: 24 }}>
          <div
            style={{
              padding: 24,
              minHeight: 360,
              background: colorBgContainer,
              borderRadius: borderRadiusLG
            }}
          >
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}
