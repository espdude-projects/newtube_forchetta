' NewTube.vbs — silent launcher
' Double-click this to run NewTube without a black console window appearing.
' Internally it just calls Run.bat.

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """" & Replace(WScript.ScriptFullName, "NewTube.vbs", "Run.bat") & """", 0, False
Set WshShell = Nothing
