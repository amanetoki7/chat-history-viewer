@echo off
rem chat-history-viewer サーバーを起動する (コンソール表示あり)
cd /d "%~dp0"
node "%~dp0server.js"
pause
