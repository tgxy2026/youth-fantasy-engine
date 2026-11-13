param(
    [Parameter(Mandatory)][string]$JobName,
    [switch]$Check,
    [int]$HostPid,
    [long]$HostStarted,
    [string]$Binary,
    [string]$WorkingDirectory,
    [string]$ChildArguments = '',
    [string]$SandboxUser,
    [string]$SandboxSid,
    [string]$SandboxCredentialFile
)
$ErrorActionPreference = 'Stop'
if ($JobName -cnotmatch '^Global\\YFE-ACP-[a-f0-9]{32}$') { throw 'Invalid job name' }
Add-Type -Path (Join-Path $PSScriptRoot 'acp-job.cs')
if ($Check) {
    if ([YfeAcpJob]::IsGone($JobName)) { exit 0 }
    exit 3
}
$password = $null
try {
    if ($PSBoundParameters.ContainsKey('SandboxUser') -or
        $PSBoundParameters.ContainsKey('SandboxSid') -or
        $PSBoundParameters.ContainsKey('SandboxCredentialFile')) {
        if ($SandboxUser -cnotmatch '^YFEACP-[a-f0-9]{10}$' -or
            $SandboxSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or
            -not [IO.Path]::IsPathRooted($SandboxCredentialFile)) {
            throw 'Invalid ACP sandbox identity configuration'
        }
        $account = [Security.Principal.NTAccount]::new([Environment]::MachineName, $SandboxUser)
        $current = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            $resolvedSid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($resolvedSid -ne $SandboxSid -or $resolvedSid -eq $current.User.Value) {
                throw 'ACP sandbox account changed'
            }
        } finally { $current.Dispose() }
        $password = ConvertTo-SecureString -String ([IO.File]::ReadAllText($SandboxCredentialFile))
    }
    exit [YfeAcpJob]::Run($JobName, $HostPid, $HostStarted, $Binary, $WorkingDirectory,
        $ChildArguments, $SandboxUser, $SandboxSid, $password)
} catch {
    # Report only the Windows error number or exception type. PowerShell's full
    # error formatting may include the input to ConvertTo-SecureString.
    $failure = $_.Exception.GetBaseException()
    if ($failure -is [ComponentModel.Win32Exception]) {
        [Console]::Error.WriteLine("ACP launcher failed (Windows error {0}).", $failure.NativeErrorCode)
    } else {
        [Console]::Error.WriteLine("ACP launcher failed ({0}).", $failure.GetType().Name)
    }
    exit 1
} finally {
    if ($null -ne $password) { $password.Dispose() }
}
