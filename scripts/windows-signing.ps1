# Runs a command with the Windows signing certificate imported for exactly its duration.
# The certificate and password arrive through the environment, never the command line; the
# command (non-secret argv, a JSON array) runs without them. Certificates this script imported
# are removed with their private keys afterwards, on success and failure alike. Certificates
# that were already in the user's store are never touched: their presence fails the build.
param([Parameter(Mandatory = $true)][string]$CommandJson)

$ErrorActionPreference = 'Stop'
$store = 'Cert:\CurrentUser\My'

$file = $null
$owned = @()
$errors = @()
try {
  $command = [string[]]($CommandJson | ConvertFrom-Json)
  if ($null -eq $command -or $command.Length -eq 0) { throw 'no command to run' }

  $file = [IO.Path]::GetTempFileName()
  [IO.File]::WriteAllBytes($file, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
  $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force

  # Get-PfxData reads the file without importing anything.
  $pfx = Get-PfxData -FilePath $file -Password $password
  $signers = @($pfx.EndEntityCertificates | Where-Object { $_.Thumbprint -eq $env:WINDOWS_CERTIFICATE_THUMBPRINT })
  if ($signers.Count -ne 1) {
    throw 'WINDOWS_CERTIFICATE_THUMBPRINT must match exactly one end-entity certificate in the PFX'
  }
  $thumbprints = @(@($pfx.EndEntityCertificates) + @($pfx.OtherCertificates) | ForEach-Object { $_.Thumbprint } | Select-Object -Unique)

  foreach ($thumbprint in $thumbprints) {
    if (Test-Path -LiteralPath "$store\$thumbprint") {
      throw "certificate $thumbprint is already in $store; refusing to take ownership of it"
    }
  }
  # Deleting our certificate's key would also break any other certificate that uses the same key pair.
  $publicKey = [Convert]::ToBase64String($signers[0].GetPublicKey())
  foreach ($existing in Get-ChildItem Cert:\CurrentUser -Recurse) {
    if ($existing -is [Security.Cryptography.X509Certificates.X509Certificate2] -and
        [Convert]::ToBase64String($existing.GetPublicKey()) -ceq $publicKey) {
      throw "a certificate with the signing key is already in the user store ($($existing.PSParentPath)); refusing to delete a shared private key"
    }
  }

  # From here on whatever of this set exists in the store is ours (preflight proved it was absent).
  $owned = $thumbprints
  Import-PfxCertificate -FilePath $file -CertStoreLocation $store -Password $password | Out-Null
  Remove-Item Env:WINDOWS_CERTIFICATE, Env:WINDOWS_CERTIFICATE_PASSWORD

  $global:LASTEXITCODE = 0
  $executable = $command[0]
  $arguments = @($command | Select-Object -Skip 1)
  & $executable @arguments
  if ($LASTEXITCODE -ne 0) { throw "$executable exited with code $LASTEXITCODE" }
} catch {
  $errors += $_.Exception.Message
} finally {
  foreach ($thumbprint in $owned) {
    try {
      $path = "$store\$thumbprint"
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -DeleteKey }
    } catch {
      $errors += "could not remove certificate ${thumbprint}: $($_.Exception.Message)"
    }
  }
  if ($file) {
    try { Remove-Item -LiteralPath $file -Force } catch { $errors += "could not delete the temporary PFX: $($_.Exception.Message)" }
  }
}

if ($errors.Count -gt 0) {
  foreach ($message in $errors) { [Console]::Error.WriteLine("windows-signing: $message") }
  exit 1
}
