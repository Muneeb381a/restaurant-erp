# POS print helper (ADR 0029).
#
# Runs quietly on the counter computer. It finds the printers installed on this computer, asks the
# restaurant's server for receipts and kitchen tickets that are waiting, prints them straight to the
# printer, and tells the server it did. Nothing else: it does not read files, open other programs or
# send anything but the print results. Its log is in %LOCALAPPDATA%\PosPrintHelper\helper.log.
#
# Written for Windows PowerShell 5.1, which every Windows 10 and 11 computer already has.

param([string]$Config = (Join-Path $env:LOCALAPPDATA 'PosPrintHelper\config.json'))

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = Split-Path $Config
$log = Join-Path $dir 'helper.log'

function Log([string]$message) {
  try {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 500KB)) { Move-Item $log "$log.old" -Force }
    Add-Content -Path $log -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $message)
  } catch { }
}

# only one copy at a time
$mutex = New-Object System.Threading.Mutex($false, 'Local\PosPrintHelper')
if (-not $mutex.WaitOne(0)) { exit }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

  // Sends the bytes to the printer as they are (RAW), which is what a receipt printer understands.
  public static void Send(string printer, byte[] bytes, string title) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("Cannot open the printer '" + printer + "' (Windows error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = title;
      di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di))
        throw new Exception("The printer would not start the job (Windows error " + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, p, bytes.Length);
          int written;
          if (!WritePrinter(h, p, bytes.Length, out written) || written != bytes.Length)
            throw new Exception("The printer did not take all the data (Windows error " + Marshal.GetLastWin32Error() + ")");
        } finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@

$cfg = Get-Content -Path $Config -Raw | ConvertFrom-Json
$base = $cfg.url.TrimEnd('/')
$headers = @{ 'x-print-key' = $cfg.key }

function Call([string]$path, $body) {
  $json = if ($null -eq $body) { '{}' } else { $body | ConvertTo-Json -Depth 5 -Compress }
  Invoke-RestMethod -Method Post -Uri "$base/print-agent$path" -Headers $headers `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 20
}

# The printers installed here, without the "virtual" ones (PDF, XPS, fax), and the one that looks like a
# receipt printer. Nobody has to choose: the receipt printer is found by its name and driver.
function Find-Printers {
  $virtual = 'PDF|XPS|OneNote|Fax|Snagit|Send To|Print to'
  $all = @(Get-CimInstance Win32_Printer | Where-Object { $_.Name -notmatch $virtual })
  $seen = @($all | ForEach-Object { @{ name = $_.Name; isDefault = [bool]$_.Default } })
  $thermal = $all | Where-Object {
    ("$($_.Name) $($_.DriverName)") -match 'POS|IT800|itech|thermal|receipt|TM-|BIXOLON|XPRINTER|RONGTA|GP-|\b80\s?mm|\b58\s?mm|ESC'
  } | Select-Object -First 1
  $chosen = $null
  if ($thermal) { $chosen = $thermal.Name }
  elseif ($all.Count -gt 0) {
    $default = $all | Where-Object { $_.Default } | Select-Object -First 1
    $chosen = if ($default) { $default.Name } else { $all[0].Name }
  }
  if ($cfg.printer) { $chosen = $cfg.printer }   # set by hand only if the automatic choice is wrong
  return @{ seen = $seen; chosen = $chosen }
}

function Say-Hello {
  $found = Find-Printers
  $body = @{ computer = $env:COMPUTERNAME; printers = $found.seen }
  if ($found.chosen) { $body.chosen = $found.chosen }
  $reply = Call '/hello' $body
  Log ("connected to {0}; printers found: {1}; using: {2}" -f $base, (($found.seen | ForEach-Object { $_.name }) -join ', '), $found.chosen)
  return $found.chosen
}

Log 'print helper started'
$chosen = $null
$announced = $false
$lastHello = Get-Date '2000-01-01'

while ($true) {
  try {
    if (-not $announced -or ((Get-Date) - $lastHello).TotalMinutes -gt 10) {
      $chosen = Say-Hello
      $announced = $true
      $lastHello = Get-Date
    }
    $reply = Call '/claim' $null
    $worked = $false
    foreach ($job in @($reply.jobs)) {
      if (-not $job) { continue }
      $worked = $true
      try {
        $name = if ($job.printer) { $job.printer } else { $chosen }
        if (-not $name) { throw 'No printer is installed on this computer.' }
        $bytes = [Convert]::FromBase64String($job.payloadBase64)
        [RawPrinter]::Send($name, $bytes, [string]$job.title)
        Call "/jobs/$($job.id)/result" @{ ok = $true } | Out-Null
        Log ("printed: {0} on {1}" -f $job.title, $name)
      } catch {
        $why = $_.Exception.Message
        Log ("could not print {0}: {1}" -f $job.title, $why)
        try { Call "/jobs/$($job.id)/result" @{ ok = $false; error = $why } | Out-Null } catch { }
      }
    }
    if (-not $worked) { Start-Sleep -Seconds 2 }
  } catch {
    $announced = $false
    $status = $null
    try { $status = [int]$_.Exception.Response.StatusCode } catch { }
    if ($status -eq 401) {
      Log 'the restaurant no longer recognises this helper: install it again from Admin, Settings'
      Start-Sleep -Seconds 60
    } else {
      Log ("cannot reach the server: {0}" -f $_.Exception.Message)
      Start-Sleep -Seconds 5
    }
  }
}
