param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RequestedBatches
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$testsDir = Join-Path $repoRoot 'tests'
$manifestPath = Join-Path $testsDir 'run-batches.sh'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  Write-Error "找不到批次清单：$manifestPath"
  exit 1
}

$batchLists = @{}
foreach ($line in Get-Content -LiteralPath $manifestPath) {
  if ($line -match '^BATCH_([A-D])="([^"]*)"$') {
    $batchLists[$Matches[1]] = @($Matches[2] -split '\s+' | Where-Object { $_ })
  }
}

if (@('A', 'B', 'C', 'D' | Where-Object { -not $batchLists.ContainsKey($_) }).Count -gt 0) {
  Write-Error "批次清单缺少 A/B/C/D 定义：$manifestPath"
  exit 1
}

$declared = @('A', 'B', 'C', 'D' | ForEach-Object { $batchLists[$_] })
$actual = @(Get-ChildItem -LiteralPath $testsDir -Filter '*.test.ts' -File | ForEach-Object {
  $_.Name.Substring(0, $_.Name.Length - '.test.ts'.Length)
})
$ghost = @($declared | Where-Object { $_ -notin $actual } | Sort-Object -Unique)
$unbatched = @($actual | Where-Object { $_ -notin $declared } | Sort-Object -Unique)
$duplicates = @($declared | Group-Object | Where-Object Count -gt 1 | ForEach-Object Name)

if ($ghost.Count -gt 0) {
  Write-Error "批次清单有不存在的入口：$($ghost -join ' ')"
}
if ($unbatched.Count -gt 0) {
  Write-Error "有测试文件未归入批次：$($unbatched -join ' ')"
}
if ($duplicates.Count -gt 0) {
  Write-Error "批次清单有重复入口：$($duplicates -join ' ')"
}
if ($ghost.Count -gt 0 -or $unbatched.Count -gt 0 -or $duplicates.Count -gt 0) {
  exit 1
}

$requested = @($RequestedBatches | Where-Object { $_ })
if ($requested.Count -eq 0 -or $requested -contains 'all') {
  $requested = @('A', 'B', 'C', 'D')
}
$invalid = @($requested | Where-Object { $_ -notin @('A', 'B', 'C', 'D') } | Sort-Object -Unique)
if ($invalid.Count -gt 0) {
  Write-Error "未知批次：$($invalid -join ', ')（可选 A / B / C / D / all）"
  exit 1
}

$nodePath = $env:NODE_BIN
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  $managedNode = 'C:\Users\18223\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
  if (Test-Path -LiteralPath $managedNode -PathType Leaf) {
    $nodePath = $managedNode
  } else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodePath = $nodeCommand.Source }
  }
}
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  Write-Error '找不到 Node.js。请安装 Node.js，或设置 NODE_BIN 指向 node.exe。'
  exit 1
}

$buildTest = Join-Path $testsDir 'build-test.mjs'
$totalOk = 0
$totalBad = 0
$failed = @()
$clock = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($batch in $requested) {
  $entries = $batchLists[$batch]
  $batchClock = [System.Diagnostics.Stopwatch]::StartNew()
  $batchOk = 0
  $batchFailed = @()
  $failedOutput = @{}

  Write-Output "════ 批次 $batch ════"
  foreach ($entry in $entries) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = @(& $nodePath $buildTest $entry 2>&1)
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($exitCode -eq 0) {
      $batchOk++
    } else {
      $batchFailed += $entry
      $failedOutput[$entry] = $output
    }
  }

  $batchClock.Stop()
  $batchBad = $batchFailed.Count
  $totalOk += $batchOk
  $totalBad += $batchBad
  $failed += $batchFailed

  if ($batchBad -eq 0) {
    Write-Output "  ✅ $batchOk / $($entries.Count) 通过 · $([int]$batchClock.Elapsed.TotalSeconds)s"
  } else {
    Write-Output "  ❌ $batchOk / $($entries.Count) 通过 · $([int]$batchClock.Elapsed.TotalSeconds)s"
    foreach ($entry in $batchFailed) {
      Write-Output "     FAIL $entry"
      $failureLines = @($failedOutput[$entry] | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message }
        else { [string] $_ }
      } | Where-Object { $_.Trim() })
      $failureLines | Select-Object -First 8 | ForEach-Object {
        Write-Output "       $($_.Trim())"
      }
    }
  }
  Write-Output ''
}

$clock.Stop()
Write-Output '════ 汇总 ════'
Write-Output "  通过 $totalOk，失败 $totalBad，总耗时 $([int]$clock.Elapsed.TotalSeconds)s"
if ($totalBad -gt 0) {
  $failedSummary = $failed -join ' '
  Write-Output "  失败入口：$failedSummary"
  exit 1
}
Write-Output '  ✅ 全绿'
