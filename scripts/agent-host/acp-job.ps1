param(
    [Parameter(Mandatory)][string]$JobName,
    [switch]$Check,
    [int]$HostPid,
    [long]$HostStarted,
    [string]$Binary,
    [string]$WorkingDirectory,
    [string]$ChildArguments = ''
)
$ErrorActionPreference = 'Stop'
if ($JobName -cnotmatch '^Global\\YFE-ACP-[a-f0-9]{32}$') { throw 'Invalid job name' }
Add-Type -Path (Join-Path $PSScriptRoot 'acp-job.cs')
if ($Check) {
    if ([YfeAcpJob]::IsGone($JobName)) { exit 0 }
    exit 3
}
[YfeAcpJob]::Run($JobName, $HostPid, $HostStarted, $Binary, $WorkingDirectory, $ChildArguments)
