param(
    [string]$CheckCommand = "",
    [string]$BuildCommand = ""
)

function Run-Step {
    param(
        [string]$Name,
        [string]$Cmd
    )

    if ([string]::IsNullOrWhiteSpace($Cmd)) {
        return
    }

    Write-Host "===> 执行 $Name: $Cmd"
    Invoke-Expression $Cmd
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Name 失败，退出码: $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

Run-Step -Name "检查命令" -Cmd $CheckCommand
Run-Step -Name "构建命令" -Cmd $BuildCommand

Write-Host "===> 验证通过"
