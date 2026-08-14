@echo off
rem chat-history-viewer サーバーを再起動する
rem 実行中の server.js (node.exe) を停止してから、start.vbs でバックグラウンド起動し直す

echo [chat-history-viewer] サーバーを停止しています...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*chat-history-viewer*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('  停止: PID ' + $_.ProcessId) }"

rem ポート解放を少し待つ (timeout はリダイレクト下で使えないため ping で代用)
ping -n 3 127.0.0.1 >nul

echo [chat-history-viewer] サーバーをバックグラウンドで起動しています...
wscript "%~dp0start.vbs"

ping -n 3 127.0.0.1 >nul
echo [chat-history-viewer] 再起動しました: http://localhost:5173/
pause
