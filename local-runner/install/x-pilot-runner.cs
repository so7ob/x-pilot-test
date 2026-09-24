// X-Pilot Local Runner - native messaging host launcher (compiled at install
// time by install.ps1 with the .NET Framework csc.exe that ships with every
// Windows 10/11: %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe).
//
// WHY AN .EXE (issue #9): Chrome launches native messaging hosts through two
// different code paths (chrome/browser/extensions/api/messaging/
// launch_context_win.cc). When the manifest path ends with .exe, Chrome uses
// LaunchNativeExeDirectly: it opens both named pipes as inheritable file
// handles and passes them to this process. Any other extension (including
// .cmd/.bat) goes through LaunchNativeHostViaCmd, where cmd.exe itself must
// open Chrome's named pipes via "< pipe > pipe" text redirections - the
// fragile legacy chain that failed with "Error when communicating with the
// native messaging host." on real machines. Registering this .exe therefore
// moves the host onto Chrome's robust direct-launch path.
//
// INVARIANTS:
// - stdin and stdout are the native messaging protocol pipes opened by
//   Chrome. They are NEVER redirected - they are passed through to node
//   untouched (RedirectStandardInput/RedirectStandardOutput stay false).
// - Only stderr is redirected (to host-stderr.log): Chrome gives
//   direct-launched hosts no usable stderr handle, and bootstrap crashes
//   such as "Cannot find module" must stay diagnosable.
// - The source is pure ASCII and C# 5 compatible (the Framework csc
//   compiler does not support newer language levels: no $"", no ?., no
//   nameof, no expression-bodied members).
// - Node resolution order: sidecar file "x-pilot-runner.node.txt" next to
//   this exe (written by install.ps1, absolute path), then well-known
//   install locations, then "node.exe" via PATH search.
// - The exit code of node is passed through to Chrome.

using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace XPilot.Runner
{
    internal static class Launcher
    {
        private const string SelfTestArg = "--xpilot-launcher-selftest";

        private static string Home
        {
            get { return AppDomain.CurrentDomain.BaseDirectory; }
        }

        private static string StderrLogPath
        {
            get
            {
                string localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
                if (string.IsNullOrEmpty(localAppData))
                {
                    return null;
                }
                return Path.Combine(localAppData, "X-Pilot", "Runner", "logs", "host-stderr.log");
            }
        }

        private static int Main(string[] args)
        {
            if (args != null && args.Length > 0 && args[0] == SelfTestArg)
            {
                // Install-time verification: the binary Chrome will launch must
                // start and answer with this exact marker on stdout.
                string resolved = ResolveNode();
                string nodeInfo = (resolved != null) ? resolved : "PATH:node.exe";
                Console.WriteLine("X-PILOT-LAUNCHER-SELFTEST-OK node=" + nodeInfo);
                return 0;
            }

            string script = Path.Combine(Home, "dist", "index.js");
            if (!File.Exists(script))
            {
                BootLog("dist/index.js not found next to the launcher: " + script);
                return 3;
            }

            string nodeExe = ResolveNode();
            if (nodeExe == null)
            {
                // Well-known locations failed; let CreateProcess search PATH.
                nodeExe = "node.exe";
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = BuildArguments(script, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            // stdin/stdout MUST pass through: they are the native messaging
            // pipes Chrome opened. Only stderr is captured (see header).
            psi.RedirectStandardInput = false;
            psi.RedirectStandardOutput = false;
            psi.RedirectStandardError = true;
            psi.StandardErrorEncoding = Encoding.UTF8;

            Process process;
            try
            {
                process = Process.Start(psi);
            }
            catch (Exception exception)
            {
                BootLog("failed to start node (" + nodeExe + "): " + exception.Message);
                return 4;
            }
            if (process == null)
            {
                BootLog("failed to start node (" + nodeExe + "): Process.Start returned null");
                return 4;
            }

            try
            {
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                {
                    if (eventArgs.Data != null)
                    {
                        BootLogLine(eventArgs.Data);
                    }
                };
                process.BeginErrorReadLine();
                process.WaitForExit();
                // Calling WaitForExit() again is the documented way to flush
                // asynchronous output handlers before reading ExitCode.
                process.WaitForExit();
                return process.ExitCode;
            }
            finally
            {
                process.Dispose();
            }
        }

        private static string BuildArguments(string script, string[] args)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append(Quote(script));
            if (args != null)
            {
                foreach (string arg in args)
                {
                    if (string.IsNullOrEmpty(arg))
                    {
                        continue;
                    }
                    builder.Append(' ');
                    builder.Append(Quote(arg));
                }
            }
            return builder.ToString();
        }

        private static string Quote(string value)
        {
            if (value == null)
            {
                return "\"\"";
            }
            return "\"" + value.Replace("\"", "\"\"") + "\"";
        }

        private static string ResolveNode()
        {
            // 1. Sidecar written by install.ps1 (absolute path, ASCII).
            try
            {
                string sidecar = Path.Combine(Home, "x-pilot-runner.node.txt");
                if (File.Exists(sidecar))
                {
                    string candidate = File.ReadAllText(sidecar).Trim();
                    if (candidate.Length > 0 && File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
            }
            catch
            {
            }

            // 2. Well-known Node.js install locations.
            string[] roots = new string[]
            {
                Environment.GetEnvironmentVariable("ProgramFiles"),
                Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
                Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? string.Empty, "Programs")
            };
            foreach (string root in roots)
            {
                if (string.IsNullOrEmpty(root))
                {
                    continue;
                }
                foreach (string dir in new string[] { "nodejs", "node" })
                {
                    try
                    {
                        string candidate = Path.Combine(root, dir, "node.exe");
                        if (File.Exists(candidate))
                        {
                            return candidate;
                        }
                    }
                    catch
                    {
                    }
                }
            }
            return null;
        }

        private static void BootLog(string message)
        {
            BootLogLine(message);
        }

        private static void BootLogLine(string line)
        {
            try
            {
                string logPath = StderrLogPath;
                if (logPath == null)
                {
                    return;
                }
                string directory = Path.GetDirectoryName(logPath);
                if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
                {
                    Directory.CreateDirectory(directory);
                }
                // Keep the file bounded: bootstrap logs are small, but a
                // long-lived machine must not grow it forever.
                FileInfo info = new FileInfo(logPath);
                if (info.Exists && info.Length > 512 * 1024)
                {
                    File.WriteAllText(logPath, string.Empty);
                }
                using (StreamWriter writer = new StreamWriter(logPath, true, new UTF8Encoding(false)))
                {
                    writer.WriteLine(line);
                }
            }
            catch
            {
                // Diagnostics must never break the launch.
            }
        }
    }
}
