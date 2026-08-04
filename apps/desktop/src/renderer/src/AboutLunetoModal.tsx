import '@/renderer/src/AboutLunetoModal.scss'
import { App as AntdApp, Button, Modal, Spin, Typography } from 'antd'
import { useCallback } from 'react'

import lunetoLogoUrl from '@/renderer/src/assets/luneto-logo.png'
import { type AboutAppInfo, formatAboutAppCopyText, formatBuildIsoUtcHuman } from '@/shared/ipc'

export type AboutLunetoModalProps = {
  open: boolean
  info: AboutAppInfo | null
  onClose: () => void
}

export function AboutLunetoModal({ open, info, onClose }: AboutLunetoModalProps) {
  const { message: msgApi } = AntdApp.useApp()

  const handleCopy = useCallback(async () => {
    if (!info) return
    const text = formatAboutAppCopyText(info)
    try {
      await navigator.clipboard.writeText(text)
      msgApi.success('已复制版本信息')
    } catch {
      msgApi.error('复制失败，请手动选择文本复制')
    }
  }, [info, msgApi])

  const buildDisplay = info && info.buildIso ? (formatBuildIsoUtcHuman(info.buildIso) ?? '—') : '—'

  const commitDisplay = info?.gitCommit?.trim() ? info.gitCommit : '—'

  return (
    <Modal
      className="about-luneto-modal"
      title="关于 Luneto"
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="copy" onClick={() => void handleCopy()} disabled={!info}>
          复制版本信息
        </Button>,
        <Button key="ok" type="primary" onClick={onClose}>
          确定
        </Button>
      ]}
      width={560}
      centered
      destroyOnHidden
    >
      {!info ? (
        <div className="about-luneto-modal__loading">
          <Spin tip="加载中…" />
        </div>
      ) : (
        <div className="about-luneto-modal__row">
          <div className="about-luneto-modal__logo">
            <img src={lunetoLogoUrl} alt="" width={72} height={72} />
          </div>
          <div className="about-luneto-modal__main">
            <div className="about-luneto-modal__list">
              <div className="about-luneto-modal__kv">
                <span className="about-luneto-modal__k">版本</span>
                <span className="about-luneto-modal__v">{info.version}</span>
              </div>
              <div className="about-luneto-modal__kv">
                <span className="about-luneto-modal__k">提交</span>
                <span className="about-luneto-modal__v">
                  {commitDisplay === '—' ? (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ) : (
                    <Typography.Text code copyable={{ text: info.gitCommit }}>
                      {commitDisplay}
                    </Typography.Text>
                  )}
                </span>
              </div>
              <div className="about-luneto-modal__kv">
                <span className="about-luneto-modal__k">构建</span>
                <span className="about-luneto-modal__v">
                  <Typography.Text type="secondary">{buildDisplay}</Typography.Text>
                </span>
              </div>
              <div className="about-luneto-modal__kv">
                <span className="about-luneto-modal__k">Electron</span>
                <span className="about-luneto-modal__v">{info.electron}</span>
              </div>
              <div className="about-luneto-modal__kv">
                <span className="about-luneto-modal__k">Chromium</span>
                <span className="about-luneto-modal__v">{info.chrome}</span>
              </div>
              <div className="about-luneto-modal__kv">
                <span className="about-luneto-modal__k">Node.js</span>
                <span className="about-luneto-modal__v">{info.node}</span>
              </div>
              <div className="about-luneto-modal__kv">
                <span className="about-luneto-modal__k">V8</span>
                <span className="about-luneto-modal__v">{info.v8 || '—'}</span>
              </div>
              <div className="about-luneto-modal__kv">
                <span className="about-luneto-modal__k">操作系统</span>
                <span className="about-luneto-modal__v about-luneto-modal__v--wrap">
                  {info.osLine}
                </span>
              </div>
            </div>
            <div className="about-luneto-modal__copyright">© 2026 Luneto</div>
          </div>
        </div>
      )}
    </Modal>
  )
}
