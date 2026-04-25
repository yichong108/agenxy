import { spawn, spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  // Ensure the active terminal code page is UTF-8 to avoid mojibake.
  spawnSync('chcp', ['65001'], { shell: true, stdio: 'ignore' })
}

const child = spawn('electron-vite', ['dev'], {
  shell: true,
  stdio: 'inherit',
  env: process.env
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
