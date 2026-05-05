param(
    [string]$Command = "",
    [string]$OutputFile = "../fixtures/reproduce-output.log"
)

if ([string]::IsNullOrWhiteSpace($Command)) {
    Write-Error "请通过 -Command 传入复现命令。示例: .\\reproduce.ps1 -Command `"npm run test`""
    exit 1
}

Write-Host "===> 开始复现: $Command"
Write-Host "===> 输出文件: $OutputFile"

try {
    Invoke-Expression $Command 2>&1 | Tee-Object -FilePath $OutputFile
    Write-Host "===> 复现执行完成"
} catch {
    Write-Error "复现命令执行失败: $($_.Exception.Message)"
    exit 1
}
