$ErrorActionPreference = "Stop"

$uninstaller = "C:\Users\defmon3\AppData\Local\Programs\t3code\Uninstall T3 Code (Nightly).exe"
$installer = "G:\t3-code\t3code\release\T3-Code-0.0.33-nightly.20260808.1035-x64.exe"
$logPath = "G:\t3-code\t3code\replace-t3-custom.log"

if (Test-Path -LiteralPath $uninstaller) {
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S", "/currentuser" -PassThru -Wait
  "UNINSTALL_EXIT=$($uninstall.ExitCode)" | Set-Content -LiteralPath $logPath
}

$install = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru -Wait
"INSTALL_EXIT=$($install.ExitCode)" | Add-Content -LiteralPath $logPath
