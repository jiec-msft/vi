function Get-ClipboardExceptionLeaves([Exception]$Exception){
    if($null -eq $Exception){throw [ArgumentNullException]::new('Exception')}
    $pending=[Collections.Generic.Stack[Exception]]::new()
    $leaves=[Collections.Generic.List[Exception]]::new()
    $pending.Push($Exception)
    $truncated=$false
    $visited=0
    while($pending.Count -gt 0 -and $visited -lt 32){
        $current=$pending.Pop()
        $visited++
        if($current -is [AggregateException]){
            $take=[Math]::Min($current.InnerExceptions.Count,32-$pending.Count)
            if($take -lt $current.InnerExceptions.Count){$truncated=$true}
            for($i=$take-1;$i -ge 0;$i--){$pending.Push($current.InnerExceptions[$i])}
        }elseif($current -is [ViClipboard.ClipboardPreparationException]){
            # Retain original exceptions in memory, but project only this typed scalar boundary.
            if($leaves.Count -lt 2){$leaves.Add($current)}else{$truncated=$true}
        }elseif($current.InnerException){
            $pending.Push($current.InnerException)
        }elseif($leaves.Count -lt 2){
            $leaves.Add($current)
        }else{
            $truncated=$true
        }
    }
    if($pending.Count -gt 0){$truncated=$true}
    [pscustomobject]@{leaves=$leaves.ToArray();truncated=$truncated}
}
function ConvertTo-ClipboardFailure([Exception]$Exception){
    $description=Get-ClipboardExceptionLeaves $Exception
    $causes=[Collections.Generic.List[object]]::new()
    $codes=@('native-error','window-order','target-changed','secure-field','no-input','clipboard-changed','clipboard-unavailable',
        'clipboard-busy','clipboard-format','clipboard-snapshot-failed','modifiers-held','composition-active','paste-unconfirmed','restore-failed')
    $stages=@('unspecified','restore-open','restore-sequence','restore-copy','restore-empty','restore-write','restore-text','restore-close',
        'publication-open','publication-close','publication-owner','publication-sequence','publication-state','publication-write',
        'snapshot-format','snapshot-format-name','snapshot-copy','snapshot-release')
    foreach($leaf in $description.leaves){
        $code='native-error'
        $stage='unspecified'
        $format=0
        $nativeError=0
        if($leaf -is [ViClipboard.ClipboardPreparationException]){
            if($leaf.Code -in $codes){$code=$leaf.Code}
            if($leaf.Stage -in $stages){$stage=$leaf.Stage}
            if($leaf.Format -le 65535){$format=$leaf.Format}
            if($leaf.NativeCode -ge 0){$nativeError=$leaf.NativeCode}
        }else{
            if($leaf.Message -in $codes){$code=$leaf.Message}
            if($leaf -is [ComponentModel.Win32Exception] -and $leaf.NativeErrorCode -ge 0){$nativeError=$leaf.NativeErrorCode}
        }
        $causes.Add(@{code=$code;stage=$stage;format=$format;errorNumber=$nativeError})
    }
    if($causes.Count -eq 0){
        $causes.Add(@{code='native-error';stage='unspecified';format=0;errorNumber=0})
    }
    [pscustomobject]@{causes=$causes.ToArray();truncated=$description.truncated}
}
