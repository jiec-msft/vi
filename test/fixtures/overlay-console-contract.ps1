param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference='Stop'
foreach($entry in @(
    @{file='overlay-ci-console.ps1';names=@('Assert-OverlayConsoleProbeExit')},
    @{file='overlay-ci-console-negative.ps1';names=@('Failure-Text','Get-OverlayFailureWitness')}
)){
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Source $entry.file),[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'Console source has parser errors.'}
    foreach($name in $entry.names){
        $functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true))
        if($functions.Count -ne 1){throw 'Pure console contract function was not uniquely identified.'}
        . ([scriptblock]::Create($functions[0].Extent.Text))
    }
}
function Check([bool]$Value,[string]$Message){if(!$Value){throw $Message}}
$checks=[Collections.Generic.List[string]]::new()
$self=[Diagnostics.Process]::GetCurrentProcess()
try{
    $caught=$null
    try{[void]$self.get_ExitCode()}catch{$caught=$_.Exception}
    $leaf=$caught
    while($leaf -and $leaf.InnerException){$leaf=$leaf.InnerException}
    Check ($leaf -is [InvalidOperationException]) 'Actual Process exit-code accessor did not expose a running-process failure.'
}finally{$self.Dispose()}
$checks.Add('native-process-accessor-contract')
foreach($mode in @('zero','nonzero','timeout','wait-error','exit-error')){
    $probe=[pscustomobject]@{mode=$mode;budget=$null;reads=0;failure=[IO.IOException]::new('Controlled probe failure.')}
    $probe|Add-Member ScriptMethod WaitForExit {
        param($budget)
        $this.budget=$budget
        if($this.mode -eq 'wait-error'){throw $this.failure}
        return $this.mode -ne 'timeout'
    }
    $probe|Add-Member ScriptMethod get_ExitCode {
        $this.reads++
        if($this.mode -eq 'exit-error'){throw $this.failure}
        if($this.mode -eq 'nonzero'){return 7}
        return 0
    }
    $report=@{probeProcess=@{}}
    $caught=$null
    try{Assert-OverlayConsoleProbeExit $probe $report}catch{$caught=$_.Exception}
    $observation=$report.probeProcess.exitWait
    Check ($probe.budget -eq 5000) 'Probe exit budget changed.'
    Check ($observation.elapsedMilliseconds -ge 0) 'Probe exit elapsed observation was lost.'
    switch($mode){
        'zero' {Check ($null -eq $caught -and $observation.outcome -eq 'exited-zero' -and $observation.waitCompleted -and $observation.exitCode -eq 0) 'Successful probe completion was not retained.'}
        'nonzero' {Check ($null -ne $caught -and $observation.outcome -eq 'exited-nonzero' -and $observation.waitCompleted -and $observation.exitCode -eq 7) 'Nonzero probe exit was accepted or its actual code lost.'}
        'timeout' {Check ($null -ne $caught -and $observation.outcome -eq 'timeout' -and !$observation.waitCompleted -and $null -eq $observation.exitCode -and $probe.reads -eq 0) 'Probe timeout read a nonexistent exit code or was accepted.'}
        default {
            $expectedOutcome=if($mode -eq 'wait-error'){'wait-error'}else{'exit-code-error'}
            Check ($null -ne $caught -and $observation.outcome -eq $expectedOutcome) "Probe API failure lost its phase: mode=$mode outcome=$($observation.outcome) caught=$($null -ne $caught)."
            $leaf=$caught
            while($leaf.InnerException){$leaf=$leaf.InnerException}
            Check ([Object]::ReferenceEquals($leaf,$probe.failure)) 'Probe API failure identity was replaced.'
        }
    }
    $checks.Add("probe-$mode")
}
foreach($entry in @(
    @{stage='prepare';reason='Injected prepare failure.'},
    @{stage='receipt';reason='Rollback verification or explicit diagnostic error receipt missing.'},
    @{stage='mismatch';reason='Injected parent registry mismatch assertion.'}
)){
    $output="$([char]27)[31mVI_PARENT_FAIL:$($entry.stage)$([char]27)[0m`r`n$($entry.reason)"
    $witness=Get-OverlayFailureWitness $output "VI_PARENT_FAIL:$($entry.stage)" $entry.reason
    Check ($witness.matched -and $witness.markerMatched -and $witness.reasonMatched -and $witness.observedStages.Count -eq 1 -and $witness.observedStages[0] -eq $entry.stage) 'Exact expected failure witness was lost.'
    $checks.Add("witness-$($entry.stage)")
}
$wrong=Get-OverlayFailureWitness 'VI_PARENT_FAIL:prepare Owned console probe did not exit cleanly.' 'VI_PARENT_FAIL:receipt' 'diagnostic error receipt missing'
Check (!$wrong.matched -and !$wrong.markerMatched -and !$wrong.reasonMatched -and $wrong.observedStages[0] -eq 'prepare') 'An earlier preparation failure was accepted as receipt fault injection.'
$missingReason=Get-OverlayFailureWitness 'VI_PARENT_FAIL:receipt unrelated failure' 'VI_PARENT_FAIL:receipt' 'diagnostic error receipt missing'
Check (!$missingReason.matched -and $missingReason.markerMatched -and !$missingReason.reasonMatched) 'Failure marker alone replaced the required reason.'
$missingMarker=Get-OverlayFailureWitness 'diagnostic error receipt missing' 'VI_PARENT_FAIL:receipt' 'diagnostic error receipt missing'
Check (!$missingMarker.matched -and !$missingMarker.markerMatched -and $missingMarker.reasonMatched) 'Failure reason alone replaced the required marker.'
$wrapped=Get-OverlayFailureWitness "VI_PARENT_FAIL:receipt`nRollback verification or explicit diagnostic error`nreceipt missing." 'VI_PARENT_FAIL:receipt' 'diagnostic error receipt missing'
Check $wrapped.matched 'Whitespace normalization changed the existing witness contract.'
$checks.Add('witness-mismatch-and-missing-components-reject')
@{status='passed';scope='pure-functions-only-no-registry-or-child-launch';checks=@($checks)}|ConvertTo-Json -Compress
