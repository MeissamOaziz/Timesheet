# Runs the Supabase CLI as the PunchClock account, whatever account the machine's global `supabase login` is on.
#
# Why: the CLI keeps ONE global login per Windows user, and other Supabase projects on this PC (other accounts) keep
# replacing it, which made every PunchClock deploy fail with a 403. This wrapper reads a PunchClock-only personal access
# token from a file that only this Windows user can decrypt (DPAPI) and hands it to the CLI for this one command only.
# The token is never printed, never put on the command line, and never stored in this repository.
#
# One-time setup (run in your own PowerShell, paste the token when asked; nothing is echoed):
#   Read-Host -AsSecureString "Paste the PunchClock token" | ConvertFrom-SecureString | Set-Content "$env:USERPROFILE\.punchclock-supabase-token"
#
# Use:   powershell -NoProfile -File tools\sb.ps1 projects list
#        powershell -NoProfile -File tools\sb.ps1 functions deploy <name> --project-ref uziwymrwaeojhqaagqcm --no-verify-jwt --use-api --yes
$ErrorActionPreference = 'Stop'
$file = Join-Path $env:USERPROFILE '.punchclock-supabase-token'
if (-not (Test-Path $file)) {
  Write-Error "No token file at $file. Do the one-time setup described at the top of tools\sb.ps1."
  exit 2
}
try {
  $secure = (Get-Content $file -Raw).Trim() | ConvertTo-SecureString
  $env:SUPABASE_ACCESS_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
} catch {
  Write-Error "The token file could not be decrypted (it can only be read by the Windows user that created it). Redo the setup."
  exit 3
}
& npx.cmd supabase @args
exit $LASTEXITCODE
