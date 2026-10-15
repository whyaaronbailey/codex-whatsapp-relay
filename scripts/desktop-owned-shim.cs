// Candidate only: selecting this executable is a separate reviewed activation.
// The shim neither inspects desktop bootstrap values nor kills child processes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class DesktopOwnedShim
{
    private static bool ValueOption(string value)
    {
        return value == "-c" || value == "--config" || value == "--enable" || value == "--disable";
    }
    private static bool InlineOption(string value)
    {
        return value.StartsWith("--config=", StringComparison.Ordinal) || value.StartsWith("--enable=", StringComparison.Ordinal) || value.StartsWith("--disable=", StringComparison.Ordinal);
    }
    private static bool BridgeInvocation(string[] args)
    {
        int i = 0;
        while (i < args.Length)
        {
            string value = args[i++];
            if (ValueOption(value)) { if (i >= args.Length) return false; i++; continue; }
            if (InlineOption(value)) continue;
            if (value != "app-server") return false;
            while (i < args.Length)
            {
                value = args[i++];
                if (ValueOption(value)) { if (i >= args.Length) return false; i++; continue; }
                if (InlineOption(value)) continue;
                if (value != "--analytics-default-enabled" && value != "--strict-config" && value != "--stdio") return false;
            }
            return true;
        }
        return false;
    }
    // Inverse of CommandLineToArgvW, including embedded quotes and trailing '\'.
    private static string Quote(string value)
    {
        StringBuilder text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { text.Append('\\', slashes * 2 + 1); text.Append(ch); slashes = 0; continue; }
            text.Append('\\', slashes); slashes = 0; text.Append(ch);
        }
        text.Append('\\', slashes * 2); text.Append('"'); return text.ToString();
    }
    private static string RequiredPath(Dictionary<string, object> config, string key)
    {
        object value;
        if (!config.TryGetValue(key, out value) || !(value is string)) throw new InvalidDataException();
        string result = (string)value;
        if (!Path.IsPathRooted(result) || !File.Exists(result)) throw new InvalidDataException();
        return Path.GetFullPath(result);
    }
    private static async Task Pump(Stream source, Stream destination)
    {
        byte[] buffer = new byte[65536];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0)
        {
            await destination.WriteAsync(buffer, 0, count).ConfigureAwait(false);
            // Process.StandardInput.BaseStream may buffer small protocol frames.
            // Every chunk must be visible before the peer sends its next request.
            await destination.FlushAsync().ConfigureAwait(false);
        }
    }
    public static int Main(string[] args)
    {
        try
        {
            string self = Process.GetCurrentProcess().MainModule.FileName;
            string configPath = self + ".json";
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
            if (!config.ContainsKey("schema") || (string)config["schema"] != "codex-desktop-owned-bridge-v1") throw new InvalidDataException();
            string realCli = RequiredPath(config, "realCliPath");
            if (String.Equals(realCli, self, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
            string executable = realCli;
            var forwarded = new List<string>();
            if (BridgeInvocation(args))
            {
                executable = RequiredPath(config, "nodePath");
                forwarded.Add(RequiredPath(config, "bridgePath"));
                forwarded.Add("--config"); forwarded.Add(configPath); forwarded.Add("--");
            }
            forwarded.AddRange(args);
            var quoted = new List<string>();
            foreach (string arg in forwarded) quoted.Add(Quote(arg));
            var info = new ProcessStartInfo(executable, String.Join(" ", quoted.ToArray()));
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            // No environment replacement or shell. Explicit byte pumps preserve
            // UTF-8 and ensure EOF closes the child's sole stdin writer on Windows.
            using (Process child = Process.Start(info))
            {
                if (child == null) return 1;
                Task input = Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream).ContinueWith(delegate(Task completed)
                {
                    try { child.StandardInput.Close(); } catch { }
                });
                Task output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                Task error = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
                child.WaitForExit();
                Task.WaitAll(output, error);
                return child.ExitCode;
            }
        }
        catch
        {
            Console.Error.WriteLine("Desktop CLI shim failed before verified handoff; no process was force-stopped.");
            return 1;
        }
    }
}
