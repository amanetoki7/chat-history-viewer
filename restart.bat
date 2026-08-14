@echo off
rem chat-history-viewer サーバーを再起動する
rem ポート（PORT 環境変数、既定 5173）で待ち受けているプロセスを止めてから、start.vbs でバックグラウンド起動し直す。
rem コマンドライン文字列の一致ではなくポートで探すため、node server.js の起動経路
rem （ターミナルから直接 / npm start / start.vbs 経由 等）によらず確実に見つかる。

echo [chat-history-viewer] サーバーを停止しています...
powershell -NoProfile -Command "$port = if ($env:PORT) { [int]$env:PORT } else { 5173 }; $procs = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -Unique OwningProcess; if ($procs) { $procs | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force; Write-Host ('  停止: PID ' + $_.OwningProcess) } } else { Write-Host ('  ポート ' + $port + ' で待ち受けているプロセスは見つかりませんでした（未起動と判断し、続行します）') }"

rem ポート解放を少し待つ (timeout はリダイレクト下で使えないため ping で代用)
ping -n 3 127.0.0.1 >nul

echo [chat-history-viewer] サーバーをバックグラウンドで起動しています...
wscript "%~dp0start.vbs"

ping -n 3 127.0.0.1 >nul
echo [chat-history-viewer] 再起動しました: http://localhost:5173/
pause
