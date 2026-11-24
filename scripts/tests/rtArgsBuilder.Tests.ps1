<#
  Version 2 Phase 1: Build-RTArgs is the one place rawtherapee-cli arguments are built. Pins the
  -p stack order per mode and that "final" mode reproduces Version 1's exact argument shape.
#>
BeforeAll {
    . "$PSScriptRoot/../lib_common.ps1"
}

Describe "Build-RTArgs" {
    It "final mode, base only: exactly Version 1's shape" {
        $a = Build-RTArgs -Mode final -Base "B.pp3" -Inputs @("in.ARW") -Out "out.jpg" -Quality 95
        ($a -join "|") | Should -Be "-p|B.pp3|-o|out.jpg|-j95|-Y|-q|-c|in.ARW"
    }

    It "final mode stacks base -> format overlay -> AI overlay -> preset" {
        $a = Build-RTArgs -Mode final -Base "B" -FormatOverlay "F" -AiOverlay "AI" -Preset "P" -Inputs @("in") -Out "o" -Quality 90
        (Get-RTProfileStack $a) -join "," | Should -Be "B,F,AI,P"
        $a -contains "-f" | Should -BeFalse
        $a -contains "-j90" | Should -BeTrue
    }

    It "final mode ignores a draft override" {
        $a = Build-RTArgs -Mode final -Base "B" -DraftOverride "D" -Inputs @("in") -Out "o"
        (Get-RTProfileStack $a) -join "," | Should -Be "B"
        $a -contains "-f" | Should -BeFalse
    }

    It "draft mode: -f first and the draft override LAST, after the preset" {
        $a = Build-RTArgs -Mode draft -Base "B" -FormatOverlay "F" -AiOverlay "AI" -Preset "P" -DraftOverride "D" -Inputs @("in") -Out "o"
        $a[0] | Should -Be "-f"
        (Get-RTProfileStack $a) -join "," | Should -Be "B,F,AI,P,D"
    }

    It "draft mode reproduces Version 1's preview argument shape" {
        $a = Build-RTArgs -Mode draft -Base "B" -Preset "P" -DraftOverride "D" -Inputs @("src.ARW") -Out "tile.jpg" -Quality 95
        ($a -join "|") | Should -Be "-f|-p|B|-p|P|-p|D|-o|tile.jpg|-j95|-Y|-q|-c|src.ARW"
    }

    It "draft mode without a draft override degrades to the plain stack (no -f), like Version 1" {
        $a = Build-RTArgs -Mode draft -Base "B" -Preset "P" -Inputs @("in") -Out "o"
        $a -contains "-f" | Should -BeFalse
        (Get-RTProfileStack $a) -join "," | Should -Be "B,P"
    }

    It "several inputs follow -c in order (batch mode, -Out is a folder)" {
        $a = Build-RTArgs -Mode final -Base "B" -Inputs @("a.ARW", "b.ARW", "c.ARW") -Out "tmpdir"
        $c = [Array]::IndexOf($a, "-c")
        ($a[($c + 1)..($a.Count - 1)]) -join "," | Should -Be "a.ARW,b.ARW,c.ARW"
    }

    It "returns an array even for a single-element stack" {
        $a = Build-RTArgs -Mode final -Base "B" -Inputs @("in") -Out "o"
        , $a | Should -BeOfType [object[]]
    }

    It "the draft override file exists under its Version 2 name" {
        $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        Get-DraftOverridePath $root | Should -Not -BeNullOrEmpty
        Test-Path (Join-Path $root "profiles/preview_fast_resize.pp3") | Should -BeFalse
    }
}
