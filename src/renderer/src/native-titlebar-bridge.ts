/**
 * 与主进程 `WINDOW_CAPTION_CONTROLS` 同步：任意 antd Modal / App.useModal / Modal.confirm
 * 等挂载到 `.ant-modal-root` 的层显示时，隐藏系统标题栏按钮区；全部消失后再显示。
 *
 * 仅用 `afterOpenChange` 会在入场动画结束前仍显示系统按钮（与 Cursor 等体验不一致），
 * 故以 DOM 可见性为准，并用 `requestAnimationFrame` 合并 MutationObserver 的抖动。
 */

let lastPushedVisible: boolean | null = null
let rafId = 0
let observer: MutationObserver | null = null

function pushCaptionVisibleToMain(visible: boolean): void {
  if (typeof window === 'undefined') return
  if (lastPushedVisible === visible) return
  lastPushedVisible = visible
  const b = window.bridge
  if (!b || typeof b.setCaptionControlsVisible !== 'function') return
  b.setCaptionControlsVisible(visible)
  // Windows 顶栏为 WCO 预留的 padding-right 在按钮收起后须收回，否则右侧会露一条与叠层不一致的色块
  if (b.platform === 'win32') {
    if (visible) {
      delete document.documentElement.dataset.awWcoSuppressed
    } else {
      document.documentElement.dataset.awWcoSuppressed = '1'
    }
  }
}

/**
 * 统计当前打开的 antd 模态层数量。
 * 使用 `[class~="…"]` 精确匹配 token，避免 `ant-modal-wrapper` 误匹配 `ant-modal-wrap`。
 */
function countVisibleAntdModalWraps(): number {
  let n = 0
  document.querySelectorAll<HTMLElement>('[class~="ant-modal-root"]').forEach((root) => {
    const wrap = root.querySelector<HTMLElement>('[class~="ant-modal-wrap"]')
    if (!wrap) return
    const cs = getComputedStyle(wrap)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    const op = parseFloat(cs.opacity)
    if (!Number.isNaN(op) && op < 0.02) return
    n++
  })
  return n
}

function flushCaptionFromDom(): void {
  rafId = 0
  pushCaptionVisibleToMain(countVisibleAntdModalWraps() === 0)
}

function scheduleCaptionSyncFromDom(): void {
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(flushCaptionFromDom)
}

/**
 * 在应用根挂载后调用一次；返回卸载函数（断开观察并在 teardown 时恢复系统按钮）。
 */
export function installCaptionBlockingOverlayObserver(): () => void {
  if (observer) {
    observer.disconnect()
    window.removeEventListener('resize', scheduleCaptionSyncFromDom)
    cancelAnimationFrame(rafId)
    observer = null
    rafId = 0
  }
  observer = new MutationObserver(() => {
    scheduleCaptionSyncFromDom()
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open']
  })
  window.addEventListener('resize', scheduleCaptionSyncFromDom)
  scheduleCaptionSyncFromDom()
  return () => {
    observer?.disconnect()
    observer = null
    window.removeEventListener('resize', scheduleCaptionSyncFromDom)
    cancelAnimationFrame(rafId)
    rafId = 0
    lastPushedVisible = null
    delete document.documentElement.dataset.awWcoSuppressed
    pushCaptionVisibleToMain(true)
  }
}

/** 热更新或异常后强制按当前 DOM 重算（例如 preload 就绪后） */
export function resetNativeTitlebarModalStack(): void {
  lastPushedVisible = null
  scheduleCaptionSyncFromDom()
}

/**
 * @deprecated 已由 `installCaptionBlockingOverlayObserver` 接管；保留为兼容旧调用，仅触发一次 DOM 重算。
 */
export function onNativeTitlebarModalOpenChange(): void {
  scheduleCaptionSyncFromDom()
}
