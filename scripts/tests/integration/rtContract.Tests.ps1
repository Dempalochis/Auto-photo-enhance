<#
  Version 2 Phase 1 task 5: contract tests against the REAL rawtherapee-cli. Tagged Integration:
  the default `Invoke-Pester scripts/tests` run includes them but each test skips when no
  RawTherapee or no sample raw is found; run only these with
      Invoke-Pester scripts/tests -TagFilter Integration
  Sample raws: _samples/ (gitignored), or set $env:APE_SAMPLE_RAW to one file.
#>
BeforeDiscovery {
    . "$PSScriptRoot/../../lib_common.ps1"
    $root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    $cfgPath = Join-Path $root "config\config.json"
    $cfg = Read-EnhanceConfig $cfgPath
    $rt = $null
    if ($cfg.rtPath -and (Test-Path -LiteralPath $cfg.rtPath)) { $rt = $cfg.rtPath }
    if (-not $rt) { $c = Get-Command rawtherapee-cli -ErrorAction SilentlyContinue; if ($c) { $rt = $c.Source } }
    if (-not $rt) { $c = Get-Command rawtherapee-cli.exe -ErrorAction SilentlyContinue; if ($c) { $rt = $c.Source } }
    $sample = $env:APE_SAMPLE_RAW
    if (-not $sample) {
        $dir = Join-Path $root "_samples"
        if (Test-Path $dir) { $f = Get-ChildItem -LiteralPath $dir -File | Where-Object { Test-IsRawFile $_ } | Sort-Object Length | Select-Object -First 1; if ($f) { $sample = $f.FullName } }
    }
    $script:Skip = -not ($rt -and $sample)
    $script:SkipReason = if (-not $rt) { "no RawTherapee CLI found" } elseif (-not $sample) { "no sample raw in _samples/" } else { "" }
}

BeforeAll {
    . "$PSScriptRoot/../../lib_common.ps1"
    $script:Root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    $cfg = Read-EnhanceConfig (Join-Path $Root "config\config.json")
    $script:RT = if ($cfg.rtPath -and (Test-Path -LiteralPath $cfg.rtPath)) { $cfg.rtPath } else { (Get-Command rawtherapee-cli, rawtherapee-cli.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
    $script:Sample = $env:APE_SAMPLE_RAW
    if (-not $Sample) { $Sample = (Get-ChildItem -LiteralPath (Join-Path $Root "_samples") -File -ErrorAction SilentlyContinue | Where-Object { Test-IsRawFile $_ } | Sort-Object Length | Select-Object -First 1).FullName }
    $script:Base = Join-Path $Root "profiles\default.pp3"
    $script:Draft = Get-DraftOverridePath $Root
    $script:Work = Join-Path ([System.IO.Path]::GetTempPath()) ("ape-rt-contract-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $Work | Out-Null

    function Get-JpegSize([string]$Path) {
        # Reads width/height from the JPEG SOF0/SOF2 marker - no image library needed.
        $b = [System.IO.File]::ReadAllBytes($Path)
        $i = 2
        while ($i -lt $b.Length - 9) {
            if ($b[$i] -ne 0xFF) { $i++; continue }
            $m = $b[$i + 1]
            if ($m -eq 0xC0 -or $m -eq 0xC2) { return @{ H = $b[$i + 5] * 256 + $b[$i + 6]; W = $b[$i + 7] * 256 + $b[$i + 8] } }
            $len = $b[$i + 2] * 256 + $b[$i + 3]
            $i += 2 + $len
        }
        return $null
    }
}

AfterAll { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }

Describe "RawTherapee CLI contract" -Tag "Integration" {
    It "draft render exits 0, prints no Usage: text and is about Scale 0.15 of the sensor size" -Skip:$Skip {
        $out = Join-Path $Work "draft.jpg"
        $a = Build-RTArgs -Mode draft -Base $Base -DraftOverride $Draft -Inputs @($Sample) -Out $out
        $r = Invoke-RawTherapee -RTPath $RT -RTArgs $a
        $r.ExitCode | Should -Be 0
        $r.Stdout | Should -Not -Match "Usage:"
        Test-Path $out | Should -BeTrue
        $s = Get-JpegSize $out
        [math]::Max($s.W, $s.H) | Should -BeLessThan 1400
        [math]::Max($s.W, $s.H) | Should -BeGreaterThan 300
    }

    It "final render exits 0 at (close to) full sensor size" -Skip:$Skip {
        $out = Join-Path $Work "final.jpg"
        $a = Build-RTArgs -Mode final -Base $Base -Inputs @($Sample) -Out $out
        $r = Invoke-RawTherapee -RTPath $RT -RTArgs $a
        $r.ExitCode | Should -Be 0
        $s = Get-JpegSize $out
        [math]::Max($s.W, $s.H) | Should -BeGreaterThan 2000
    }

    It "streams stdout line by line through -OnLine, including the per-file Processing: line" -Skip:$Skip {
        $script:seen = New-Object System.Collections.Generic.List[string]
        $a = Build-RTArgs -Mode draft -Base $Base -DraftOverride $Draft -Inputs @($Sample) -Out (Join-Path $Work "stream.jpg")
        $r = Invoke-RawTherapee -RTPath $RT -RTArgs $a -OnLine { param($l) $script:seen.Add($l) }
        $r.ExitCode | Should -Be 0
        @($seen | Where-Object { $_ -like "Processing: *" }).Count | Should -Be 1
    }

    It "multi-file -c with -o <dir> names outputs <stem>.jpg and keeps going past an unreadable file" -Skip:$Skip {
        $in = Join-Path $Work "in"; $outDir = Join-Path $Work "batch"
        New-Item -ItemType Directory -Force -Path $in, $outDir | Out-Null
        $good = Join-Path $in ("good" + [System.IO.Path]::GetExtension($Sample))
        Copy-Item -LiteralPath $Sample -Destination $good
        $bad = Join-Path $in "bad.ARW"
        [System.IO.File]::WriteAllBytes($bad, [byte[]](1..2048 | ForEach-Object { $_ % 200 }))
        $a = Build-RTArgs -Mode draft -Base $Base -DraftOverride $Draft -Inputs @($bad, $good) -Out $outDir
        $r = Invoke-RawTherapee -RTPath $RT -RTArgs $a
        $r.ExitCode | Should -Not -Be 0
        Test-Path (Join-Path $outDir "good.jpg") | Should -BeTrue
        Test-Path (Join-Path $outDir "bad.jpg") | Should -BeFalse
    }
}

Describe "Batched rendering against the real CLI" -Tag "Integration" {
    It "a 4-file batch with one truncated file: progress events arrive DURING the batch, the bad file is retried alone" -Skip:$Skip {
        $samples = @(Get-ChildItem -LiteralPath (Join-Path $Root "_samples") -File -ErrorAction SilentlyContinue | Where-Object { Test-IsRawFile $_ } | Sort-Object Length | Select-Object -First 3)
        if ($samples.Count -lt 3) { Set-ItResult -Skipped -Because "needs 3 sample raws in _samples/"; return }
        $in = Join-Path $Work "bin"; $out = Join-Path $Work "bout"; $log = Join-Path $Work "blog"
        New-Item -ItemType Directory -Force -Path $in | Out-Null
        $i = 0
        foreach ($s in $samples) { $i++; Copy-Item -LiteralPath $s.FullName -Destination (Join-Path $in ("s$i" + $s.Extension)) }
        $bytes = [System.IO.File]::ReadAllBytes($samples[0].FullName)
        [System.IO.File]::WriteAllBytes((Join-Path $in "s2b_truncated.ARW"), $bytes[0..49999])
        $cfgFile = Join-Path $Work "bcfg.json"
        @{ rtPath = $RT; autoProfile = @{ enabled = $false }; quarantineAfterFailures = 2 } | ConvertTo-Json | Set-Content -LiteralPath $cfgFile

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = (Get-Process -Id $PID).Path
        $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'scripts/auto_enhance.ps1')`" -InputDir `"$in`" -OutputDir `"$out`" -LogDir `"$log`" -ConfigPath `"$cfgFile`" -BatchRender true -EmitEvents"
        $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $p = [System.Diagnostics.Process]::Start($psi)
        $errTask = $p.StandardError.ReadToEndAsync()
        $events = New-Object System.Collections.Generic.List[object]
        while ($null -ne ($line = $p.StandardOutput.ReadLine())) {
            if ($line.StartsWith("@@EVENT ")) { $e = $line.Substring(8) | ConvertFrom-Json; $events.Add([pscustomobject]@{ Ms = $sw.ElapsedMilliseconds; E = $e }) }
        }
        $p.WaitForExit(); $total = $sw.ElapsedMilliseconds; $null = $errTask.Result

        $completed = @($events | Where-Object { $_.E.event -eq "file_completed" })
        $completed.Count | Should -Be 3
        # The first finished file is reported well before the run ends (live, not a burst at the end).
        $completed[0].Ms | Should -BeLessThan ($total - 1000)
        @($events | Where-Object { $_.E.event -eq "batch_started" }).Count | Should -Be 1
        $failed = @($events | Where-Object { $_.E.event -eq "file_failed" })
        $failed.Count | Should -Be 1
        $failed[0].E.file | Should -Match "truncated"
        Test-Path (Join-Path $in "s2b_truncated.ARW.attempts") | Should -BeTrue
        @(Get-ChildItem -LiteralPath $out -Force | Where-Object { $_.Name -like ".rt_batch_*" }).Count | Should -Be 0
    }
}
