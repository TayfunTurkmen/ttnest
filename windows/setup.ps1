# Ev Kontrol — Windows hazırlık betiği
# Her bilgisayarda (masaüstü + laptop) YÖNETİCİ PowerShell ile çalıştır:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Yaptıkları:
#   1. Ping (ICMP) yanıtına yalnızca yerel ağdan izin verir  -> çevrimiçi tespiti
#   2. go2rtc (1984) portuna yalnızca yerel ağdan izin verir -> webcam
#   3. Ağ kartında Wake-on-LAN (Magic Packet) ayarlarını açar
#   4. "Hızlı Başlatma"yı kapatır (açıkken WoL çoğu zaman çalışmaz)
#   5. go2rtc'yi oturum açılınca otomatik başlatır (isteğe bağlı)
#   6. Panel için gereken MAC / IP bilgisini yazdırır

param(
  [string]$Go2rtcDir = "C:\go2rtc"
)

$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Bu betiği Yönetici olarak çalıştır."
}

Write-Host "1) Ping kuralı" -ForegroundColor Cyan
if (-not (Get-NetFirewallRule -DisplayName 'EvKontrol ICMP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'EvKontrol ICMP' -Protocol ICMPv4 -IcmpType 8 -Direction Inbound `
    -Action Allow -RemoteAddress LocalSubnet -Profile Any | Out-Null
}

Write-Host "2) go2rtc kuralı (1984/TCP, yalnızca yerel ağ)" -ForegroundColor Cyan
if (-not (Get-NetFirewallRule -DisplayName 'EvKontrol go2rtc' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'EvKontrol go2rtc' -Protocol TCP -LocalPort 1984 -Direction Inbound `
    -Action Allow -RemoteAddress LocalSubnet -Profile Any | Out-Null
}

Write-Host "3) Wake-on-LAN ayarları" -ForegroundColor Cyan
$wired = Get-NetAdapter -Physical | Where-Object { $_.MediaType -eq '802.3' }
foreach ($a in $wired) {
  try { Set-NetAdapterPowerManagement -Name $a.Name -WakeOnMagicPacket Enabled -ErrorAction Stop } catch { Write-Warning "$($a.Name): güç yönetimi ayarlanamadı ($_)" }
  foreach ($prop in 'Wake on Magic Packet', 'Magic Paketle Uyandır', 'Wake on magic packet') {
    try { Set-NetAdapterAdvancedProperty -Name $a.Name -DisplayName $prop -DisplayValue 'Enabled' -ErrorAction Stop } catch {}
  }
  try { Set-NetAdapterAdvancedProperty -Name $a.Name -DisplayName 'Shutdown Wake-On-Lan' -DisplayValue 'Enabled' -ErrorAction Stop } catch {}
}
if (-not $wired) { Write-Warning "Kablolu ağ kartı bulunamadı. Wi-Fi üzerinden WoL çoğu cihazda çalışmaz." }

Write-Host "4) Hızlı Başlatma kapatılıyor" -ForegroundColor Cyan
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 0

Write-Host "5) go2rtc otomatik başlatma" -ForegroundColor Cyan
$exe = Join-Path $Go2rtcDir 'go2rtc.exe'
if (Test-Path $exe) {
  $action  = New-ScheduledTaskAction -Execute $exe -Argument "-config `"$Go2rtcDir\go2rtc.yaml`"" -WorkingDirectory $Go2rtcDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -Hidden
  Register-ScheduledTask -TaskName 'EvKontrol go2rtc' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName 'EvKontrol go2rtc'
  Write-Host "   go2rtc görevi oluşturuldu ve başlatıldı."
} else {
  Write-Warning "$exe bulunamadı — go2rtc.exe, ffmpeg.exe ve go2rtc.yaml'ı $Go2rtcDir içine koyup betiği tekrar çalıştır."
}

Write-Host "`n6) Panel için bilgiler" -ForegroundColor Green
Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object {
  $ip = (Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
  [pscustomobject]@{ Kart = $_.Name; Tur = $_.MediaType; MAC = ($_.MacAddress -replace '-', ':'); IP = $ip }
} | Format-Table -AutoSize

Write-Host "BIOS/UEFI'de 'Wake on LAN' / 'Power On By PCI-E' seçeneğini de açmayı unutma." -ForegroundColor Yellow
Write-Host "Router'da bu cihaza sabit IP (DHCP rezervasyonu) tanımla." -ForegroundColor Yellow
