$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Real install/uninstall is restricted to disposable GitHub-hosted Windows runners.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Run installer smoke tests on a disposable GitHub Actions Windows runner.'
}

$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $workspace
$package = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$productName = $package.build.productName
$installer = Join-Path $workspace "release/Mai-Desktop-Pet-$($package.version)-win-x64-Setup.exe"
$testRoot = [IO.Path]::GetFullPath((Join-Path $workspace '.cache/installer-smoke'))
$runId = [guid]::NewGuid().ToString()
$installDirectory = [IO.Path]::GetFullPath((Join-Path $testRoot "$runId/Custom install"))
$installedExe = Join-Path $installDirectory "$productName.exe"
$uninstaller = Join-Path $installDirectory "Uninstall $productName.exe"
$shortcutName = "$($package.build.nsis.shortcutName).lnk"
$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) $shortcutName),
    (Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName)
)
$uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Find-Registration {
    foreach ($root in $uninstallRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in Get-ChildItem -LiteralPath $root) {
            $entry = Get-ItemProperty -LiteralPath $key.PSPath
            if ($entry.PSObject.Properties['DisplayName'] -and $entry.DisplayName -like "$productName*") {
                $entry
            }
        }
    }
}

function Assert-OwnInstallDirectory {
    $fullPath = [IO.Path]::GetFullPath($installDirectory)
    Assert-True ($fullPath.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) 'Install path must stay within the smoke-test directory.'
    if (Test-Path -LiteralPath $installDirectory) {
        $resolved = (Resolve-Path -LiteralPath $installDirectory).Path
        Assert-True ($resolved -eq $fullPath) 'Unexpected installation path resolution.'
    }
}

function Run-Installer([string]$Executable, [string[]]$Arguments) {
    Assert-OwnInstallDirectory
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru -Wait
    Assert-True ($process.ExitCode -eq 0) "Installer process failed with exit code $($process.ExitCode)."
}

function Verify-Installed {
    Assert-True (Test-Path -LiteralPath $installedExe) 'Installed application is missing.'
    Assert-True (Test-Path -LiteralPath $uninstaller) 'Uninstaller is missing.'
    & node scripts/verify-release.mjs $installDirectory
    Assert-True ($LASTEXITCODE -eq 0) 'Installed files do not match the production build.'
    $registration = @(Find-Registration)
    Assert-True ($registration.Count -eq 1) 'Expected one Windows uninstall registration.'
    Assert-True ($registration[0].DisplayVersion -eq $package.version) 'Registered version is incorrect.'
    Assert-True ($registration[0].UninstallString.Contains($uninstaller)) 'Uninstall entry points outside the test installation.'
    foreach ($link in $shortcuts) {
        Assert-True (Test-Path -LiteralPath $link) "Missing shortcut: $link"
    }
    & node node_modules/electron/cli.js scripts/verify-shortcuts.cjs $installedExe @shortcuts
    Assert-True ($LASTEXITCODE -eq 0) 'Installed shortcuts do not point to the application.'
}

Assert-True (Test-Path -LiteralPath $installer) 'Build the Setup EXE first.'
Assert-True (-not $package.build.nsis.oneClick) 'An assisted installer is required.'
Assert-True $package.build.nsis.allowToChangeInstallationDirectory 'Directory selection must be enabled.'
Assert-True (@(Find-Registration).Count -eq 0) 'Refusing to replace an existing installation.'
foreach ($link in $shortcuts) { Assert-True (-not (Test-Path -LiteralPath $link)) 'Refusing to replace an existing shortcut.' }
Assert-OwnInstallDirectory
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

# Use a harmless marker in the actual default app-data directory. The runtime
# suite itself uses an isolated profile and never contacts configured services.
$dataDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Mai Desktop Pet'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$sentinel = Join-Path $dataDirectory "installer-smoke-$runId.txt"
Set-Content -LiteralPath $sentinel -Value $runId -Encoding UTF8
$uninstallVerified = $false
try {
    Run-Installer $installer @('/S', '/currentuser', "/D=$installDirectory")
    Verify-Installed
    # Reinstall through the shipped installer to exercise replacement of an
    # existing install, preserving its path, shortcuts and user data.
    Run-Installer $installer @('/S', '/currentuser', "/D=$installDirectory")
    Verify-Installed
    Assert-True ((Get-Content -LiteralPath $sentinel -Raw).Trim() -eq $runId) 'Reinstallation removed user data.'
    & node scripts/runtime-smoke.mjs --mode=packaged "--exe=$installedExe"
    Assert-True ($LASTEXITCODE -eq 0) 'The installed application failed its runtime checks.'
} finally {
    if (Test-Path -LiteralPath $uninstaller) {
        Run-Installer $uninstaller @('/S', '/currentuser')
        Assert-True (-not (Test-Path -LiteralPath $installedExe)) 'Uninstall left the application installed.'
        Assert-True (@(Find-Registration).Count -eq 0) 'Uninstall left a registry entry.'
        foreach ($link in $shortcuts) { Assert-True (-not (Test-Path -LiteralPath $link)) 'Uninstall left a shortcut.' }
        Assert-True ((Get-Content -LiteralPath $sentinel -Raw).Trim() -eq $runId) 'Uninstall removed user data.'
        $uninstallVerified = $true
    }
    if (Test-Path -LiteralPath $sentinel) { Remove-Item -LiteralPath $sentinel }
}
Assert-True $uninstallVerified 'The uninstaller was not exercised.'
$report = @{
    passed = $true
    version = $package.version
    installer = $installer
    sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    checks = @('custom install directory', 'installed ASAR/version/license', 'desktop/start menu shortcuts', 'uninstall registration', 'reinstall', 'installed runtime and restart', 'uninstall', 'preserved user data')
}
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $testRoot 'result.json') -Encoding UTF8
Write-Output "PASS Setup v$($package.version): install, shortcuts, reinstall, real runtime, uninstall and preserved user data"
