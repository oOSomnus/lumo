import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signingPlan, signingStatus, windowsSigningCommand } from "./signing";

const windows = {
  WINDOWS_CERTIFICATE: "base64",
  WINDOWS_CERTIFICATE_PASSWORD: "secret",
  WINDOWS_CERTIFICATE_THUMBPRINT: "ABCDEF",
  WINDOWS_TIMESTAMP_URL: "http://timestamp.example",
};
const apple = {
  APPLE_CERTIFICATE: "base64",
  APPLE_CERTIFICATE_PASSWORD: "secret",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (TEAMID)",
};
const notarization = {
  APPLE_API_ISSUER: "issuer",
  APPLE_API_KEY: "key",
  APPLE_API_KEY_PATH: "/tmp/key.p8",
};

describe("signingPlan", () => {
  test("builds without credentials are unsigned or ad-hoc and say so", () => {
    expect(signingPlan("windows", {}).signed).toBe(false);
    expect(signingStatus("windows", signingPlan("windows", {}))).toContain("unsigned");
    const mac = signingPlan("macos", {});
    expect(mac).toMatchObject({ signed: false, notarized: false, config: null });
    expect(signingStatus("macos", mac)).toContain("ad-hoc");
    expect(signingPlan("linux", { ...windows, ...apple }).signed).toBe(false);
  });

  test("complete Windows credentials sign with SHA-256 and a timestamp", () => {
    const plan = signingPlan("windows", windows);
    expect(plan).toMatchObject({ signed: true, importWindowsCertificate: true });
    expect(plan.config).toEqual({
      bundle: {
        windows: {
          certificateThumbprint: "ABCDEF",
          digestAlgorithm: "sha256",
          timestampUrl: "http://timestamp.example",
        },
      },
    });
  });

  test("complete Apple credentials sign, and notarize only with the API key group", () => {
    const signed = signingPlan("macos", apple);
    expect(signed).toMatchObject({ signed: true, notarized: false });
    expect(signingStatus("macos", signed)).toBe("Developer ID signed, not notarized");
    const notarized = signingPlan("macos", { ...apple, ...notarization });
    expect(notarized.notarized).toBe(true);
    expect(signingStatus("macos", notarized)).toBe("Developer ID signed and notarized");
  });

  test.each([
    ["Windows without the timestamp URL", "windows", { ...windows, WINDOWS_TIMESTAMP_URL: "" }, /WINDOWS_TIMESTAMP_URL/],
    ["Windows with only the certificate", "windows", { WINDOWS_CERTIFICATE: "base64" }, /WINDOWS_CERTIFICATE_PASSWORD/],
    ["Apple without the password", "macos", { ...apple, APPLE_CERTIFICATE_PASSWORD: undefined }, /APPLE_CERTIFICATE_PASSWORD/],
    ["partial notarization", "macos", { ...apple, APPLE_API_ISSUER: "issuer" }, /APPLE_API_KEY/],
    ["notarization without signing", "macos", notarization, /Developer ID/],
  ] as const)("fails instead of downgrading: %s", (_label, platform, env, message) => {
    expect(() => signingPlan(platform, env)).toThrow(message);
  });
});

// The real lifecycle needs the Windows certificate store, so it runs on Windows only (CI covers it).
// Everything it creates is a throwaway self-signed key; nothing here touches real credentials.
describe.skipIf(process.platform !== "win32")("windows-signing.ps1", () => {
  const PASSWORD = "lumo-test-password";
  const POWERSHELL = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
  const work = mkdtempSync(join(tmpdir(), "lumo-signing-"));
  const record = join(work, "record.json");
  const fixturePfx = join(work, "signer.pfx");
  let signer = "";
  let bystander = "";
  let pfxBase64 = "";

  const lib = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Get-Cert([string]$thumbprint) {
  Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
}
# Signs with the certificate's private key and describes where that key lives (CNG or legacy CSP).
function Get-KeyInfo($cert) {
  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
  if (-not $rsa) { return @{ usable = $false } }
  try {
    $data = [byte[]](1, 2, 3)
    $hash = [System.Security.Cryptography.HashAlgorithmName]::SHA256
    $padding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    $signature = $rsa.SignData($data, $hash, $padding)
    $public = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($cert)
    try { $verified = $public.VerifyData($data, $signature, $hash, $padding) } finally { $public.Dispose() }
    $info = @{ usable = $verified; kind = 'csp'; name = ''; provider = ''; type = 0 }
    if ($rsa -is [System.Security.Cryptography.RSACng]) {
      $info.kind = 'cng'
      $info.name = $rsa.Key.KeyName
    } else {
      $container = $rsa.CspKeyContainerInfo
      $info.name = $container.KeyContainerName
      $info.provider = $container.ProviderName
      $info.type = $container.ProviderType
    }
    return $info
  } finally { $rsa.Dispose() }
}
# Opens the key by name; only "no such key" counts as absent.
function Test-KeyExists($info) {
  try {
    if ($info.kind -eq 'cng') {
      [System.Security.Cryptography.CngKey]::Open($info.name).Dispose()
    } else {
      $csp = New-Object System.Security.Cryptography.CspParameters($info.type, $info.provider, $info.name)
      $csp.Flags = [System.Security.Cryptography.CspProviderFlags]::UseExistingKey
      (New-Object System.Security.Cryptography.RSACryptoServiceProvider($csp)).Dispose()
    }
    return $true
  } catch {
    $e = $_.Exception
    if ($e.InnerException) { $e = $e.InnerException }
    if ($e -is [System.Security.Cryptography.CryptographicException]) { return $false }
    throw
  }
}
`;

  function powershell(name: string, script: string, args: string[] = [], env: Record<string, string> = {}) {
    const file = join(work, `${name}.ps1`);
    writeFileSync(file, lib + script);
    const result = Bun.spawnSync([...POWERSHELL, file, ...args], {
      env: { ...process.env, SIGNER: signer, BYSTANDER: bystander, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(`${name}.ps1 exited with ${result.exitCode}: ${result.stderr}`);
    return result.stdout.toString().trim();
  }

  // Deletes certificates and their keys; a test only ever removes what it created.
  function remove(...thumbprints: string[]) {
    const present = thumbprints.filter(Boolean);
    if (present.length === 0) return;
    powershell(
      "remove",
      String.raw`foreach ($thumbprint in $args) { if (Get-Cert $thumbprint) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -DeleteKey } }`,
      present,
    );
  }

  beforeAll(() => {
    const fixtures = powershell(
      "fixtures",
      String.raw`
$password = ConvertTo-SecureString $env:FIXTURE_PASSWORD -AsPlainText -Force
function New-Fixture([string]$name) {
  New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=$name" -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -Provider 'Microsoft Software Key Storage Provider' -CertStoreLocation Cert:\CurrentUser\My
}
$first = New-Fixture 'lumo-signing-test-signer'
Export-PfxCertificate -Cert $first -FilePath $env:FIXTURE_PFX -Password $password | Out-Null
# Only the PFX keeps the signer: the wrapper must be the one to import it.
Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($first.Thumbprint)" -DeleteKey
$other = New-Fixture 'lumo-signing-test-bystander'
@{ signer = $first.Thumbprint; bystander = $other.Thumbprint } | ConvertTo-Json -Compress
`,
      [],
      { FIXTURE_PASSWORD: PASSWORD, FIXTURE_PFX: fixturePfx },
    );
    ({ signer, bystander } = JSON.parse(fixtures.split("\n").pop() ?? ""));
    pfxBase64 = readFileSync(fixturePfx).toString("base64");
  }, 120_000);

  afterAll(() => {
    try {
      remove(signer, bystander);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);

  // The command the wrapper runs: proves the key worked and the secrets were gone, then exits as asked.
  const inner = String.raw`
$Record = $args[0]
$ExitCode = [int]$args[1]
$info = Get-KeyInfo (Get-Cert $env:SIGNER)
$info.leaked = @('WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD' | Where-Object { Test-Path "Env:$_" })
$info.tempFiles = @(Get-ChildItem $env:TEMP -Filter *.tmp).Count
$info | ConvertTo-Json -Compress | Set-Content -LiteralPath $Record
exit $ExitCode
`;

  function runWrapper(options: { exit?: number; thumbprint?: string; password?: string } = {}) {
    rmSync(record, { force: true });
    const temp = mkdtempSync(join(work, "temp-"));
    writeFileSync(join(work, "inner.ps1"), lib + inner);
    const command = [...POWERSHELL, join(work, "inner.ps1"), record, String(options.exit ?? 0)];
    const result = Bun.spawnSync(windowsSigningCommand(command), {
      env: {
        ...process.env,
        SIGNER: signer,
        BYSTANDER: bystander,
        TEMP: temp,
        TMP: temp,
        WINDOWS_CERTIFICATE: pfxBase64,
        WINDOWS_CERTIFICATE_PASSWORD: options.password ?? PASSWORD,
        WINDOWS_CERTIFICATE_THUMBPRINT: options.thumbprint ?? signer,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const ran = readdirSync(work).includes("record.json");
    return {
      code: result.exitCode,
      err: result.stderr.toString(),
      ran,
      info: ran ? JSON.parse(readFileSync(record, "utf8")) : null,
      leftoverFiles: readdirSync(temp).filter((name) => name.endsWith(".tmp")),
    };
  }

  function state() {
    const out = powershell(
      "state",
      String.raw`
$signer = Get-Cert $env:SIGNER
$bystander = Get-Cert $env:BYSTANDER
$out = @{ signerPresent = [bool]$signer; signerUsable = $false; bystanderUsable = $false; bystanderKeyExists = $false }
if ($signer) { $out.signerUsable = [bool](Get-KeyInfo $signer).usable }
if ($bystander) {
  $info = Get-KeyInfo $bystander
  $out.bystanderUsable = [bool]$info.usable
  $out.bystanderKeyExists = Test-KeyExists $info
}
$out | ConvertTo-Json -Compress
`,
    );
    return JSON.parse(out.split("\n").pop() ?? "") as Record<string, boolean>;
  }

  function keyExists(info: unknown) {
    writeFileSync(record, JSON.stringify(info));
    return powershell("key", "Test-KeyExists (Get-Content -Raw -LiteralPath $args[0] | ConvertFrom-Json)", [record]) === "True";
  }

  test("removes the certificate, its private key and the temporary PFX after a successful command", () => {
    const run = runWrapper();
    expect({ code: run.code, err: run.err }).toMatchObject({ code: 0 });
    // While the command ran: the key signed, the secrets were gone, the temporary PFX existed.
    expect(run.info).toMatchObject({ usable: true, leaked: [] });
    expect(run.info.tempFiles).toBeGreaterThanOrEqual(1);
    expect(run.leftoverFiles).toEqual([]);
    expect(state()).toMatchObject({ signerPresent: false, bystanderUsable: true, bystanderKeyExists: true });
    expect(keyExists(run.info)).toBe(false);
  }, 120_000);

  test("cleans up the same way when the command fails, and fails the build", () => {
    const run = runWrapper({ exit: 3 });
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("exited with code 3");
    expect(run.info).toMatchObject({ usable: true });
    expect(run.leftoverFiles).toEqual([]);
    expect(state()).toMatchObject({ signerPresent: false, bystanderUsable: true });
    expect(keyExists(run.info)).toBe(false);
  }, 120_000);

  test("refuses a certificate that is already installed and leaves it and its key alone", () => {
    powershell(
      "preinstall",
      String.raw`Import-PfxCertificate -FilePath $env:FIXTURE_PFX -CertStoreLocation Cert:\CurrentUser\My -Password (ConvertTo-SecureString $env:FIXTURE_PASSWORD -AsPlainText -Force) | Out-Null`,
      [],
      { FIXTURE_PASSWORD: PASSWORD, FIXTURE_PFX: fixturePfx },
    );
    try {
      const run = runWrapper();
      expect(run.code).not.toBe(0);
      expect(run.err).toContain("already in");
      expect(run.ran).toBe(false);
      expect(run.leftoverFiles).toEqual([]);
      expect(state()).toMatchObject({ signerPresent: true, signerUsable: true, bystanderUsable: true });
    } finally {
      remove(signer);
    }
  }, 120_000);

  test.each([
    ["a thumbprint that is not in the PFX", { thumbprint: "0".repeat(40) }, "exactly one"],
    ["the wrong password", { password: "not-the-password" }, "windows-signing:"],
  ])("imports nothing and runs nothing for %s", (_label, options, message) => {
    const run = runWrapper(options);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain(message);
    expect(run.ran).toBe(false);
    expect(run.leftoverFiles).toEqual([]);
    expect(state()).toMatchObject({ signerPresent: false, bystanderUsable: true });
  }, 120_000);
});
