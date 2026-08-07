import { app } from 'electron'

/**
 * 覆盖 package.json 的 scoped name（`@openworker/desktop`），
 * 使 `userData` 落在 `AppData\Roaming\OpenWorker`，而非 `@openworker\desktop`。
 *
 * 必须在 `app.ready` 之前、且在任何 `app.getPath('userData')` 之前调用
 *（本文件须作为主进程最早 import 之一）。
 */
app.setName('OpenWorker')
