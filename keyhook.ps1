# keyhook.ps1 - 划词翻译取词/粘贴助手（常驻进程）
# 由 main.js 启动，通过 stdin/stdout 通信：COPY = 复制选中文本，PASTE = 粘贴剪贴板
# 用 keybd_event 精确控制 Ctrl 的按下与抬起（SendKeys 的修饰键在部分程序里会丢，
# 导致 Ctrl+V 被当成裸 v 输入），并留出合理间隔。
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Namespace KH -Name K -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
} catch {
  [Console]::WriteLine('ERR ' + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}
$VK_CONTROL = 0x11
$KEYUP = 0x02
function Send-CtrlKey([byte]$vk) {
  [KH.K]::keybd_event($VK_CONTROL, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [KH.K]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [KH.K]::keybd_event($vk, 0, $KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [KH.K]::keybd_event($VK_CONTROL, 0, $KEYUP, [UIntPtr]::Zero)
}
[Console]::WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::ReadLine()
  if ($null -eq $line -or $line -eq 'QUIT') { break }
  if ($line -eq 'COPY') {
    try { Send-CtrlKey 0x43; [Console]::WriteLine('OK') }
    catch { [Console]::WriteLine('ERR ' + $_.Exception.Message) }
    [Console]::Out.Flush()
  } elseif ($line -eq 'PASTE') {
    try { Send-CtrlKey 0x56; [Console]::WriteLine('OK') }
    catch { [Console]::WriteLine('ERR ' + $_.Exception.Message) }
    [Console]::Out.Flush()
  } elseif ($line -eq 'PING') {
    [Console]::WriteLine('PONG')
    [Console]::Out.Flush()
  }
}