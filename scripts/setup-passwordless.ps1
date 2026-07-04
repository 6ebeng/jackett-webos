param(
  [string]$TVHost = '10.5.50.13',
  [string]$User = 'root',
  [string]$Password = 'alpine',
  [string]$KeyPath = "$env:USERPROFILE\.ssh\Jackett_tv"
)
$ErrorActionPreference = 'Stop'

# 1. Ensure a dedicated key exists.
$kd = Split-Path $KeyPath
if (-not (Test-Path $kd)) { New-Item -ItemType Directory $kd | Out-Null }
if (-not (Test-Path $KeyPath)) {
  ssh-keygen -t ed25519 -f $KeyPath -N '""' -C 'Jackett-webos' | Out-Null
}
$pub = (Get-Content "$KeyPath.pub" -Raw).Trim()

# 2. Ensure Posh-SSH is available (CurrentUser, no admin needed).
if (-not (Get-Module -ListAvailable -Name Posh-SSH)) {
  Write-Host 'Installing Posh-SSH (CurrentUser)...'
  Install-PackageProvider -Name NuGet -Force -Scope CurrentUser -ErrorAction SilentlyContinue | Out-Null
  Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
  Install-Module Posh-SSH -Scope CurrentUser -Force -AllowClobber
}
Import-Module Posh-SSH

# 3. Install the public key using one programmatic password auth.
$sec = ConvertTo-SecureString $Password -AsPlainText -Force
$cred = [System.Management.Automation.PSCredential]::new($User, $sec)
$sess = New-SSHSession -ComputerName $TVHost -Port 22 -Credential $cred -AcceptKey -Force
$cmd = "umask 077; mkdir -p `$HOME/.ssh; grep -qxF '$pub' `$HOME/.ssh/authorized_keys 2>/dev/null || echo '$pub' >> `$HOME/.ssh/authorized_keys; chmod 700 `$HOME/.ssh; chmod 600 `$HOME/.ssh/authorized_keys; echo INSTALLED home=`$HOME"
(Invoke-SSHCommand -SSHSession $sess -Command $cmd).Output
Remove-SSHSession -SSHSession $sess | Out-Null

# 4. Verify key-only auth (BatchMode -> never prompts).
Write-Host '--- testing key-only auth ---'
ssh -i $KeyPath -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o PreferredAuthentications=publickey -o IdentitiesOnly=yes "$User@$TVHost" "echo KEYOK uid=`$(id -u)"
if ($LASTEXITCODE -eq 0) { Write-Host 'PASSWORDLESS OK' -ForegroundColor Green }
else { Write-Host 'KEY AUTH FAILED' -ForegroundColor Red }
