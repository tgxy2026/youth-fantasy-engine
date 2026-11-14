param(
    [Parameter(Mandatory)][ValidateSet('Setup', 'ElevatedSetup', 'Prepare')][string]$Action,
    [Parameter(Mandatory)][string]$Vault,
    [string]$ExpectedHostSid,
    [string]$Profile,
    [string]$Work,
    [string]$Temp,
    [string]$Component
)
$ErrorActionPreference = 'Stop'

function Assert-PlainDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Invalid ACP isolation directory'
    }
}

function Set-DirectoryAccess([string]$Path, [string]$AgentSid, [bool]$Writable) {
    Assert-PlainDirectory $Path
    $acl = [Security.AccessControl.DirectorySecurity][IO.Directory]::GetAccessControl(
        $Path, [Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
        $acl.RemoveAccessRuleSpecific($rule)
    }
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($hostSid, 'S-1-5-18', 'S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', $inherit, 'None', 'Allow'))
    }
    if ($AgentSid) {
        $agent = [Security.Principal.SecurityIdentifier]::new($AgentSid)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($agent, 'ReadAndExecute', $inherit, 'None', 'Allow'))
        if ($Writable) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($agent, 'Write', 'None', 'None', 'Allow'))
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($agent, 'Modify', $inherit, 'InheritOnly', 'Allow'))
        }
    }
    [IO.Directory]::SetAccessControl($Path, $acl)
}

function As-PsLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

$hostSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$identityFile = Join-Path $Vault 'identity.json'
try {
    Assert-PlainDirectory $Vault
    if ($Action -eq 'Setup') {
        Set-DirectoryAccess $Vault '' $false
        if (Test-Path -LiteralPath $identityFile) { exit 0 }
        $command = '& ' + (As-PsLiteral $PSCommandPath) + ' -Action ElevatedSetup -Vault ' +
            (As-PsLiteral $Vault) + ' -ExpectedHostSid ' + (As-PsLiteral $hostSid)
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        $result = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
        exit $result.ExitCode
    }
    if ($Action -eq 'ElevatedSetup') {
        if ($hostSid -ne $ExpectedHostSid) { exit 4 }
        if (Test-Path -LiteralPath $identityFile) { exit 0 }
        $name = 'YFEACP-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $bytes = [byte[]]::new(32)
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $password = ConvertTo-SecureString ('aA1!' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force
        [Array]::Clear($bytes, 0, $bytes.Length)
        $account = $null
        $created = $false
        try {
            $account = New-LocalUser -Name $name -Password $password -PasswordNeverExpires -UserMayNotChangePassword -Description 'Youth Fantasy Engine ACP isolated account'
            $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
            if (-not (Get-LocalGroupMember -SID $users | Where-Object SID -EQ $account.SID)) {
                Add-LocalGroupMember -SID $users -Member $account
            }
            $record = @{ version = 1; user = $name; sid = $account.SID.Value; password = (ConvertFrom-SecureString $password) }
            $temporary = Join-Path $Vault ($name + '.tmp')
            [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Compress))
            [IO.File]::Move($temporary, $identityFile)
            $created = $true
        } finally {
            $password.Dispose()
            if (-not $created -and $account) { Remove-LocalUser -SID $account.SID }
        }
        exit 0
    }
    $item = Get-Item -LiteralPath $identityFile -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid isolation identity file' }
    $identity = Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json
    if ($identity.version -ne 1 -or $identity.user -cnotmatch '^YFEACP-[a-f0-9]{10}$' -or
        $identity.sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or $identity.sid -eq $hostSid) {
        throw 'Invalid ACP isolation identity'
    }
    $account = Get-LocalUser -Name $identity.user
    if (-not $account.Enabled -or $account.SID.Value -ne $identity.sid) { throw 'ACP isolation identity changed' }
    foreach ($directory in @($Profile, $Work, $Temp)) { Set-DirectoryAccess $directory $identity.sid $true }
    Set-DirectoryAccess $Component $identity.sid $false
    Write-Output (@{ user = $identity.user; sid = $identity.sid } | ConvertTo-Json -Compress)
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().GetType().Name)
    exit 1
}
