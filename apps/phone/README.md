# @luneto/phone

Luneto 移动端客户端（Expo + React Native）。

## 开发

```bash
pnpm phone:dev
# 或
pnpm --filter @luneto/phone start
```

启动后可用 Expo Go 扫码，或按 `a` / `i` / `w` 分别打开 Android / iOS / Web。

## Android 真机连不上（Failed to download remote update）

`pnpm phone:dev` 会自动选用真实 WLAN IP（跳过 VMware / Clash / Hyper-V），并打印类似：

```text
[phone] Metro host -> 10.209.4.242 (exp://10.209.4.242:8081)
```

也可手动指定：

```powershell
$env:REACT_NATIVE_PACKAGER_HOSTNAME = "10.x.x.x"
pnpm phone:dev
```

USB 调试备选：

```powershell
adb reverse tcp:8081 tcp:8081
# Expo Go：exp://127.0.0.1:8081
```
