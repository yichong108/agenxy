import { App as AntdApp, Alert, Button, Space, Table, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import type { SkillsMarketCatalogItem } from '@/shared/ipc'

import { fetchSkillsCatalogPage } from './catalog-fetch'

import '@/renderer/src/skills-market/SkillsMarketPanel.scss'

const { Link } = Typography

const PAGE_SIZE = 10

/** 技能市场表格可视区域高度（表头固定，表体滚动；分页在表格外） */
const MARKET_TABLE_BODY_MAX_HEIGHT = 400

type PageRow = {
  items: SkillsMarketCatalogItem[]
  nextCursor: string | null
}

export type SkillsMarketPanelProps = {
  installedMarketFolderIds: Set<string>
  installingId: string | null
  onInstall: (item: SkillsMarketCatalogItem) => void | Promise<void>
}

export function SkillsMarketPanel({
  installedMarketFolderIds,
  installingId,
  onInstall
}: SkillsMarketPanelProps) {
  const { message: msgApi } = AntdApp.useApp()
  const cacheRef = useRef<Record<number, PageRow>>({})
  const [cache, setCache] = useState<Record<number, PageRow>>({})
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** 上一次非加载态下的分页 total，用于刷新清空缓存时避免 total=0 导致分页条消失、布局跳动 */
  const lastStablePaginationTotalRef = useRef(0)

  const loadPage = useCallback(
    async (targetPage: number) => {
      if (cacheRef.current[targetPage]) return

      setLoading(true)
      setError(null)
      try {
        for (let p = 1; p <= targetPage; p++) {
          if (cacheRef.current[p]) continue

          let cursor: string | undefined
          if (p === 1) {
            cursor = undefined
          } else {
            const prev = cacheRef.current[p - 1]
            const nc = prev?.nextCursor
            if (!nc) {
              setError('已到列表末尾')
              break
            }
            cursor = nc
          }

          const r = await fetchSkillsCatalogPage({
            cursor,
            limit: PAGE_SIZE
          })

          if (!r.ok) {
            msgApi.error(r.error)
            setError(r.error)
            break
          }

          cacheRef.current[p] = {
            items: r.items,
            nextCursor: r.nextCursor
          }
          setCache({ ...cacheRef.current })
        }
      } finally {
        setLoading(false)
      }
    },
    [msgApi]
  )

  const refresh = useCallback(async () => {
    cacheRef.current = {}
    setCache({})
    setError(null)
    if (page === 1) {
      await loadPage(1)
    } else {
      setPage(1)
    }
  }, [loadPage, page])

  useEffect(() => {
    void loadPage(page)
  }, [page, loadPage])

  const pageItems = cache[page]?.items ?? []
  const hasNext = Boolean(cache[page]?.nextCursor)
  const rawPaginationTotal = useMemo(
    () => (hasNext ? page * PAGE_SIZE + PAGE_SIZE : (page - 1) * PAGE_SIZE + pageItems.length),
    [page, hasNext, pageItems.length]
  )

  useEffect(() => {
    if (!loading && rawPaginationTotal > 0) {
      lastStablePaginationTotalRef.current = rawPaginationTotal
    }
  }, [loading, rawPaginationTotal])

  const paginationTotal =
    loading && rawPaginationTotal === 0
      ? Math.max(lastStablePaginationTotalRef.current, PAGE_SIZE)
      : rawPaginationTotal

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" loading={loading} onClick={() => void refresh()}>
          刷新列表
        </Button>
      </Space>
      {error && pageItems.length === 0 ? (
        <Alert type="error" showIcon message={error} />
      ) : (
        <Table<SkillsMarketCatalogItem>
          className="skills-market-catalog-table"
          style={
            {
              ['--skills-market-table-body-min' as string]: `${MARKET_TABLE_BODY_MAX_HEIGHT}px`
            } as CSSProperties
          }
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={pageItems}
          locale={{ emptyText: '当前页没有条目' }}
          scroll={{ y: MARKET_TABLE_BODY_MAX_HEIGHT }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: paginationTotal,
            showSizeChanger: false,
            showTotal: (total, range) =>
              hasNext
                ? `第 ${range[0]}-${range[1]} 条（后方还有更多，翻页继续加载）`
                : `共 ${total} 条`,
            onChange: (p) => setPage(p)
          }}
          columns={[
            { title: '名称', dataIndex: 'name', width: 160, ellipsis: true },
            {
              title: '描述',
              dataIndex: 'description',
              ellipsis: true,
              render: (t: string) => (
                <Tooltip title={t}>
                  <span>{t}</span>
                </Tooltip>
              )
            },
            { title: '版本', dataIndex: 'version', width: 88 },
            {
              title: '包地址',
              dataIndex: 'packageUrl',
              ellipsis: true,
              render: (u: string) => (
                <Link href={u} onClick={(e) => e.preventDefault()}>
                  <span title={u}>{u}</span>
                </Link>
              )
            },
            {
              title: '操作',
              key: 'actions',
              width: 140,
              render: (_, item) => {
                const installed = installedMarketFolderIds.has(item.id)
                return (
                  <Button
                    type="primary"
                    size="small"
                    disabled={installed}
                    loading={installingId === item.id}
                    onClick={() => void onInstall(item)}
                  >
                    {installed ? '已安装' : '安装'}
                  </Button>
                )
              }
            }
          ]}
        />
      )}
    </div>
  )
}
