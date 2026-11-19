import agentScript from '../../assets/print-helper/agent.ps1?raw';

/** Base64 of text, in lines short enough for a batch file (certutil reads them back). */
export function base64Lines(text: string, width = 64): string[] {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += width) out.push(b64.slice(i, i + width));
  return out;
}

/**
 * The one file the person at the counter runs. It puts the helper program and this restaurant's address and key
 * in %LOCALAPPDATA%\PosPrintHelper, makes it start with Windows, and starts it now. Plain text, so it can be read
 * before it is run; the program itself is the readable script in assets/print-helper/agent.ps1.
 */
export function installerBatch(opts: { url: string; key: string }): string {
  const lines = [
    '@echo off',
    'setlocal',
    'title Install the print helper',
    'echo.',
    'echo  Installing the print helper for this computer ...',
    'echo.',
    'set "DIR=%LOCALAPPDATA%\\PosPrintHelper"',
    'if not exist "%DIR%" mkdir "%DIR%"',
    'rem --- the helper program (text, decoded back) ---',
    '(',
    ...base64Lines(agentScript).map((l) => `echo ${l}`),
    ') > "%DIR%\\agent.b64"',
    'certutil -f -decode "%DIR%\\agent.b64" "%DIR%\\agent.ps1" >nul',
    'del "%DIR%\\agent.b64"',
    'rem --- this restaurant ---',
    `> "%DIR%\\config.json" echo {"url":"${opts.url}","key":"${opts.key}"}`,
    'rem --- start with Windows, with no window ---',
    '> "%DIR%\\run.vbs" echo CreateObject("Wscript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""%DIR%\\agent.ps1""", 0',
    'copy /y "%DIR%\\run.vbs" "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\PosPrintHelper.vbs" >nul',
    'rem --- replace an older copy that may be running ---',
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'powershell.exe\'\\" | Where-Object { $_.CommandLine -like \'*PosPrintHelper*agent.ps1*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1',
    'wscript "%DIR%\\run.vbs"',
    'echo.',
    'echo  Done. The print helper is running and will start by itself with Windows.',
    'echo  Go back to the app: it shows "Connected" in a few seconds.',
    'echo.',
    'pause',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Offers the text as a file to save (a plain download link, which the browser allows from a normal page). */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
