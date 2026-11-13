param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$expected = @{ 'agy_acp_server.exe' = 58314376; 'localharness_external.exe' = 155782808 }
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    if ($zip.Entries.Count -ne $expected.Count -or [IO.Directory]::Exists($Destination)) { throw 'Invalid ACP archive' }
    $seen = @{}
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        if (!$expected.ContainsKey($name) -or $seen.ContainsKey($name) -or $entry.Length -ne $expected[$name]) {
            throw 'Invalid ACP archive entry'
        }
        $seen[$name] = $true
    }
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($entry in $zip.Entries) {
        $target = [IO.Path]::Combine($Destination, $entry.FullName)
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally { $zip.Dispose() }
