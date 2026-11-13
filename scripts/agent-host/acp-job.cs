using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

public static class YfeAcpJob {
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

    public static void Run(string name, int parentId, long parentStarted, string binary, string cwd, string arguments) {
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
                var start = new ProcessStartInfo(binary, arguments);
                start.WorkingDirectory = cwd;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardInput = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                // The supervisor is already in the job. The Agent and descendants inherit membership.
                using (var child = Process.Start(start)) {
                    var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                    var errors = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                    // The parent can still stop the job when its input remains open.
                    var inputThread = new Thread(() => {
                        try {
                            // CopyTo may wait for EOF when a console stream coalesces reads.
                            // Flush each received chunk to keep request/response traffic interactive.
                            var input = Console.OpenStandardInput(0);
                            var outputToChild = child.StandardInput.BaseStream;
                            var buffer = new byte[8192];
                            int count;
                            while ((count = input.Read(buffer, 0, buffer.Length)) != 0) {
                                outputToChild.Write(buffer, 0, count);
                                outputToChild.Flush();
                            }
                            outputToChild.Close();
                        } catch (IOException) { }
                        catch (ObjectDisposedException) { }
                    });
                    inputThread.IsBackground = true;
                    inputThread.Start();
                    while (!child.WaitForExit(100) && !parent.HasExited) { }
                    if (child.HasExited) Task.WaitAll(new[] { output, errors }, 500);
                }
            }
        } finally { CloseHandle(job); }
    }
}
