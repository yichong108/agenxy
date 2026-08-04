import type { AuthUserListItem } from '@agenwork/shared'
import { Alert, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'

import { fetchUsers } from '../api/users-api'

/**
 * 角色标签颜色映射
 *
 * @param role - 用户角色字符串
 */
function roleColor(role: string): string {
  if (role === 'admin') return 'red'
  return 'blue'
}

const columns: ColumnsType<AuthUserListItem> = [
  {
    title: '用户名',
    dataIndex: 'username',
    key: 'username'
  },
  {
    title: '角色',
    dataIndex: 'role',
    key: 'role',
    width: 120,
    render: (role: string) => <Tag color={roleColor(role)}>{role}</Tag>
  },
  {
    title: '用户 ID',
    dataIndex: 'id',
    key: 'id',
    ellipsis: true
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    key: 'createdAt',
    width: 200,
    render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss')
  }
]

/**
 * 用户列表页
 *
 * 挂载时请求 `GET /users`，以表格展示全部用户公开信息。
 */
export function UsersPage() {
  const [users, setUsers] = useState<AuthUserListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const list = await fetchUsers()
        if (!cancelled) {
          setUsers(list)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        用户列表
      </Typography.Title>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Table<AuthUserListItem>
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={users}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />
    </Space>
  )
}
