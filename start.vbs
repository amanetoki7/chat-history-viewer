' chat-history-viewer サーバーをバックグラウンド (ウィンドウ非表示) で起動する
' ダブルクリック、またはスタートアップ登録での自動起動に使う
Option Explicit

Dim fso, shell, baseDir, serverJs

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverJs = baseDir & "\server.js"

' 二重起動を防ぐ (server.js を実行中の node.exe が既に居たら何もしない)
Dim wmi, procs
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery( _
    "SELECT ProcessId FROM Win32_Process " & _
    "WHERE Name = 'node.exe' AND CommandLine LIKE '%chat-history-viewer%server.js%'")
If procs.Count > 0 Then
    WScript.Quit
End If

shell.CurrentDirectory = baseDir
shell.Run "node """ & serverJs & """", 0, False
