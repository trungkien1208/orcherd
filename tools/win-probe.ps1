# Orcherd on Windows, stage 0: what this PC has. Run once in PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File tools\win-probe.ps1
#
# It changes nothing outside a temporary folder it removes again, and prints
# no secrets: for sign-in files only whether they exist, their size and their
# top-level key names. The report is written to %TEMP%\orcha-probe.txt too.

$ErrorActionPreference = "Continue"
$out = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $out.Add($text); Write-Host $text }
function Section([string]$name) { Say ""; Say "== $name" }
function Try-Run([string]$label, [scriptblock]$block) {
  try { $r = & $block 2>&1 | Out-String; Say ("{0}: {1}" -f $label, $r.Trim()) }
  catch { Say ("{0}: ERROR {1}" -f $label, $_.Exception.Message) }
}
function Keys-Of([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return "missing" }
  $size = (Get-Item -LiteralPath $path).Length
  try { $names = (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).PSObject.Properties.Name -join ", " }
  catch { $names = "(not JSON)" }
  return "exists, $size bytes, keys: $names"
}

Section "System"
Say ("Windows: {0} build {1}" -f [Environment]::OSVersion.VersionString, [Environment]::OSVersion.Version.Build)
Say ("Arch: {0}" -f $env:PROCESSOR_ARCHITECTURE)
Say ("PowerShell: {0}" -f $PSVersionTable.PSVersion)
Say ("USERPROFILE: {0}" -f $env:USERPROFILE)
Say ("HOME env: {0}" -f $env:HOME)
Say ("XDG_CONFIG_HOME: {0}" -f $env:XDG_CONFIG_HOME)
Say ("HERDR_APP_HOME: {0}" -f $env:HERDR_APP_HOME)
Say ("pwsh on PATH: {0}" -f [bool](Get-Command pwsh -ErrorAction SilentlyContinue))

Section "Herdr"
$candidates = @()
if ($env:HERDR_APP_HOME) { $candidates += $env:HERDR_APP_HOME }
if ($env:XDG_CONFIG_HOME) { $candidates += (Join-Path $env:XDG_CONFIG_HOME "herdr-app") }
$candidates += (Join-Path $env:USERPROFILE ".config\herdr-app")
$candidates += (Join-Path $env:APPDATA "herdr-app")
foreach ($c in $candidates) { Say ("config candidate {0}: {1}" -f $c, (Test-Path -LiteralPath $c)) }
$appHome = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ "layouts") } | Select-Object -First 1
Say ("config in use (has layouts\): {0}" -f $appHome)
if ($appHome) {
  Say ("folders: {0}" -f ((Get-ChildItem -LiteralPath $appHome -Name) -join ", "))
  $keys = Join-Path $appHome "keys.json"
  if (Test-Path -LiteralPath $keys) { Say "keys.json:"; Say (Get-Content -LiteralPath $keys -Raw) }
}
Say ("herdr-app.exe: {0}" -f ((Get-Command herdr-app -ErrorAction SilentlyContinue).Source))
Say ("herdr-core.exe: {0}" -f ((Get-Command herdr-core -ErrorAction SilentlyContinue).Source))
Say ("Herdr running: {0}" -f [bool](Get-Process herdr-app -ErrorAction SilentlyContinue))

Section "Programs on PATH (where.exe)"
foreach ($p in "py", "python", "python3", "git", "rg", "curl", "tar", "claude", "codex", "cursor-agent", "code", "cursor", "windsurf", "zed", "npx", "node") {
  $w = (& where.exe $p 2>$null) -join " | "
  Say ("{0}: {1}" -f $p, $(if ($w) { $w } else { "-" }))
}

Section "Python"
Try-Run "py -3 --version" { py -3 --version }
Try-Run "python --version" { python --version }
Try-Run "python3 --version" { python3 --version }
$py = $null
foreach ($cand in @(@("py", "-3"), @("python"))) {
  try { $v = & $cand[0] $cand[1..9] -c "import sys; print(sys.version_info >= (3, 8))" 2>$null; if ($v -eq "True") { $py = $cand; break } } catch {}
}
Say ("usable python: {0}" -f ($py -join " "))
if ($py) {
  $check = @'
import ctypes, ctypes.wintypes as w, msvcrt, os, sys, tempfile, time
print("encoding", sys.getfilesystemencoding(), "utf8 mode", sys.flags.utf8_mode)
class Blob(ctypes.Structure):
    _fields_ = [("n", w.DWORD), ("p", ctypes.POINTER(ctypes.c_char))]
def blob(b):
    buf = ctypes.create_string_buffer(b, len(b))
    return Blob(len(b), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf
crypt, kernel = ctypes.windll.crypt32, ctypes.windll.kernel32
src, keep = blob(b"orcha-probe")
enc = Blob()
ok = crypt.CryptProtectData(ctypes.byref(src), None, None, None, None, 0, ctypes.byref(enc))
dec = Blob()
ok2 = ok and crypt.CryptUnprotectData(ctypes.byref(enc), None, None, None, None, 0, ctypes.byref(dec))
print("DPAPI round trip", bool(ok2) and ctypes.string_at(dec.p, dec.n) == b"orcha-probe")
d = tempfile.mkdtemp()
with open(os.path.join(d, "lock"), "w") as fh:
    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
    print("msvcrt lock ok")
t = time.time()
import subprocess
r = subprocess.run(["powershell", "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Csv -NoTypeInformation"],
    capture_output=True, text=True)
print("process list via powershell: %d lines in %.2fs" % (r.stdout.count("\n"), time.time() - t))
t = time.time()
r = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True)
print("netstat: %d LISTENING in %.2fs" % (r.stdout.count("LISTENING"), time.time() - t))
'@
  # A file, not -c: Windows PowerShell 5.1 drops the quotes inside native arguments.
  $checkFile = Join-Path $env:TEMP "orcha-probe-check.py"
  Set-Content -LiteralPath $checkFile -Value $check -Encoding ASCII
  Try-Run "python checks" { & $py[0] $py[1..9] -I $checkFile }
  Remove-Item -LiteralPath $checkFile -ErrorAction SilentlyContinue
}

Section "Links (symlinks need Developer Mode or admin)"
$dev = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" -ErrorAction SilentlyContinue
Say ("Developer Mode: {0}" -f $(if ($dev.AllowDevelopmentWithoutDevLicense -eq 1) { "on" } else { "off" }))
$tmp = Join-Path $env:TEMP ("orcha-probe-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path (Join-Path $tmp "dir") -Force | Out-Null
Set-Content -LiteralPath (Join-Path $tmp "file.txt") -Value "x"
Try-Run "symlink to folder" { New-Item -ItemType SymbolicLink -Path (Join-Path $tmp "s-dir") -Target (Join-Path $tmp "dir") | Out-Null; "ok" }
Try-Run "symlink to file" { New-Item -ItemType SymbolicLink -Path (Join-Path $tmp "s-file") -Target (Join-Path $tmp "file.txt") | Out-Null; "ok" }
Try-Run "junction" { New-Item -ItemType Junction -Path (Join-Path $tmp "j-dir") -Target (Join-Path $tmp "dir") | Out-Null; "ok" }
Try-Run "hard link" { New-Item -ItemType HardLink -Path (Join-Path $tmp "h-file") -Target (Join-Path $tmp "file.txt") | Out-Null; "ok" }
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

Section "Claude Code"
$claude = Join-Path $env:USERPROFILE ".claude"
Say ("~\.claude: {0}" -f (Test-Path -LiteralPath $claude))
Say (".credentials.json: {0}" -f (Keys-Of (Join-Path $claude ".credentials.json")))
Say ("~\.claude.json: {0}" -f $(if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE ".claude.json")) { "exists" } else { "missing" }))
Say ("CLAUDE_CONFIG_DIR: {0}" -f $env:CLAUDE_CONFIG_DIR)
$projects = Join-Path $claude "projects"
if (Test-Path -LiteralPath $projects) {
  Say "project folder names (newest 5):"
  Get-ChildItem -LiteralPath $projects -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 5 | ForEach-Object { Say ("  " + $_.Name) }
}
Try-Run "claude --version" { claude --version }

Section "Codex and Cursor"
Say ("~\.codex: {0}" -f (Test-Path -LiteralPath (Join-Path $env:USERPROFILE ".codex")))
Say ("~\.codex\auth.json: {0}" -f (Keys-Of (Join-Path $env:USERPROFILE ".codex\auth.json")))
foreach ($d in (Join-Path $env:USERPROFILE ".cursor"), (Join-Path $env:APPDATA "Cursor"), (Join-Path $env:LOCALAPPDATA "cursor-agent")) {
  if (Test-Path -LiteralPath $d) { Say ("{0}: {1}" -f $d, ((Get-ChildItem -LiteralPath $d -Name -Force) -join ", ")) } else { Say ("{0}: missing" -f $d) }
}
foreach ($app in "Cursor", "Code", "Windsurf") {
  $db = Join-Path $env:APPDATA "$app\User\globalStorage\state.vscdb"
  Say ("{0} recent-projects db: {1}" -f $app, (Test-Path -LiteralPath $db))
}

Section "curl and certificate pinning"
Try-Run "curl.exe -V" { curl.exe -V }
# A wrong pin must fail with exit 90 (pin mismatch). Another code means
# this curl can't pin, and Token Station needs another way.
curl.exe -s -o NUL --max-time 15 --pinnedpubkey "sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" https://example.com 2>$null
Say ("wrong pin exit code: {0} (90 = pinning works)" -f $LASTEXITCODE)

Section "IDE and Git apps"
foreach ($d in "$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}") {
  if (-not (Test-Path -LiteralPath $d)) { continue }
  $hits = Get-ChildItem -LiteralPath $d -Directory -Name | Where-Object { $_ -match "cursor|code|windsurf|zed|jetbrains|fork|sourcetree|github ?desktop|gitkraken" }
  Say ("{0}: {1}" -f $d, ($hits -join ", "))
}

$file = Join-Path $env:TEMP "orcha-probe.txt"
$out | Set-Content -LiteralPath $file -Encoding UTF8
Write-Host ""
Write-Host "Saved to $file. Send that file back."
