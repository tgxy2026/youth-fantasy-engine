$ErrorActionPreference = 'Stop'
$Pipe = $env:YFE_RELAY_PIPE
$Binary = $env:YFE_RELAY_BINARY
$Arguments = $env:YFE_RELAY_ARGUMENTS
Remove-Item Env:YFE_RELAY_PIPE, Env:YFE_RELAY_BINARY, Env:YFE_RELAY_ARGUMENTS -ErrorAction SilentlyContinue
$definition = @'
using System.IO;
using System.Threading.Tasks;
public static class YfeAcpPipeRelay {
    public static Task CopyInput(Stream source, Stream target) {
        return Task.Run(() => {
            try {
                var buffer = new byte[8192];
                int count;
                while ((count = source.Read(buffer, 0, buffer.Length)) != 0) {
                    target.Write(buffer, 0, count);
                    target.Flush();
                }
            } catch (IOException) { }
            catch (System.ObjectDisposedException) { }
        });
    }
}
'@
Add-Type -TypeDefinition $definition
$connection = @{}
foreach ($name in @('in', 'out', 'err')) {
    $direction = if ($name -eq 'in') { 'In' } else { 'Out' }
    $channel = [IO.Pipes.NamedPipeClientStream]::new('.', "$Pipe-$name", $direction,
        [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Identification)
    $channel.Connect(8000)
    $connection[$name] = $channel
}
try {
    $info = [Diagnostics.ProcessStartInfo]::new($Binary, $Arguments)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = (Get-Location).Path
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($info)
    try {
        $inputTask = [YfeAcpPipeRelay]::CopyInput($connection['in'], $child.StandardInput.BaseStream)
        $stdout = $child.StandardOutput.BaseStream.CopyToAsync($connection['out'])
        $stderr = $child.StandardError.BaseStream.CopyToAsync($connection['err'])
        while (-not $child.WaitForExit(100)) {
            if ($inputTask.IsCompleted) { $child.StandardInput.Close(); break }
        }
        $child.WaitForExit()
        [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), 2500) | Out-Null
        exit $child.ExitCode
    } finally { $child.Dispose() }
} finally {
    foreach ($channel in $connection.Values) { $channel.Dispose() }
}
