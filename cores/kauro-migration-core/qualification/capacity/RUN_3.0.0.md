# Capacity campaign for 3.0.0: how to start and check it

Campaign `c_c87b11a87f0014e3` (resealed 2026-10-02 after capacity profiles 1.2.1, D75; the first run under `c_ff861b3c4dbb4178` stopped at P13). Needs a quiet machine, about 12-13 h. Run from the repository root
(`C:\Projects\Kauro\repos\mc-worktrees\mc-203-fix`) on a clean, built tree (`npm run build`).
Do not touch `src/`, `tools/` or `qualification/` while it runs: the producers capture the subject digest at start and end.

Two sequential invocations, one detached PowerShell wrapper (matrix first, then founding; founding is not started if the matrix fails):

```powershell
New-Item -ItemType Directory -Force bench\capacity\logs | Out-Null
Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList '-NoProfile','-Command',
  "node tools/capacity.mjs --profile P1,P2,P3,P4,P5,P6,P7,P8,P9,P10,P11,P12,P13,P14 --rows 1000000 --matrix *> bench\capacity\logs\matrix.log; if (`$LASTEXITCODE -eq 0) { node tools/capacity.mjs --profile FOUNDING-CLEAN-ONLY-1M,FOUNDING-HUBSPOT-1M,FOUNDING-SALESFORCE-1M --rows 1000000 --founding *> bench\capacity\logs\founding.log }; 'DONE rc='+`$LASTEXITCODE | Out-File bench\capacity\logs\done.txt"
```

Check:

```powershell
Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object CommandLine -match capacity | Select ProcessId,CommandLine   # still running?
Get-Content bench\capacity\logs\matrix.log -Tail 5; Get-Content bench\capacity\logs\founding.log -Tail 5 -ErrorAction SilentlyContinue
Get-Content bench\capacity\logs\done.txt -ErrorAction SilentlyContinue                                                              # exists = finished
```

Outputs when done: `qualification/capacity/matrix.json`, `clean-only.json`, `hubspot.json`, `salesforce.json`; then `npm run provenance:check`.

Dry run of the argument parsing (exits 64 without measuring anything): `node tools/capacity.mjs --profile NOPE --rows 1000000 --matrix`.
WARNING: `tools/capacity.mjs` has no `--help`; unknown flags start a real run.

The chain matrix oracle now derives P1-P14 from profiles.json.
