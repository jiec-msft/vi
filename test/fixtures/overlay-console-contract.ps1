param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference='Stop'
foreach($entry in @(
    @{file='overlay-ci-console.ps1';names=@('Assert-OverlayConsoleProbeExit','Complete-OverlayConsoleProbe','Wait-OverlayConsoleProbeRelease','Read-ProcessStarts','Wait-OverlayConsoleProbeReady','Assert-OverlayConsoleProbeStart')},
    @{file='overlay-ci-attribution.ps1';names=@('Identity-Key')},
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
$eventType=[Threading.EventWaitHandle]
Check ($null -ne $eventType.GetConstructor([type[]]@([bool],[Threading.EventResetMode],[string],[bool].MakeByRefType()))) 'Completion event created-new constructor is unavailable.'
Check ($eventType.GetMethod('OpenExisting',[type[]]@([string])).ReturnType -eq $eventType) 'Child completion event opener is unavailable.'
Check ($eventType.GetMethod('Set',[type[]]@()).ReturnType -eq [bool] -and $eventType.GetMethod('WaitOne',[type[]]@([int])).ReturnType -eq [bool]) 'Completion event signal or bounded-wait API changed.'
$checks.Add('native-completion-api-contract')
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
foreach($mode in @('unverified','start-unverified','signal-false','signal-error','zero','nonzero','timeout')){
    $gate=[pscustomobject]@{mode=$mode;requested=$false;requests=0;waits=0;budget=$null;
        failure=[IO.IOException]::new('Controlled completion signal failure.');events=[Collections.Generic.List[string]]::new()}
    $release=[pscustomobject]@{gate=$gate}
    $release|Add-Member ScriptMethod Set {
        $this.gate.requests++;$this.gate.events.Add('request')
        if($this.gate.mode -eq 'signal-error'){throw $this.gate.failure}
        if($this.gate.mode -eq 'signal-false'){return $false}
        $this.gate.requested=$true
        return $true
    }
    $probe=[pscustomobject]@{gate=$gate}
    $probe|Add-Member ScriptMethod WaitForExit {
        param($budget)
        $this.gate.waits++;$this.gate.budget=$budget;$this.gate.events.Add('wait')
        if(!$this.gate.requested){throw 'Completion wait preceded its release request.'}
        return $this.gate.mode -ne 'timeout'
    }
    $probe|Add-Member ScriptMethod get_ExitCode {
        $this.gate.events.Add('exit-code')
        if($this.gate.mode -eq 'nonzero'){return 7}
        return 0
    }
    $report=@{probeProcess=@{identityVerified=$mode -ne 'unverified';startReceipt=@{verified=$mode -ne 'start-unverified'}}}
    $caught=$null
    try{Complete-OverlayConsoleProbe $probe $release $report}catch{$caught=$_.Exception}
    if($mode -in @('unverified','start-unverified')){
        Check ($caught -and $gate.requests -eq 0 -and $gate.waits -eq 0 -and !$report.probeProcess.exitRequested) 'Unverified identity was allowed to end the probe.'
        if($mode -eq 'start-unverified'){Check ($report.probeProcess.exitRequestOutcome -eq 'start-unverified') 'Missing authoritative start receipt did not block release.'}
    }elseif($mode -in @('signal-false','signal-error')){
        Check ($caught -and $gate.requests -eq 1 -and $gate.waits -eq 0 -and !$report.probeProcess.exitRequested -and $report.probeProcess.exitRequestOutcome -eq 'signal-error') 'Failed release signal was accepted or entered the exit wait.'
        if($mode -eq 'signal-error'){
            $leaf=$caught;while($leaf.InnerException){$leaf=$leaf.InnerException}
            Check ([Object]::ReferenceEquals($leaf,$gate.failure)) 'Completion signal failure identity was replaced.'
        }
    }else{
        Check ($gate.requests -eq 1 -and $gate.waits -eq 1 -and $gate.budget -eq 5000 -and $report.probeProcess.exitRequested -and $gate.events[0] -eq 'request' -and $gate.events[1] -eq 'wait') 'Owned completion did not request release before its unchanged exit wait.'
        if($mode -eq 'zero'){Check (!$caught -and $report.probeProcess.exitWait.outcome -eq 'exited-zero') 'Released probe clean exit was rejected.'}
        elseif($mode -eq 'nonzero'){Check ($caught -and $report.probeProcess.exitWait.exitCode -eq 7) 'Release fabricated a zero exit.'}
        else{Check ($caught -and !$report.probeProcess.exitWait.waitCompleted -and $null -eq $report.probeProcess.exitWait.exitCode) 'Release concealed an actual exit timeout.'}
    }
    $checks.Add("completion-$mode")
}
$sourceText=[IO.File]::ReadAllText((Join-Path $Source 'overlay-ci-console.ps1'))
$hostCheck=$sourceText.IndexOf('Owned console host birth/session/parent identity could not be verified.')
$verified=$sourceText.IndexOf('$report.probeProcess.identityVerified = $true')
$startGuard=$sourceText.IndexOf('    Assert-OverlayConsoleProbeStart $probe $report $clientIdentity')
$complete=$sourceText.IndexOf('    Complete-OverlayConsoleProbe $probe $probeRelease $report')
Check ($hostCheck -ge 0 -and $verified -gt $hostCheck -and $startGuard -gt $verified -and $complete -gt $startGuard) 'Completion request moved before the live identity and authoritative start guards.'
$start=$sourceText.IndexOf("    `$probeScript = @'")
$end=$sourceText.IndexOf('    $probeStarted =',$start)
Check ($start -ge 0 -and $end -gt $start) 'Owned child script builder was not identified.'
$builder=$sourceText.Substring($start,$end-$start)
$probeFile='owned-synthetic-probe.json';$releaseName='Local\owned-synthetic-event'
. ([scriptblock]::Create($builder))
$tokens=$null;$errors=$null
$childAst=[Management.Automation.Language.Parser]::ParseInput($probeScript,[ref]$tokens,[ref]$errors)
Check (!$errors.Count -and $probeScript.Contains('OpenExisting') -and $probeScript.Contains('$release.Dispose()') -and !$probeScript.Contains('Start-Sleep -Seconds 5')) 'Generated child completion protocol was malformed or retained fixed padding.'
$childWait=@($childAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-OverlayConsoleProbeRelease'},$true))
Check ($childWait.Count -eq 1) 'Generated child did not contain the actual shared lease wait.'
. ([scriptblock]::Create($childWait[0].Extent.Text))
$checks.Add('generated-child-uses-shared-release-protocol')
foreach($mode in @('released','expired','error')){
    $release=[pscustomobject]@{mode=$mode;budget=$null;calls=0;failure=[IO.IOException]::new('Controlled lease wait failure.')}
    $release|Add-Member ScriptMethod WaitOne {
        param($budget)
        $this.budget=$budget;$this.calls++
        if($this.mode -eq 'error'){throw $this.failure}
        return $this.mode -eq 'released'
    }
    $caught=$null
    try{Wait-OverlayConsoleProbeRelease $release}catch{$caught=$_.Exception}
    Check ($release.budget -eq 5000 -and $release.calls -eq 1) 'Child release lease was extended or retried.'
    Check (($mode -eq 'released') -eq ($null -eq $caught)) 'Missing child completion request was accepted.'
    if($mode -eq 'error'){
        $leaf=$caught;while($leaf.InnerException){$leaf=$leaf.InnerException}
        Check ([Object]::ReferenceEquals($leaf,$release.failure)) 'Child lease failure identity was replaced.'
    }
    $checks.Add("lease-$mode")
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
function New-ControlledStartEvent($Identifier,[int]$Number){
    return @{SourceIdentifier=$Identifier;SourceEventArgs=@{NewEvent=@{
        ProcessID=$Number;ParentProcessID=7;ProcessName='powershell.exe';SessionID=2;
        TIME_CREATED=[DateTime]::UtcNow.AddSeconds(-1).ToFileTimeUtc()
    }}}
}
function Test-Path {
    param($LiteralPath)
    if($script:timeline.mode -eq 'trace-before-file'){return $script:timeline.tick -gt 0}
    return $true
}
function Get-Event {
    $script:timeline.reads++
    switch($script:timeline.mode){
        'reader-error' {throw $script:timeline.failure}
        'no-event-timeout' {return}
        'trace-before-file' {return New-ControlledStartEvent 'owned-watch' 51}
        'file-before-trace' {if(!$script:timeline.tick){return}}
        'unrelated-then-owned' {if(!$script:timeline.tick){return New-ControlledStartEvent 'owned-watch' 52}}
        'wrong-source-then-owned' {if(!$script:timeline.tick){return New-ControlledStartEvent 'unrelated-watch' 51}}
        'exits-during-read' {$script:timeline.probe.HasExited=$true}
    }
    return New-ControlledStartEvent 'owned-watch' 51
}
function Start-Sleep {
    param([int]$Milliseconds)
    Check ($Milliseconds -eq 100) 'The existing readiness poll interval changed.'
    $script:timeline.tick++
}
try{
    foreach($mode in @('trace-before-file','file-before-trace','unrelated-then-owned','wrong-source-then-owned','no-event-timeout','exited','exits-during-read','deadline','reader-error')){
        $script:timeline=@{mode=$mode;tick=0;reads=0;failure=[IO.IOException]::new('Controlled start collection failure.')}
        $probe=[pscustomobject]@{Id=51;HasExited=$mode -eq 'exited'}
        $script:timeline.probe=$probe
        $report=@{probeProcess=@{}}
        $deadline=[DateTime]::UtcNow.AddSeconds(1)
        if($mode -eq 'no-event-timeout'){$deadline=[DateTime]::UtcNow.AddMilliseconds(30)}
        if($mode -eq 'deadline'){$deadline=[DateTime]::UtcNow.AddSeconds(-1)}
        $caught=$null
        try{Wait-OverlayConsoleProbeReady $probe $report 'owned-receipt.json' 'owned-watch' @() $deadline}catch{$caught=$_.Exception}
        if($mode -eq 'reader-error'){
            Check ($caught -and !$report.probeProcess.readiness.startObserved) 'Failed event collection became readiness.'
            $leaf=$caught;while($leaf.InnerException){$leaf=$leaf.InnerException}
            Check ([Object]::ReferenceEquals($leaf,$script:timeline.failure)) 'Start collection failure identity was replaced.'
        }elseif($mode -in @('no-event-timeout','exited','exits-during-read','deadline')){
            Check ($null -ne $caught) 'Missing, expired or exited start observation was accepted.'
            if($mode -eq 'no-event-timeout'){Check ($caught.Message -like '*process-start receipt missing*' -and $script:timeline.reads -gt 0) 'No-event deadline failed for the wrong reason.'}
            elseif($mode -eq 'exits-during-read'){Check ($report.probeProcess.readiness.startObserved -and $probe.HasExited) 'Exit after receipt collection bypassed its live check.'}
            else{Check ($script:timeline.reads -eq 0) 'Readiness read events after its process exit or deadline.'}
        }else{
            Check (!$caught -and $report.probeProcess.readiness.readinessFile -and $report.probeProcess.readiness.startObserved) 'Joint file/start readiness was not acknowledged.'
            Check ($script:timeline.reads -ge 2 -and $script:timeline.tick -eq 1) 'Unrelated or delayed events bypassed the existing readiness loop.'
            Check (@($report.processStarts.starts|Where-Object {$_.pid -eq 51}).Count -eq 1) 'The actual source-filtered start record was lost.'
        }
        $checks.Add("readiness-$mode")
    }
}finally{
    Remove-Item Function:\Test-Path,Function:\Get-Event,Function:\Start-Sleep
}
foreach($mode in @('before-cim','after-cim','missing','duplicate','wrong-pid','wrong-parent','wrong-session','wrong-exe','stale-birth','future-time','exited','unverified')){
    $birth=[DateTime]::UtcNow.AddSeconds(-5)
    $client=@{pid=51;parentPid=7;session=2;exe='powershell.exe';createdAt=$birth.ToString('o');observedAt=$birth.AddMilliseconds(20).ToString('o')}
    $start=@{pid=51;parentPid=7;session=2;exe='powershell.exe';observedAt=$birth.AddMilliseconds(10).ToString('o')}
    switch($mode){
        'after-cim' {$start.observedAt=$birth.AddMilliseconds(30).ToString('o')}
        'wrong-pid' {$start.pid=52}
        'wrong-parent' {$start.parentPid=8}
        'wrong-session' {$start.session=3}
        'wrong-exe' {$start.exe='unrelated.exe'}
        'stale-birth' {$start.observedAt=$birth.AddTicks(-1).ToString('o')}
        'future-time' {$start.observedAt=[DateTime]::UtcNow.AddSeconds(10).ToString('o')}
    }
    $starts=@($start)
    if($mode -eq 'missing'){$starts=@()}
    if($mode -eq 'duplicate'){$starts=@($start,$start)}
    $probe=[pscustomobject]@{Id=51;HasExited=$mode -eq 'exited'}
    $report=@{probeProcess=@{identityVerified=$mode -ne 'unverified'};processStarts=@{starts=$starts}}
    $caught=$null
    try{Assert-OverlayConsoleProbeStart $probe $report $client}catch{$caught=$_.Exception}
    if($mode -in @('before-cim','after-cim')){
        Check (!$caught -and $report.probeProcess.startReceipt.verified -and $report.probeProcess.startReceipt.observedAt -eq $start.observedAt) 'Valid event/live-CIM generation proof was lost.'
    }else{
        Check ($caught -and !$report.probeProcess.startReceipt.verified) 'A missing, ambiguous or conflicting start generation became proof.'
    }
    $checks.Add("start-generation-$mode")
}
$tokens=$null;$errors=$null
$sourceAst=[Management.Automation.Language.Parser]::ParseInput($sourceText,[ref]$tokens,[ref]$errors)
$cleanupBlocks=@($sourceAst.FindAll({param($node) $node -is [Management.Automation.Language.TryStatementAst] -and
    $node.Finally -and $node.Finally.Extent.Text.Contains('Owned process-start subscription cleanup failed:')},$true))
Check ($cleanupBlocks.Count -eq 1) 'Actual console cleanup block was not uniquely identified.'
$cleanupText=$cleanupBlocks[0].Finally.Extent.Text
$script:cleanupAttempts=[Collections.Generic.List[string]]::new()
$probe=[pscustomobject]@{Id=51;HasExited=$true}
$probe|Add-Member ScriptMethod Dispose {$script:cleanupAttempts.Add('probe');throw 'Controlled probe dispose failure.'}
$probeRelease=[pscustomobject]@{}
$probeRelease|Add-Member ScriptMethod Dispose {$script:cleanupAttempts.Add('release');throw 'Controlled release dispose failure.'}
$watchId='owned-watch';$baselineInventory=@();$report=@{}
$prepareFailure='Controlled primary start-receipt failure.'
function Read-ProcessStarts {$script:cleanupAttempts.Add('trace');throw 'Controlled final trace failure.'}
function Unregister-Event {$script:cleanupAttempts.Add('unregister')}
function Get-Event {}
function Remove-Event {}
function Save-Report {$script:cleanupAttempts.Add('save');throw 'Controlled final persistence failure.'}
function Stop-Process {throw 'Pure cleanup must not stop a real process.'}
$caught=$null
try{
    . ([scriptblock]::Create($cleanupText.Substring(1,$cleanupText.Length-2)))
}catch{$caught=$_.Exception}
finally{Remove-Item Function:\Read-ProcessStarts,Function:\Unregister-Event,Function:\Get-Event,Function:\Remove-Event,Function:\Save-Report,Function:\Stop-Process}
Check ($caught -and ($script:cleanupAttempts -join ',') -eq 'probe,release,trace,unregister,save') 'Cleanup did not attempt each mandatory operation after primary and secondary failures.'
foreach($message in @($prepareFailure,'Controlled probe dispose failure.','Controlled release dispose failure.','Controlled final trace failure.','Controlled final persistence failure.')){
    Check ($caught.Message.Contains($message)) 'Cleanup replaced the primary or a secondary failure.'
}
$checks.Add('actual-finally-preserves-primary-and-each-cleanup-failure')
@{status='passed';scope='pure-functions-only-no-registry-or-child-launch';checks=@($checks)}|ConvertTo-Json -Compress
