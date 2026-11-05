# Windows Defender ASR Exclusions for Rust Development

Run all commands in an **elevated PowerShell** (Run as Administrator).

## Path Exclusions

These cover the build output directories so Defender doesn't block freshly compiled executables:

```powershell
Add-MpPreference -ExclusionPath "C:\Users\C5333096\.cargo"
Add-MpPreference -ExclusionPath "C:\Users\C5333096\Documents\workspace"
Add-MpPreference -ExclusionPath "C:\Users\C5333096\Documents\workspace\abt\target"
Add-MpPreference -ExclusionPath "C:\Users\C5333096\.cargo\registry"
```

## ASR-Only Exclusions

These are required because the ASR rule `01443614` (block unknown executables) is enforced via GPO
and ignores regular path exclusions. Each output subdirectory must be listed explicitly:

```powershell
Add-MpPreference -AttackSurfaceReductionOnlyExclusions "C:\Users\C5333096\Documents\workspace\abt\target"
Add-MpPreference -AttackSurfaceReductionOnlyExclusions "C:\Users\C5333096\.cargo\registry"
Add-MpPreference -AttackSurfaceReductionOnlyExclusions "C:\Users\C5333096\Documents\workspace\abt\target\debug"
Add-MpPreference -AttackSurfaceReductionOnlyExclusions "C:\Users\C5333096\Documents\workspace\abt\target\x86_64-pc-windows-msvc\debug"
Add-MpPreference -AttackSurfaceReductionOnlyExclusions "C:\Users\C5333096\Documents\workspace\abt\target\x86_64-pc-windows-msvc\debug\deps"
```

## Process Exclusions

```powershell
Add-MpPreference -ExclusionProcess "cargo.exe"
Add-MpPreference -ExclusionProcess "rustc.exe"
Add-MpPreference -ExclusionProcess "link.exe"
Add-MpPreference -ExclusionProcess "build-script-build.exe"
```

## ASR Rule Attempted (blocked by GPO)

The following rule was attempted but could not be disabled because Group Policy overrides local settings:

```powershell
# Does NOT work on this machine — GPO enforces it
Set-MpPreference -AttackSurfaceReductionRules_Ids 01443614-cd74-433a-b99e-2ecdc07bfc25 `
                 -AttackSurfaceReductionRules_Actions 0
```

## Notes

- After `cargo clean`, the `target\` subdirectories are deleted and recreated. The ASR exclusions
  on those paths persist, but any binary compiled into a path not yet excluded will be blocked.
  Re-run the ASR-only exclusions block above if new subdirectories appear.
- The ASR rule `01443614-cd74-433a-b99e-2ecdc07bfc25` blocks executables based on prevalence/age.
  Path exclusions under `AttackSurfaceReductionOnlyExclusions` are the only local bypass available
  when GPO controls the rule state.
- These exclusions survive reboots but may be reset by a GPO refresh (`gpupdate /force`).
