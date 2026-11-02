Option Explicit
Dim shell, fso, root, exe
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
 MsgBox "The development runtime was not found. Use the packaged English edition instead.", 16, "ShanweiGeo 3D Geoscience Platform"
 WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Environment("PROCESS")("SHANWEI_DESKTOP_LOGS") = "1"
shell.Run Chr(34) & exe & Chr(34) & " " & Chr(34) & root & Chr(34), 1, False
