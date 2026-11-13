using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
using System.Threading;
using System.Threading.Tasks;

public static class YfeAcpJob {
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public short Show, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes {
        public int Size;
        public IntPtr Descriptor;
        public int Inherit;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessWithLogonW(string user, string domain, IntPtr password, uint logonFlags,
        string binary, StringBuilder commandLine, uint flags, IntPtr environment, string cwd,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int informationClass, out int value, int length, out int written);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SecurityAttributes attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(SafeFileHandle handle, int mask, int flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    public static bool IsGone(string name) {
        IntPtr job = OpenJobObject(4, false, name);
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) return true;
            throw new Win32Exception(error);
        }
        CloseHandle(job);
        return false;
    }

    public static int Run(string name, int parentId, long parentStarted, string binary, string cwd, string arguments,
        string sandboxUser, string sandboxSid, System.Security.SecureString sandboxPassword) {
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new Win32Exception();
        if (Marshal.GetLastWin32Error() == 183) {
            CloseHandle(job);
            throw new InvalidOperationException("Job name already exists");
        }
        try {
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
                throw new Win32Exception();
            using (var self = Process.GetCurrentProcess())
            using (var parent = Process.GetProcessById(parentId)) {
                // Hold the actual parent handle before launching. PID reuse is insufficient proof.
                IntPtr parentHandle = parent.Handle;
                long actualStarted = (long)(parent.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1)).TotalMilliseconds;
                if (Math.Abs(actualStarted - parentStarted) > 3000 || parent.HasExited)
                    throw new InvalidOperationException("Host identity changed");
                if (!AssignProcessToJobObject(job, self.Handle)) throw new Win32Exception();
                if (sandboxPassword != null)
                    return RunIsolated(job, parent, binary, cwd, arguments, sandboxUser, sandboxSid, sandboxPassword);
                var start = new ProcessStartInfo(binary, arguments);
                start.WorkingDirectory = cwd;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardInput = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                // The supervisor is already in the job. The Agent and descendants inherit membership.
                using (var child = Process.Start(start)) {
                    var output = Relay(child.StandardInput.BaseStream, child.StandardOutput.BaseStream, child.StandardError.BaseStream);
                    while (!child.WaitForExit(100) && !parent.HasExited) { }
                    if (!child.HasExited) return 1;
                    Task.WaitAll(output, 500);
                    return child.ExitCode;
                }
            }
        } finally { CloseHandle(job); }
    }

    static Task[] Relay(Stream childInput, Stream childOutput, Stream childError) {
        var inputThread = new Thread(() => {
            try {
                using (childInput) {
                    var input = Console.OpenStandardInput(0);
                    var buffer = new byte[8192];
                    int count;
                    while ((count = input.Read(buffer, 0, buffer.Length)) != 0) {
                        childInput.Write(buffer, 0, count);
                        childInput.Flush();
                    }
                }
            } catch (IOException) { }
            catch (ObjectDisposedException) { }
        });
        inputThread.IsBackground = true;
        inputThread.Start();
        return new[] {
            childOutput.CopyToAsync(Console.OpenStandardOutput()),
            childError.CopyToAsync(Console.OpenStandardError())
        };
    }

    sealed class RedirectPipe : IDisposable {
        public readonly SafeFileHandle Child, Host;

        public RedirectPipe(bool input) {
            var attributes = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
            SafeFileHandle read, write;
            if (!CreatePipe(out read, out write, ref attributes, 0)) throw new Win32Exception();
            Child = input ? read : write;
            Host = input ? write : read;
            if (!SetHandleInformation(Host, 1, 0)) {
                var error = new Win32Exception();
                Dispose();
                throw error;
            }
        }

        public void Dispose() { Child.Dispose(); Host.Dispose(); }
    }

    static void VerifyIsolatedIdentity(IntPtr process, string expectedSid) {
        IntPtr token;
        if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception(); // TOKEN_QUERY
        try {
            using (var actual = new WindowsIdentity(token))
            using (var host = WindowsIdentity.GetCurrent()) {
                int elevation, written;
                if (!GetTokenInformation(token, 18, out elevation, sizeof(int), out written))
                    throw new Win32Exception(); // TokenElevationType
                var principal = new WindowsPrincipal(actual);
                if (actual.User.Value != expectedSid || actual.User.Equals(host.User) || elevation != 1 ||
                    principal.IsInRole(WindowsBuiltInRole.Administrator))
                    throw new InvalidOperationException("Unexpected ACP sandbox identity");
            }
        } finally { CloseHandle(token); }
    }

    static int RunIsolated(IntPtr job, Process parent, string binary, string cwd, string arguments,
        string user, string sid, System.Security.SecureString password) {
        using (var input = new RedirectPipe(true))
        using (var output = new RedirectPipe(false))
        using (var error = new RedirectPipe(false)) {
            var startup = new StartupInfo {
                Size = Marshal.SizeOf(typeof(StartupInfo)),
                Flags = 0x100, // STARTF_USESTDHANDLES
                Input = input.Child.DangerousGetHandle(),
                Output = output.Child.DangerousGetHandle(),
                Error = error.Child.DangerousGetHandle()
            };
            var command = new StringBuilder("\"" + binary + "\" " + arguments);
            ProcessInfo process;
            IntPtr secret = Marshal.SecureStringToGlobalAllocUnicode(password);
            try {
                // The supervisor receives only the configured child environment.
                // Pass it explicitly so Windows does not substitute the account's environment.
                var variables = Environment.GetEnvironmentVariables();
                var names = new string[variables.Count];
                variables.Keys.CopyTo(names, 0);
                Array.Sort(names, StringComparer.OrdinalIgnoreCase);
                var block = new StringBuilder();
                foreach (string key in names) block.Append(key).Append('=').Append(variables[key]).Append('\0');
                block.Append('\0');
                IntPtr environment = Marshal.StringToHGlobalUni(block.ToString());
                try {
                    const uint suspendedUnicodeNoWindow = 0x08000404;
                    if (!CreateProcessWithLogonW(user, ".", secret, 1, binary, command,
                        suspendedUnicodeNoWindow, environment, cwd, ref startup, out process))
                        throw new Win32Exception();
                } finally { Marshal.FreeHGlobal(environment); }
            } finally { Marshal.ZeroFreeGlobalAllocUnicode(secret); }
            try {
                input.Child.Dispose();
                output.Child.Dispose();
                error.Child.Dispose();
                VerifyIsolatedIdentity(process.Process, sid);
                // Secondary Logon creates this process on our behalf. Assign its
                // actual handle explicitly while the primary thread is suspended.
                if (!AssignProcessToJobObject(job, process.Process)) throw new Win32Exception();
                if (parent.HasExited) return 1;
                if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception();
                using (var stdin = new FileStream(input.Host, FileAccess.Write))
                using (var stdout = new FileStream(output.Host, FileAccess.Read))
                using (var stderr = new FileStream(error.Host, FileAccess.Read)) {
                    var tasks = Relay(stdin, stdout, stderr);
                    uint status;
                    while ((status = WaitForSingleObject(process.Process, 100)) == 258 && !parent.HasExited) { }
                    if (status == 258) return 1;
                    if (status != 0) throw new Win32Exception();
                    Task.WaitAll(tasks, 500);
                    uint code;
                    if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception();
                    return unchecked((int)code);
                }
            } finally {
                // Also covers errors before the process was assigned to the job.
                TerminateProcess(process.Process, 1);
                CloseHandle(process.Thread);
                CloseHandle(process.Process);
            }
        }
    }
}
