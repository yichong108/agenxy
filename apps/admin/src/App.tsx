import { Navigate, Route, Routes } from 'react-router-dom'

import { AdminLayout } from './layouts/AdminLayout'
import { UsersPage } from './pages/UsersPage'

/**
 * 后台管理根路由
 *
 * 默认进入用户列表；后续可在此扩展更多管理页面。
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<AdminLayout />}>
        <Route index element={<Navigate to="/users" replace />} />
        <Route path="users" element={<UsersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/users" replace />} />
    </Routes>
  )
}
