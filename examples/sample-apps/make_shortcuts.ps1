# Desktop shortcuts for the Sightline sample apps.
#
# Creates one shortcut per app on the current user's Desktop, so the console can
# launch them by name ("Sightline Accounts") the same way it launches an .exe.
#
#   powershell -ExecutionPolicy Bypass -File .\make_shortcuts.ps1
#
# Nothing is installed and nothing outside the Desktop folder is written.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suite = Join-Path $scriptDir "sightline_suite.py"
if (-not (Test-Path $suite)) {
    throw "sightline_suite.py not found next to this script."
}

$python = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $python) {
    $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
}
if (-not $python) {
    throw "Python was not found on PATH. Install Python 3 with tkinter, then run this again."
}

$desktop = [Environment]::GetFolderPath("Desktop")
$apps = @(
    @{ Name = "Accounts"; App = "accounts" },
    @{ Name = "QR"; App = "qr" },
    @{ Name = "Profile"; App = "profile" },
    @{ Name = "Calculator"; App = "calculator" },
    @{ Name = "Notes"; App = "notes" },
    @{ Name = "Todo"; App = "todo" },
    @{ Name = "Chat"; App = "chat" },
    @{ Name = "Files"; App = "files" },
    @{ Name = "Media"; App = "media" },
    @{ Name = "Store"; App = "store" }
)

$shell = New-Object -ComObject WScript.Shell
foreach ($entry in $apps) {
    $path = Join-Path $desktop ("Sightline " + $entry.Name + ".lnk")
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $python
    $shortcut.Arguments = '"' + $suite + '" --app ' + $entry.App
    $shortcut.WorkingDirectory = $scriptDir
    $shortcut.IconLocation = $python
    $shortcut.Description = "Sightline sample app: " + $entry.Name
    $shortcut.Save()
    Write-Output ("created " + $path)
}

Write-Output ("Done: " + $apps.Count + " shortcuts on " + $desktop)
