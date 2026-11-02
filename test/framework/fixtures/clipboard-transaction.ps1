param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Owned clipboard transactions require an isolated GitHub-hosted Windows runner.'
}
[Console]::Error.WriteLine("VI_CLIP_STAGE engine $PID $([IntPtr]::Size) $($PSVersionTable.PSVersion.Major)")
. ([IO.Path]::Combine($Source, 'windows-bootstrap.ps1'))
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
[Console]::Error.WriteLine('VI_CLIP_STAGE forms-ready')
$file=[IO.File]::ReadAllText((Join-Path $Source 'windows-delivery.ps1'))
$match=[regex]::Match($file,"(?s)\`$clipboardSource=@'\r?\n(.*?)\r?\n'@")
if(-not $match.Success){throw 'Actual clipboard transaction source was not found.'}
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition (
    $match.Groups[1].Value+[IO.File]::ReadAllText((Join-Path $Source 'windows-clipboard-snapshot.cs')))
. ([IO.Path]::Combine($Source, 'windows-clipboard-errors.ps1'))
[Console]::Error.WriteLine('VI_CLIP_STAGE transaction-compiled')
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class OwnedClipboardFixture : NativeWindow, IDisposable {
 readonly List<IntPtr> privateMemory=new List<IntPtr>();
 public static Func<uint,IntPtr,IntPtr> RealSetter;
 public static Func<uint,IntPtr,IntPtr> RealCompletionSetter;
 public static Func<bool> RealRestoreClose;
 public static int CompletionAttempts, CompletionWrites, RestoreCloseMode;
 public static readonly List<uint> CompletionFormats=new List<uint>();
 public static bool CompletionFails, NativeRestoreClosed;
 public static IntPtr RestoreWindow;
 public static int FailAfter=-1, Writes;
 public static OwnedClipboardFixture PublicationFixture;
 public static uint PublicationFormat;
 public static int PublicationMutation;
 public static Func<uint,IntPtr> RealPublicationRead;
 public static Func<bool> RealSealClose;
 public static int ProbeMode, FinalSealMode, CopyFailureStage, CopyFreeCount, CopyReleaseMode, NameFailureError;
 public static uint NameFailureFormat;
 public static IntPtr ProbeWindow, FailedCopy;
 public static Func<IntPtr,IntPtr> RealCopyRelease;
 public static Func<uint,System.Text.StringBuilder,int,int> RealFormatNameRead;
 public static Exception CopyPrimaryFailure, CopyReleaseFailure;
 public static bool CopyUnlocked, CopyFreed, CopyIdentity, ManagedFailureClosed, NativeNameFailure;
 public static int FailRegisteredName(uint format,System.Text.StringBuilder name,int length){
  if(format!=NameFailureFormat)return RealFormatNameRead(format,name,length);
  int count=RealFormatNameRead(13,name,length);
  NameFailureError=Marshal.GetLastWin32Error();NativeNameFailure=count==0;return count;
 }
 public static void RenderFormat(IntPtr window,uint format){SendMessage(window,0x305,new IntPtr((long)format),IntPtr.Zero);}
 public static void StaleProbe(IntPtr window){RenderFormat(window,13);}
 public static IntPtr ControlledProbe(uint format){
  if(ProbeMode==4&&format==13)return RealPublicationRead(format);
  if(ProbeMode==2)RenderFormat(ProbeWindow,7);
  if(ProbeMode==3)RenderAll(ProbeWindow);
  if(ProbeMode==4)RenderFormat(ProbeWindow,1);
  if(ProbeMode==5){RenderFormat(ProbeWindow,13);SetLastError(0);return new IntPtr(1);}
  SetLastError(0);return IntPtr.Zero;
 }
 public static void SealRenderBoundary(IntPtr window){RenderFormat(window,13);RenderAll(window);}
 public static bool RenderDuringSealClose(){
  SealRenderBoundary(ProbeWindow);
  bool result=RealSealClose();
  if(FinalSealMode==3)PublicationFixture.Put(new uint[]{13},new byte[][]{System.Text.Encoding.Unicode.GetBytes("New copy during readonly close\0")});
  SealRenderBoundary(ProbeWindow);return result;
 }
 public static void BeforeSealCommit(IntPtr window){
  SealRenderBoundary(window);
  if(FinalSealMode==1)PublicationFixture.Put(new uint[]{13},new byte[][]{System.Text.Encoding.Unicode.GetBytes("New copy before seal commit\0")});
  if(FinalSealMode==2)PublicationFixture.AddWhileOwned(window,PublicationFormat,new byte[]{7,6,5});
 }
 public static bool ControlledSealCloseFailure(){
  ManagedFailureClosed=RealSealClose();
  if(!ManagedFailureClosed)throw new InvalidOperationException("Actual owned seal close failed.");
  throw new InvalidOperationException("Controlled managed close-boundary failure.");
 }
 public static void CopyCheckpoint(IntPtr copy,int stage){
  if(stage!=CopyFailureStage)return;
  FailedCopy=copy;CopyPrimaryFailure=new InvalidOperationException("Controlled copy failure.");throw CopyPrimaryFailure;
 }
 public static IntPtr ObserveCopyRelease(IntPtr copy){
  CopyFreeCount++;CopyIdentity=copy==FailedCopy;CopyUnlocked=(GlobalFlags(copy)&255)==0;
  IntPtr result=RealCopyRelease(copy);CopyFreed=result==IntPtr.Zero;
  if(CopyFreed&&CopyReleaseMode==1){
   CopyReleaseFailure=new InvalidOperationException("Controlled release failure after successful native free.");
   throw CopyReleaseFailure;
  }
  // Return a controlled failure status only; the freed handle is never dereferenced or freed again.
  if(CopyFreed&&CopyReleaseMode==2){SetControlledStatusError(0);return copy;}
  return result;
 }
 public static void MutatePublication(IntPtr owner){
  if(PublicationMutation==3)PublicationFixture.Put(new uint[]{13},new byte[][]{System.Text.Encoding.Unicode.GetBytes("New copy during seal\0")});
  else if(PublicationMutation==1)PublicationFixture.AddWhileOwned(owner,13,System.Text.Encoding.Unicode.GetBytes("Unknown text during seal\0"));
  else if(PublicationMutation==2)PublicationFixture.AddWhileOwned(owner,RegisterClipboardFormat("VI.NativeDelivery.Transaction"),new byte[16]);
  else PublicationFixture.AddWhileOwned(owner,PublicationFormat,new byte[]{9,8,7});
 }
 static int caseId;
 public static int CaseId {
  get{return caseId;}
  set{caseId=value;Console.Error.WriteLine("VI_CLIP_STAGE case "+value);}
 }
 public static IntPtr RestoreSetter(uint format,IntPtr data){
  if(Writes==FailAfter)throw new InvalidOperationException("Controlled restore setter failure.");
  IntPtr result=RealSetter(format,data);if(result!=IntPtr.Zero)Writes++;return result;
 }
 public static IntPtr CompletionSetter(uint format,IntPtr data){
  CompletionAttempts++;
  if(CompletionFails){SetControlledStatusError(0);return IntPtr.Zero;}
  IntPtr result=RealCompletionSetter(format,data);
  if(result!=IntPtr.Zero){CompletionWrites++;CompletionFormats.Add(format);}
  return result;
 }
 public static bool RestoreCloseBoundary(){
  NativeRestoreClosed=RealRestoreClose();
  if(!NativeRestoreClosed)return false;
  if(RestoreCloseMode==6){SetControlledStatusError(0);return false;}
  if(RestoreCloseMode==5)PublicationFixture.Put(new uint[]{13},new byte[][]{System.Text.Encoding.Unicode.GetBytes("New copy during restore close\0")});
  else if(RestoreCloseMode==1)PublicationFixture.AddWhileOwned(RestoreWindow,PublicationFormat,new byte[]{9,8,7});
  else if(RestoreCloseMode==2)PublicationFixture.AddWhileOwned(RestoreWindow,13,System.Text.Encoding.Unicode.GetBytes("Unknown text during restore close\0"));
  else if(RestoreCloseMode==3)PublicationFixture.AddWhileOwned(RestoreWindow,16,BitConverter.GetBytes((uint)1041));
  else if(RestoreCloseMode==4)PublicationFixture.AddWhileOwned(RestoreWindow,RegisterClipboardFormat("VI.NativeDelivery.Transaction"),new byte[16]);
  return true;
 }
 [DllImport("user32.dll",SetLastError=true)]static extern bool OpenClipboard(IntPtr owner);
 [DllImport("user32.dll")]static extern bool CloseClipboard();
 [DllImport("user32.dll",SetLastError=true)]static extern bool EmptyClipboard();
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SetClipboardData(uint format,IntPtr data);
 [DllImport("user32.dll")]static extern IntPtr GetClipboardData(uint format);
 [DllImport("user32.dll")]public static extern bool IsClipboardFormatAvailable(uint format);
 [DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
 public static void RenderAll(IntPtr window){SendMessage(window,0x306,IntPtr.Zero,IntPtr.Zero);}
 [DllImport("user32.dll")]public static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll")]public static extern IntPtr GetClipboardOwner();
 [DllImport("user32.dll")]public static extern IntPtr GetKeyboardLayout(uint thread);
 [DllImport("user32.dll")]public static extern int CountClipboardFormats();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern uint RegisterClipboardFormat(string name);
 [DllImport("kernel32.dll")]static extern void SetLastError(uint error);
 [DllImport("kernel32.dll",EntryPoint="SetLastError",SetLastError=true)]static extern void SetControlledStatusError(uint error);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr GlobalAlloc(uint flags,UIntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr GlobalLock(IntPtr data);
 [DllImport("kernel32.dll")]static extern uint GlobalFlags(IntPtr data);
 [DllImport("kernel32.dll")]static extern bool GlobalUnlock(IntPtr data);
 [DllImport("kernel32.dll")]static extern UIntPtr GlobalSize(IntPtr data);
 [DllImport("kernel32.dll")]static extern IntPtr GlobalFree(IntPtr data);
 public OwnedClipboardFixture(){CreateHandle(new CreateParams{Parent=new IntPtr(-3)});}
 static Exception Failure(string stage,uint format,int bytes,int error){
  return new Exception("Owned fixture failure: case="+CaseId+", stage="+stage+
   ", format="+format+", bytes="+bytes+", nativeError="+error+".");
 }
 public sealed class ZeroContract {
  public uint Format, Flags;
  public ulong Bytes;
  public bool SetSucceeded;
  public int NativeError;
 }
 public ZeroContract ProbeZero(uint format){
  if(format<0xc000)throw new Exception("Owned registered format was not created.");
  if(!OpenClipboard(Handle))throw Failure("zero-open",format,0,Marshal.GetLastWin32Error());
  IntPtr memory=IntPtr.Zero;
  try{
   if(!EmptyClipboard())throw Failure("zero-empty",format,0,Marshal.GetLastWin32Error());
   memory=GlobalAlloc(0x42,UIntPtr.Zero);
   if(memory==IntPtr.Zero)throw Failure("zero-allocate",format,0,Marshal.GetLastWin32Error());
   var result=new ZeroContract{Format=format,Flags=GlobalFlags(memory),Bytes=GlobalSize(memory).ToUInt64()};
   SetLastError(0);
   IntPtr written=SetClipboardData(format,memory);
   result.NativeError=Marshal.GetLastWin32Error();
   result.SetSucceeded=written!=IntPtr.Zero;
   if(result.SetSucceeded)memory=IntPtr.Zero;
   Console.Error.WriteLine("Owned zero allocation contract: case="+CaseId+", format="+format+
    ", bytes="+result.Bytes+", flags="+result.Flags+", setSucceeded="+result.SetSucceeded+
    ", nativeError="+result.NativeError+".");
   return result;
  }finally{if(memory!=IntPtr.Zero)GlobalFree(memory);CloseClipboard();}
 }
 public void AdvertiseUnrenderable(uint format){
  Put(new uint[0],new byte[0][]);
  if(!OpenClipboard(Handle))throw Failure("delayed-open",format,0,Marshal.GetLastWin32Error());
  try{
   SetLastError(0);SetClipboardData(format,IntPtr.Zero);
   int error=Marshal.GetLastWin32Error();
   if(error!=0)throw Failure("delayed-advertise",format,0,error);
   if(!IsClipboardFormatAvailable(format))throw new Exception("Owned delayed format was not advertised.");
  }finally{CloseClipboard();}
 }
 public void Put(uint[] formats,byte[][] payloads){
  if(formats==null)throw new ArgumentNullException("formats");
  if(payloads==null)throw new ArgumentNullException("payloads");
  if(formats.Length!=payloads.Length)throw new ArgumentException("Owned payload count must match format count.","payloads");
  for(int i=0;i<payloads.Length;i++){
   byte[] bytes=payloads[i];
   if(bytes==null)throw new ArgumentException("Owned payload must be a byte array.","payloads");
   if(formats[i]==13&&(bytes.Length<2||bytes.Length%2!=0||bytes[bytes.Length-2]!=0||bytes[bytes.Length-1]!=0))
    throw new ArgumentException("Owned Unicode payload must contain complete null-terminated UTF-16 bytes.","payloads");
  }
  if(!OpenClipboard(Handle))throw Failure("open",0,0,Marshal.GetLastWin32Error());
  try{
   if(!EmptyClipboard())throw Failure("empty",0,0,Marshal.GetLastWin32Error());
   foreach(var memory in privateMemory)GlobalFree(memory);privateMemory.Clear();
   for(int i=0;i<formats.Length;i++){
    IntPtr memory=GlobalAlloc(0x42,new UIntPtr((uint)payloads[i].Length));
    if(memory==IntPtr.Zero)throw Failure("allocate",formats[i],payloads[i].Length,Marshal.GetLastWin32Error());
    if(payloads[i].Length>0){
     IntPtr pointer=GlobalLock(memory);
     if(pointer==IntPtr.Zero){int error=Marshal.GetLastWin32Error();GlobalFree(memory);throw Failure("lock",formats[i],payloads[i].Length,error);}
     try{Marshal.Copy(payloads[i],0,pointer,payloads[i].Length);}finally{GlobalUnlock(memory);}
    }
    SetLastError(0);
    IntPtr written=SetClipboardData(formats[i],memory);
    int nativeError=Marshal.GetLastWin32Error();
    if(written==IntPtr.Zero){GlobalFree(memory);throw Failure("set-data",formats[i],payloads[i].Length,nativeError);}
    if(formats[i]>=0x200&&formats[i]<=0x2ff)privateMemory.Add(memory);
   }
  }finally{CloseClipboard();}
 }
 public byte[] Read(uint format){
  if(!OpenClipboard(Handle))throw new Exception("Owned fixture read lock failed.");
  try{
   IntPtr memory=GetClipboardData(format);
   if(memory==IntPtr.Zero)throw new Exception("Owned fixture format missing.");
   int length=(int)GlobalSize(memory).ToUInt64();
   var bytes=new byte[length];
   if(length>0){
    IntPtr pointer=GlobalLock(memory);if(pointer==IntPtr.Zero)throw new Exception("Owned fixture read failed.");
    try{Marshal.Copy(pointer,bytes,0,length);}finally{GlobalUnlock(memory);}
   }return bytes;
  }finally{CloseClipboard();}
 }
 public void AddWhileOwned(IntPtr owner,uint format,byte[] bytes){
  if(!OpenClipboard(owner))throw Failure("mutate-open",format,bytes.Length,Marshal.GetLastWin32Error());
  IntPtr memory=IntPtr.Zero;
  try{
   memory=GlobalAlloc(0x42,new UIntPtr((uint)bytes.Length));
   if(memory==IntPtr.Zero)throw Failure("mutate-allocate",format,bytes.Length,Marshal.GetLastWin32Error());
   IntPtr pointer=GlobalLock(memory);
   if(pointer==IntPtr.Zero)throw Failure("mutate-lock",format,bytes.Length,Marshal.GetLastWin32Error());
   try{Marshal.Copy(bytes,0,pointer,bytes.Length);}finally{GlobalUnlock(memory);}
   SetLastError(0);
   IntPtr written=SetClipboardData(format,memory);
   int error=Marshal.GetLastWin32Error();
   if(written==IntPtr.Zero)throw Failure("mutate-set",format,bytes.Length,error);
   memory=IntPtr.Zero;
  }finally{if(memory!=IntPtr.Zero)GlobalFree(memory);CloseClipboard();}
 }
 public int LockCount(uint format){
  if(!OpenClipboard(Handle))throw new Exception("Owned lock-count read failed.");
  try{
   IntPtr memory=GetClipboardData(format);
   if(memory==IntPtr.Zero)throw new Exception("Owned lock-count format missing.");
   return (int)(GlobalFlags(memory)&255);
  }finally{CloseClipboard();}
 }
 public void Hold(int milliseconds){
  var started=new ManualResetEventSlim(false);Exception failure=null;
  var worker=new Thread(()=>{
   if(!OpenClipboard(IntPtr.Zero)){failure=new Exception("Owned lock holder failed.");started.Set();return;}
   started.Set();try{Thread.Sleep(milliseconds);}finally{CloseClipboard();}
  });
  worker.IsBackground=true;worker.Start();
  if(!started.Wait(2000)||failure!=null)throw new Exception("Owned lock holder did not start.");
 }
 public void Dispose(){Put(new uint[0],new byte[0][]);DestroyHandle();}
}
'@
[Console]::Error.WriteLine('VI_CLIP_STAGE fixture-compiled')
function Check([bool]$Value,[string]$Message,
    [ValidateSet('none','partial-failure','partial-writes','partial-sequence','partial-locale','partial-text')][string]$CheckId='none'){
    if(-not $Value){
        $failure=[InvalidOperationException]::new($Message)
        $failure.Data['OwnedFixtureAssertion']=$true
        if($CheckId -ne 'none'){$failure.Data['OwnedFixtureCheck']=$CheckId}
        throw $failure
    }
}
function Fault-Code($Exception){
    $description=Get-ClipboardExceptionLeaves $Exception
    if(-not $description.truncated -and $description.leaves.Count -eq 1 -and $description.leaves[0] -is [ViClipboard.ClipboardPreparationException]){
        return $description.leaves[0].Code
    }
    throw $Exception
}
function Report-TransactionFault([string]$Phase,$Exception){
    $description=Get-ClipboardExceptionLeaves $Exception
    foreach($Exception in $description.leaves){
        if($Exception -is [ViClipboard.ClipboardPreparationException]){
            [Console]::Error.WriteLine("VI_CLIP_FAILURE $Phase case=$([OwnedClipboardFixture]::CaseId) code=$($Exception.Code) stage=$($Exception.Stage) format=$($Exception.Format) nativeError=$($Exception.NativeCode)")
            if($Exception.Stage -eq 'restore-sequence'){
                [Console]::Error.WriteLine("VI_CLIP_SEQUENCE expected=$($Exception.ExpectedSequence) current=$($Exception.CurrentSequence) ownerMatch=True")
            }
        }elseif($Exception.Data['OwnedFixtureAssertion'] -eq $true){
            $check=''
            if($Exception.Data['OwnedFixtureCheck'] -in @('partial-failure','partial-writes','partial-sequence','partial-locale','partial-text')){
                $check=" check=$($Exception.Data['OwnedFixtureCheck'])"
            }
            [Console]::Error.WriteLine("VI_CLIP_FAILURE $Phase case=$([OwnedClipboardFixture]::CaseId) code=fixture-assertion$check")
        }else{
            $class=$Exception.GetType().Name
            if($class -notin @('ExternalException','InvalidOperationException','ArgumentException','OutOfMemoryException','IOException','SystemException','Win32Exception','RuntimeException','Exception')){$class='Other'}
            $nativeError=0
            if($Exception -is [ComponentModel.Win32Exception]){$nativeError=$Exception.NativeErrorCode}
            [Console]::Error.WriteLine("VI_CLIP_FAILURE $Phase case=$([OwnedClipboardFixture]::CaseId) code=managed-operation errorClass=$class nativeError=$nativeError hresult=$($Exception.HResult)")
        }
    }
    if($description.truncated){[Console]::Error.WriteLine("VI_CLIP_CAUSES_TRUNCATED $Phase")}
}
function Report-TransactionState([ValidateSet('begin-return','text-read-return','restore-return','operation-failed','cleanup-failed')][string]$Phase,$Transaction){
    $flags=[Reflection.BindingFlags]'Instance,NonPublic'
    $type=[TranscriptClipboard]
    $expected=$type.GetField('sequence',$flags).GetValue($Transaction)
    $observed=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
    $ownerObserved=$Transaction.Handle -ne [IntPtr]::Zero -and [OwnedClipboardFixture]::GetClipboardOwner() -eq $Transaction.Handle
    $state="VI_CLIP_STATE $Phase case=$([OwnedClipboardFixture]::CaseId) expected=$expected observed=$observed ownerObserved=$ownerObserved"
    foreach($name in @('began','rendered','renderFailed','restoreMutated')){
        $state+=" $name=$($type.GetField($name,$flags).GetValue($Transaction))"
    }
    $state+=" renderAttempted=$($Transaction.RenderAttempted) renderExpectedSequence=$($Transaction.RenderExpectedSequence) renderObservedSequence=$($Transaction.RenderObservedSequence) renderWriteStarted=$($Transaction.RenderWriteStarted) renderWriteCompleted=$($Transaction.RenderWriteCompleted)"
    [Console]::Error.WriteLine($state)
}
function Report-OperationFailure($Transaction,$Exception){
    Report-TransactionFault 'operation' $Exception
    Report-TransactionState 'operation-failed' $Transaction
}
function Close-Transaction($Transaction,$OperationFailure,[scriptblock]$BeforeDispose){
    try{
        if($BeforeDispose){& $BeforeDispose}
        $Transaction.Dispose()
    }catch{
        $cleanupFailure=$_.Exception
        Report-TransactionFault 'cleanup' $cleanupFailure
        Report-TransactionState 'cleanup-failed' $Transaction
        if($OperationFailure){
            throw [AggregateException]::new('Owned transaction operation and cleanup both failed.',
                [Exception[]]@($OperationFailure,$cleanupFailure))
        }
        throw
    }
}
function Read-Mixed($Fixture,$Metadata,$Rich){
    return @{
        text=[Convert]::ToBase64String($Fixture.Read(13))
        metadata=[Convert]::ToBase64String($Fixture.Read($Metadata))
        rich=[Convert]::ToBase64String($Fixture.Read($Rich))
    }
}
$fixture=[OwnedClipboardFixture]::new()
$text=[Text.Encoding]::Unicode.GetBytes("Owned Unicode sample`0")
$html=[Text.Encoding]::UTF8.GetBytes('Owned synthetic HTML fragment')
$format=[OwnedClipboardFixture]::RegisterClipboardFormat('VI synthetic metadata')
$rich=[OwnedClipboardFixture]::RegisterClipboardFormat('HTML Format')
$checks=[Collections.Generic.List[string]]::new()
$fixtureFailure=$null
try{
    [OwnedClipboardFixture]::CaseId=1
    $fixture.Put([uint32[]]@(13,$format),[byte[][]]@($text,[byte[]]@(0)))
    Check ([Windows.Forms.Clipboard]::GetText() -eq 'Owned Unicode sample') 'Native publication positive control failed.'
    Check ($fixture.Read($format).Length -ge 1 -and $fixture.Read($format)[0] -eq 0) 'Backed zero-valued metadata positive control failed.'
    $zero=$fixture.ProbeZero($format)
    Check (($zero.Flags -band 0x4000) -ne 0 -and $zero.Bytes -eq 0) 'Zero allocation was not the documented discarded handle.'
    $zeroOutcome='native-publication-rejected'
    if($zero.SetSucceeded){
        $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{
            $failed=$false
            try{$transaction.Begin('Must not replace discarded data')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-format'}
            Check $failed 'Published discarded metadata was not rejected.'
            Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before) 'Discarded metadata rejection changed the clipboard.'
            Check ([OwnedClipboardFixture]::IsClipboardFormatAvailable($format)) 'Discarded metadata was removed.'
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure}
        $zeroOutcome='clipboard-format'
    }
    $checks.Add('zero-allocation-real-setclipboarddata-contract-recorded')
    [OwnedClipboardFixture]::CaseId=2
    $fixture.AdvertiseUnrenderable($format)
    $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $failed=$false
        try{$transaction.Begin('Must not replace unrenderable data')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-format'}
        Check $failed 'Unbacked delayed metadata was not rejected.'
        Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before) 'Unrenderable metadata rejection changed the clipboard.'
        Check ([OwnedClipboardFixture]::IsClipboardFormatAvailable($format)) 'Unrenderable metadata was removed.'
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure}
    $checks.Add('unbacked-metadata-fails-closed-without-mutation')
    foreach($empty in @($false,$true)){
        [OwnedClipboardFixture]::CaseId=3+[int]$empty
        if($empty){$fixture.Put([uint32[]]@(),[byte[][]]@())}
        else{
            $fixture.Put([uint32[]]@(13,$format,$rich),[byte[][]]@($text,[byte[]]@(0),$html))
            $expected=Read-Mixed $fixture $format $rich
        }
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{
            $transaction.Begin('Approved fixture result')
            [Console]::Error.WriteLine("VI_CLIP_PUBLICATION case=$([OwnedClipboardFixture]::CaseId) beforeClose=$($transaction.PublicationBeforeCloseSequence) closeSucceeded=$($transaction.PublicationCloseSucceeded) closeNativeError=$($transaction.PublicationCloseNativeError) afterClose=$($transaction.PublicationAfterCloseSequence) ownerObserved=$($transaction.PublicationOwnerObservedAfterClose) sealed=$($transaction.PublicationSealed) blockedRenderRequests=$($transaction.PublicationBlockedRenderRequests)")
            Check $transaction.PublicationCloseSucceeded 'Owned initial publication did not close the clipboard successfully.'
            Check $transaction.PublicationSealed 'Initial publication was not verified under the reacquired lock.'
            Check (-not $transaction.RenderAttempted) 'Sealing materialized the temporary transcript.'
            Report-TransactionState 'begin-return' $transaction
            $temporaryText=[Windows.Forms.Clipboard]::GetText()
            Report-TransactionState 'text-read-return' $transaction
            Check ($temporaryText -eq 'Approved fixture result') 'Delayed render did not expose the approved text.'
            $transaction.Restore()
            Report-TransactionState 'restore-return' $transaction
            if($empty){Check ([OwnedClipboardFixture]::CountClipboardFormats() -eq 0) 'Empty clipboard formats were not restored.'}
            else{
                $restored=Read-Mixed $fixture $format $rich
                Check ($restored.text -eq $expected.text) 'Unicode bytes changed.'
                Check ($restored.metadata -eq $expected.metadata) 'Zero-valued registered metadata bytes changed.'
                Check ($restored.rich -eq $expected.rich) 'Rich format bytes changed.'
            }
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure}
        if($empty){Check ([OwnedClipboardFixture]::CountClipboardFormats() -eq 0) 'Disposal reintroduced clipboard formats.'}
        else{Check ([Convert]::ToBase64String($fixture.Read(13)) -eq $expected.text) 'Disposal changed the restored Unicode bytes.'}
    }
    $checks.Add('empty-unicode-rich-zero-valued-metadata-native-roundtrip')
    [OwnedClipboardFixture]::CaseId=5
    foreach($renderFirst in @($false,$true)){
        $ole=[Windows.Forms.DataObject]::new()
        $ole.SetText('Owned OLE text',[Windows.Forms.TextDataFormat]::UnicodeText)
        $ole.SetData([Windows.Forms.DataFormats]::Rtf,$false,'{\rtf1 Owned OLE rich text}')
        $ole.SetData('HTML Format',$false,[IO.MemoryStream]::new($html))
        [Windows.Forms.Clipboard]::SetDataObject($ole,$true)
        $originalHtml=$null
        $originalLocale=$null
        if($renderFirst){
            $originalHtml=[Convert]::ToBase64String($fixture.Read($rich))
            if([OwnedClipboardFixture]::IsClipboardFormatAvailable(16)){
                $originalLocale=[Convert]::ToBase64String($fixture.Read(16))
            }
        }
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{
            $transaction.Begin('Approved OLE result')
            Check ($transaction.PublicationSealed -and -not $transaction.RenderAttempted) 'OLE publication did not stay unrendered through sealing.'
            $expectedSequence=[TranscriptClipboard].GetField('sequence',[Reflection.BindingFlags]'Instance,NonPublic').GetValue($transaction)
            Check ($expectedSequence -eq [OwnedClipboardFixture]::GetClipboardSequenceNumber()) 'Own publication changed sequence on CloseClipboard.'
            Check ([BitConverter]::ToUInt32($fixture.Read(16),0) -eq ([OwnedClipboardFixture]::GetKeyboardLayout(0).ToInt64() -band 65535)) 'Temporary locale does not match the owned publisher input language.'
            if($renderFirst){
                [OwnedClipboardFixture]::RenderAll($transaction.Handle)
                Check ([Windows.Forms.Clipboard]::GetText() -eq 'Approved OLE result') 'Owned render-all did not publish approved text.'
                $expectedSequence=[TranscriptClipboard].GetField('sequence',[Reflection.BindingFlags]'Instance,NonPublic').GetValue($transaction)
                Check ($expectedSequence -eq [OwnedClipboardFixture]::GetClipboardSequenceNumber()) 'Own rendering changed sequence after its write.'
            }
            $transaction.Restore()
        }catch{
            $operationFailure=$_.Exception
            Report-OperationFailure $transaction $operationFailure
            throw
        }finally{
            Close-Transaction $transaction $operationFailure
        }
        Check ([Windows.Forms.Clipboard]::GetText() -eq 'Owned OLE text') 'Actual OLE text producer was not preserved.'
        Check ([Windows.Forms.Clipboard]::GetDataObject().GetData([Windows.Forms.DataFormats]::Rtf,$false) -eq '{\rtf1 Owned OLE rich text}') 'Actual OLE RTF producer was not preserved.'
        if($renderFirst){
            Check ([Convert]::ToBase64String($fixture.Read($rich)) -eq $originalHtml) 'Actual OLE HTML producer bytes were not preserved.'
            if($null -ne $originalLocale){
                Check ([Convert]::ToBase64String($fixture.Read(16)) -eq $originalLocale) 'Original OLE locale was replaced by the temporary locale.'
            }
        }
    }
    $checks.Add('actual-managed-ole-rich-producer')
    [OwnedClipboardFixture]::CaseId=6
    $virtual=[Windows.Forms.DataObject]::new()
    $virtual.SetText('Owned virtual file fallback text')
    $virtual.SetData('FileGroupDescriptorW',$false,[IO.MemoryStream]::new([byte[]]@(1,0,0,0)))
    $virtual.SetData('FileContents',$false,[IO.MemoryStream]::new([byte[]]@(1,2,3)))
    [Windows.Forms.Clipboard]::SetDataObject($virtual,$true)
    $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $failed=$false
        try{$transaction.Begin('Must not replace virtual file data')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-format'}
        Check $failed 'Declared OLE virtual-file data did not fail closed.'
        Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before) 'Rejected OLE producer was modified.'
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure}
    $checks.Add('ole-virtual-file-contract-fails-closed-before-data-access')
    [OwnedClipboardFixture]::CaseId=7
    $bitmap=[Drawing.Bitmap]::new(8,8)
    $bitmap.SetPixel(3,3,[Drawing.Color]::FromArgb(255,17,99,201))
    try{
        [Windows.Forms.Clipboard]::SetImage($bitmap)
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{$transaction.Begin('Approved image fixture');$transaction.Restore()}
        catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure}
        $image=[Windows.Forms.Clipboard]::GetImage()
        try{Check ($image.GetPixel(3,3).ToArgb() -eq $bitmap.GetPixel(3,3).ToArgb()) 'Image pixels were not preserved.'}
        finally{$image.Dispose()}
    }finally{$bitmap.Dispose()}
    $checks.Add('image-pixel-preservation')
    [OwnedClipboardFixture]::CaseId=8
    $singleText=[byte[][]](,$text)
    Check ($text -is [byte[]] -and $text.Length -eq 42 -and $singleText -is [byte[][]] -and $singleText.Length -eq 1 -and $singleText[0] -is [byte[]]) 'Single-format Unicode setup lost its byte-array shape or exact length.'
    Check ([Object]::ReferenceEquals($singleText[0],$text)) 'Single-format setup replaced or converted the original bytes.'
    $fixture.Put([uint32[]]@(13),$singleText)
    $expectedText=[Convert]::ToBase64String($fixture.Read(13))
    $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
    $owner=[OwnedClipboardFixture]::GetClipboardOwner()
    # Keep the former construction only as a rejected regression input.
    $flattened=[byte[][]]@($text)
    Check ($flattened.Length -eq $text.Length -and $flattened[0] -is [byte[]] -and $flattened[0].Length -eq 1) 'Former array construction did not reproduce the incorrect payload cardinality.'
    foreach($shape in @(0,1,2,3,4)){
        switch($shape){
            0 {$invalid=$flattened}
            1 {$invalid=[byte[][]]::new(1)}
            2 {$invalid=[byte[][]](,[byte[]]@(79))}
            3 {$invalid=[byte[][]](,[byte[]]@(79,0,0))}
            4 {$invalid=[byte[][]](,[byte[]]@(79,0))}
        }
        $caught=$null
        try{$fixture.Put([uint32[]]@(13),$invalid)}catch{$caught=$_.Exception}
        Check ($null -ne $caught) 'Malformed owned payload unexpectedly reached native publication.'
        $description=Get-ClipboardExceptionLeaves $caught
        Check ($description.leaves.Count -eq 1 -and -not $description.truncated -and $description.leaves[0] -is [ArgumentException] -and $description.leaves[0].ParamName -eq 'payloads') 'Malformed owned payload did not fail explicit preflight validation.'
        Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before -and [OwnedClipboardFixture]::GetClipboardOwner() -eq $owner) 'Rejected payload shape changed original clipboard identity.'
        Check ([Convert]::ToBase64String($fixture.Read(13)) -eq $expectedText) 'Rejected payload shape changed full original allocation bytes.'
    }
    $fixture.Hold(80)
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{$transaction.Begin('Approved after transient lock');$transaction.Restore()}
    catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure}
    Check ([Convert]::ToBase64String($fixture.Read(13)) -eq $expectedText) 'Transient lock recovery changed clipboard bytes.'
    $checks.Add('transient-lock-recovers-without-content-loss')
    [OwnedClipboardFixture]::CaseId=9
    $fixture.Hold(600)
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $failed=$false
        try{$transaction.Begin('Must not replace busy clipboard')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-busy'}
        Check $failed 'Persistent lock was not classified busy.'
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure}
    Start-Sleep -Milliseconds 650
    Check ([Convert]::ToBase64String($fixture.Read(13)) -eq $expectedText) 'Busy failure changed clipboard bytes.'
    $checks.Add('busy-fails-closed')
    [OwnedClipboardFixture]::CaseId=10
    $fixture.Put([uint32[]]@(13,0x200),[byte[][]]@($text,[byte[]]@(1,2,3)))
    $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $failed=$false
        try{$transaction.Begin('Must not replace unpreservable clipboard')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-format'}
        Check $failed 'Unpreservable owner-specific format was not rejected.'
        Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before) 'Unsupported-format failure changed the clipboard.'
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure}
    $checks.Add('unsupported-format-fails-without-mutation')
    [OwnedClipboardFixture]::CaseId=11
    $fixture.Put([uint32[]]@(13),[byte[][]](,$text))
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $transaction.Begin('Approved cancelled result')
        [void][Windows.Forms.Clipboard]::GetText()
        Check $transaction.RenderedBeforePaste 'Early clipboard reader was not recorded.'
        $transaction.PasteStarted()
        $transaction.PasteFinished()
        Check ($transaction.WaitForRead()) 'Rendered clipboard data was not retained for a late reader.'
        Check ($transaction.HoldMilliseconds -ge 1000) 'Early history-style read shortened the existing minimum hold.'
        $fixture.Put([uint32[]]@(13),[byte[][]](,[Text.Encoding]::Unicode.GetBytes("New user copy`0")))
        $transaction.Restore()
        Check ([Windows.Forms.Clipboard]::GetText() -eq 'New user copy') 'A newer clipboard copy was overwritten.'
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure}
    $checks.Add('early-reader-and-new-copy-win')
    [OwnedClipboardFixture]::CaseId=12
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $transaction.Begin('Approved restore failure result')
        $fixture.Hold(400)
        $failed=$false
        try{$transaction.Restore()}catch{$failed=(Fault-Code $_.Exception) -eq 'restore-failed'}
        Check $failed 'Restore lock failure was not explicit.'
        try{$transaction.Dispose()}catch{Check ((Fault-Code $_.Exception) -eq 'restore-failed') 'Unexpected deferred restore error.'}
        Start-Sleep -Milliseconds 450
        [TranscriptClipboard]::RecoverPending()
        Check ([Windows.Forms.Clipboard]::GetText() -eq 'New user copy') 'Busy restore recovery did not restore the full saved text.'
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure}
    $checks.Add('restore-failure-is-explicit-and-backup-retained')
    $flags=[Reflection.BindingFlags]'Static,NonPublic'
    $setter=[ViClipboard.ClipboardSnapshot].GetField('write',$flags)
    $original=$setter.GetValue($null)
    [OwnedClipboardFixture]::RealSetter=$original
    foreach($after in @(0,1,2)){
        [OwnedClipboardFixture]::CaseId=13+$after
        $fixture.Put([uint32[]]@(13,$format,$rich,16),[byte[][]]@($text,[byte[]]@(0),$html,[BitConverter]::GetBytes([uint32]1031)))
        $expected=Read-Mixed $fixture $format $rich
        $expectedLocale=[Convert]::ToBase64String($fixture.Read(16))
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{
            $transaction.Begin('Approved partial restore fixture')
            [OwnedClipboardFixture]::FailAfter=$after
            [OwnedClipboardFixture]::Writes=0
            $setter.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('RestoreSetter')))
            $failed=$false
            try{$transaction.Dispose()}catch{$failed=(Fault-Code $_.Exception) -eq 'restore-failed'}
            Check $failed 'Controlled mid-restore failure did not retain the transaction.' 'partial-failure'
            Check ([OwnedClipboardFixture]::Writes -eq $after) 'Restore seam failed at a different mutation boundary.' 'partial-writes'
            $sequence=[TranscriptClipboard].GetField('sequence',[Reflection.BindingFlags]'Instance,NonPublic').GetValue($transaction)
            Check ($sequence -eq [OwnedClipboardFixture]::GetClipboardSequenceNumber()) 'Own partial restoration was not attributed under the lock.' 'partial-sequence'
            [OwnedClipboardFixture]::RenderAll($transaction.Handle)
            if($after -eq 0){
                Check ([OwnedClipboardFixture]::CountClipboardFormats() -eq 0) 'Late rendering reintroduced data after empty restore.'
            }else{
                Check ([Convert]::ToBase64String($fixture.Read(16)) -eq $expectedLocale) 'Partial restoration did not preserve the saved locale prelude.' 'partial-locale'
                if($after -eq 1){Check (-not [OwnedClipboardFixture]::IsClipboardFormatAvailable(13)) 'Late rendering reintroduced the temporary transcript after the locale prelude.'}
                else{Check ([Convert]::ToBase64String($fixture.Read(13)) -eq $expected.text) 'Late rendering changed the restored first text format.' 'partial-text'}
            }
            $setter.SetValue($null,$original)
            [TranscriptClipboard]::RecoverPending()
            $restored=Read-Mixed $fixture $format $rich
            Check ($restored.text -eq $expected.text) 'Mid-restore recovery lost the original Unicode bytes.'
            Check ($restored.metadata -eq $expected.metadata) 'Mid-restore recovery lost zero-valued metadata bytes.'
            Check ($restored.rich -eq $expected.rich) 'Mid-restore recovery lost rich bytes.'
            Check ([Convert]::ToBase64String($fixture.Read(16)) -eq $expectedLocale) 'Mid-restore recovery lost the original locale bytes.'
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure { $setter.SetValue($null,$original) }}
    }
    $checks.Add('actual-empty-and-first-format-restore-faults-recover-all-original-bytes')
    [OwnedClipboardFixture]::CaseId=16
    $fixture.Put([uint32[]]@(13,$rich,16),[byte[][]]@($text,$html,[BitConverter]::GetBytes([uint32]1031)))
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $transaction.Begin('Must never be repasted')
        [OwnedClipboardFixture]::FailAfter=2
        [OwnedClipboardFixture]::Writes=0
        $setter.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('RestoreSetter')))
        try{$transaction.Dispose()}catch{Check ((Fault-Code $_.Exception) -eq 'restore-failed') 'Unexpected restore failure.'}
        Check ([OwnedClipboardFixture]::Writes -eq 2) 'External-copy fixture did not reach restored locale and first text.'
        $setter.SetValue($null,$original)
        $fixture.Put([uint32[]]@(13),[byte[][]](,[Text.Encoding]::Unicode.GetBytes("New external copy wins`0")))
        [TranscriptClipboard]::RecoverPending()
        Check ([Windows.Forms.Clipboard]::GetText() -eq 'New external copy wins') 'Deferred backup overwrote a genuinely newer external copy.'
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure { $setter.SetValue($null,$original) }}
    $checks.Add('external-new-copy-wins-after-partial-restore')
    [OwnedClipboardFixture]::CaseId=17
    $fixture.Put([uint32[]]@(13),[byte[][]](,$text))
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $transaction.Begin('Must not overwrite unknown mutation')
        Check (-not [TranscriptClipboard].GetField('rendered',[Reflection.BindingFlags]'Instance,NonPublic').GetValue($transaction)) 'Unknown-mutation fixture requires an unrendered transcript.'
        $expectedSequence=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
        $fixture.AddWhileOwned($transaction.Handle,$format,[byte[]]@(9,8,7))
        Check ([OwnedClipboardFixture]::GetClipboardOwner() -eq $transaction.Handle) 'Unknown-mutation fixture changed owner.'
        $mutatedSequence=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
        $unknownBytes=[Convert]::ToBase64String($fixture.Read($format))
        Check ($mutatedSequence -ne $expectedSequence) 'Unknown-mutation fixture did not change the actual sequence.'
        [OwnedClipboardFixture]::RenderAll($transaction.Handle)
        Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $mutatedSequence) 'Own renderer laundered an unknown clipboard mutation.'
        $failed=$false
        try{$transaction.Restore()}catch{$failed=(Fault-Code $_.Exception) -eq 'restore-failed'}
        Check $failed 'Unknown same-owner drift did not retain the backup.'
        Check ([Convert]::ToBase64String($fixture.Read($format)) -eq $unknownBytes) 'Rejected unknown mutation was modified.'
        try{$transaction.Dispose()}catch{Check ((Fault-Code $_.Exception) -eq 'restore-failed') 'Unexpected pending mutation failure.'}
        $pending=[TranscriptClipboard].GetField('deferred',[Reflection.BindingFlags]'Static,NonPublic').GetValue($null)
        Check ([Object]::ReferenceEquals($pending,$transaction)) 'Unknown mutation discarded the pending transaction.'
        $fixture.Put([uint32[]]@(13),[byte[][]](,[Text.Encoding]::Unicode.GetBytes("New copy after unknown mutation`0")))
        [TranscriptClipboard]::RecoverPending()
        Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy after unknown mutation') 'Pending backup overwrote a newer external copy.'
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure}
    $checks.Add('unknown-same-owner-mutation-is-not-laundered-by-own-rendering')
    $publicationHook=[TranscriptClipboard].GetField('publicationClosed',[Reflection.BindingFlags]'Static,NonPublic')
    [OwnedClipboardFixture]::PublicationFixture=$fixture
    [OwnedClipboardFixture]::PublicationFormat=$format
    foreach($mutation in @(0,1,2,3)){
        [OwnedClipboardFixture]::CaseId=18+$mutation
        $fixture.Put([uint32[]]@(13),[byte[][]](,$text))
        [OwnedClipboardFixture]::PublicationMutation=$mutation
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{
            $publicationHook.SetValue($null,[Delegate]::CreateDelegate([Action[IntPtr]],[OwnedClipboardFixture].GetMethod('MutatePublication')))
            $failed=$false
            try{$transaction.Begin('Must not overwrite seal-window changes')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-changed'}
            Check $failed 'A seal-window mutation was accepted as the initial baseline.'
            Check (-not $transaction.PublicationSealed) 'A changed publication was marked sealed.'
            $publicationHook.SetValue($null,$null)
            if($mutation -eq 3){
                Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy during seal') 'A newer external copy was overwritten during sealing.'
            }else{
                Check ([OwnedClipboardFixture]::GetClipboardOwner() -eq $transaction.Handle) 'Same-owner seal fixture lost ownership.'
                try{$transaction.Dispose()}catch{Check ((Fault-Code $_.Exception) -eq 'restore-failed') 'Unexpected retained seal failure.'}
                $pending=[TranscriptClipboard].GetField('deferred',[Reflection.BindingFlags]'Static,NonPublic').GetValue($null)
                Check ([Object]::ReferenceEquals($pending,$transaction)) 'Unknown seal mutation discarded its pending backup.'
                $fixture.Put([uint32[]]@(13),[byte[][]](,[Text.Encoding]::Unicode.GetBytes("New copy after seal failure`0")))
                [TranscriptClipboard]::RecoverPending()
                Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy after seal failure') 'Pending seal backup overwrote a genuine new copy.'
            }
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure { $publicationHook.SetValue($null,$null) }}
    }
    $checks.Add('initial-seal-rejects-unknown-format-text-token-and-new-copy-races')
    foreach($requestedFormat in @(13,1,7)){
        [OwnedClipboardFixture]::CaseId=22
        $fixture.Put([uint32[]]@(13,$format,$rich,16),[byte[][]]@($text,[byte[]]@(0),$html,[BitConverter]::GetBytes([uint32]1031)))
        $expected=Read-Mixed $fixture $format $rich
        $approved='Approved '+[char]0x4e2d+[char]0x00e9
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{
            $transaction.Begin($approved)
            Check ($transaction.PublicationSealed -and -not $transaction.RenderAttempted) 'Native text-family fixture was rendered before a reader requested data.'
            $nativeBytes=$fixture.Read([uint32]$requestedFormat)
            Check ($nativeBytes.Length -gt 1) 'Native text-family conversion returned empty data.'
            if($requestedFormat -ne 13){
                Check ([Text.Encoding]::ASCII.GetString($nativeBytes).StartsWith('Approved ')) 'Native ANSI/OEM conversion lost its ASCII prefix.'
            }
            Check ([Windows.Forms.Clipboard]::GetText() -eq $approved) 'Native text-family conversion changed canonical Unicode.'
            $transaction.Restore()
            $restored=Read-Mixed $fixture $format $rich
            Check ($restored.text -eq $expected.text -and $restored.metadata -eq $expected.metadata -and $restored.rich -eq $expected.rich) 'Native text-family restore changed original bytes.'
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure}
    }
    $checks.Add('native-unicode-ansi-oem-readers-preserve-canonical-result-and-backup')
    $static=[Reflection.BindingFlags]'Static,NonPublic'
    $probeReader=[TranscriptClipboard].GetField('publicationRead',$static)
    $realProbe=$probeReader.GetValue($null)
    [OwnedClipboardFixture]::RealPublicationRead=$realProbe
    foreach($mode in @(0,1,2,3,4,5)){
        [OwnedClipboardFixture]::CaseId=23+$mode
        $fixture.Put([uint32[]]@(13),[byte[][]](,$text))
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        [OwnedClipboardFixture]::ProbeMode=$mode
        [OwnedClipboardFixture]::ProbeWindow=$transaction.Handle
        try{
            $probeReader.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr]],[OwnedClipboardFixture].GetMethod('ControlledProbe')))
            if($mode -eq 1){$publicationHook.SetValue($null,[Delegate]::CreateDelegate([Action[IntPtr]],[OwnedClipboardFixture].GetMethod('StaleProbe')))}
            $failed=$false
            $failureProjection=$null
            try{$transaction.Begin('Must require a correlated probe')}catch{
                $failed=(Fault-Code $_.Exception) -eq 'clipboard-changed'
                $failureProjection=ConvertTo-ClipboardFailure $_.Exception
            }
            Check $failed 'A null/unrelated/stale/non-null probe was accepted.'
            if($mode -eq 4){Check ($failureProjection.causes[0].format -eq 1) 'Alias negative did not exercise the requested/canonical mapping after native Unicode proof.'}
            Check (-not $transaction.PublicationSealed) 'An unproven probe marked publication sealed.'
            $probeReader.SetValue($null,$realProbe)
            $publicationHook.SetValue($null,$null)
            $fixture.Put([uint32[]]@(13),[byte[][]](,$text))
            [TranscriptClipboard]::RecoverPending()
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure { $probeReader.SetValue($null,$realProbe);$publicationHook.SetValue($null,$null) }}
    }
    $checks.Add('per-call-probe-rejects-null-zero-stale-unrelated-renderall-and-nonnull')
    $closingHook=[TranscriptClipboard].GetField('sealClose',$static)
    $originalSealClose=$closingHook.GetValue($null)
    [OwnedClipboardFixture]::RealSealClose=$originalSealClose
    $commitHook=[TranscriptClipboard].GetField('sealBeforeCommit',$static)
    foreach($mode in @(0,1,2,3)){
        [OwnedClipboardFixture]::CaseId=29+$mode
        $fixture.Put([uint32[]]@(13,$format,$rich,16),[byte[][]]@($text,[byte[]]@(0),$html,[BitConverter]::GetBytes([uint32]1031)))
        $expected=Read-Mixed $fixture $format $rich
        [OwnedClipboardFixture]::FinalSealMode=$mode
        $transaction=[TranscriptClipboard]::new()
        [OwnedClipboardFixture]::ProbeWindow=$transaction.Handle
        $operationFailure=$null
        try{
            $closingHook.SetValue($null,[Delegate]::CreateDelegate([Func[bool]],[OwnedClipboardFixture].GetMethod('RenderDuringSealClose')))
            $commitHook.SetValue($null,[Delegate]::CreateDelegate([Action[IntPtr]],[OwnedClipboardFixture].GetMethod('BeforeSealCommit')))
            if($mode -eq 0){
                $transaction.Begin('Keep render disabled until final seal')
                Check $transaction.PublicationSealed 'A valid readonly close could not seal.'
                Check (-not $transaction.RenderAttempted -and -not $transaction.RenderWriteStarted -and -not $transaction.RenderWriteCompleted) 'Seal-close reentrancy materialized text.'
                Check ($transaction.PublicationBlockedRenderRequests -ge 6) 'Both real render messages were not exercised before/after readonly Close and before final seal.'
                $transaction.Restore()
                $restored=Read-Mixed $fixture $format $rich
                Check ($restored.text -eq $expected.text -and $restored.metadata -eq $expected.metadata -and $restored.rich -eq $expected.rich) 'Readonly close render attempts changed original bytes.'
            }else{
                $failed=$false
                try{$transaction.Begin('Must not adopt final-seal changes')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-changed'}
                Check $failed 'Final-seal changes were adopted.'
                Check (-not $transaction.PublicationSealed -and -not $transaction.RenderWriteStarted) 'An incomplete final seal rendered text.'
                if($mode -eq 1){Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy before seal commit') 'Final seal overwrote a newer owner.'}
                elseif($mode -eq 3){Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy during readonly close') 'Readonly close overwrote a newer owner.'}
                else{
                    try{$transaction.Dispose()}catch{Check ((Fault-Code $_.Exception) -eq 'restore-failed') 'Unexpected final-seal recovery failure.'}
                    $pending=[TranscriptClipboard].GetField('deferred',$static).GetValue($null)
                    Check ([Object]::ReferenceEquals($pending,$transaction)) 'Final-seal mutation discarded its pending master.'
                    $fixture.Put([uint32[]]@(13),[byte[][]](,$text))
                    [TranscriptClipboard]::RecoverPending()
                    Check ([Windows.Forms.Clipboard]::GetText() -eq 'Owned Unicode sample') 'Final-seal recovery overwrote a newer owner.'
                }
            }
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure { $closingHook.SetValue($null,$originalSealClose);$commitHook.SetValue($null,$null) }}
    }
    $checks.Add('readonly-close-and-final-seal-reentrancy-cannot-render-or-adopt-changes')
    $copyHook=[ViClipboard.ClipboardSnapshot].GetField('copyCheckpoint',$static)
    $copyRelease=[ViClipboard.ClipboardSnapshot].GetField('releaseCopy',$static)
    $realRelease=$copyRelease.GetValue($null)
    [OwnedClipboardFixture]::RealCopyRelease=$realRelease
    foreach($stage in @(0,1)){
        [OwnedClipboardFixture]::CaseId=33+$stage
        $fixture.Put([uint32[]]@(13,$format,$rich),[byte[][]]@($text,[byte[]]@(0),$html))
        $expected=Read-Mixed $fixture $format $rich
        $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
        $owner=[OwnedClipboardFixture]::GetClipboardOwner()
        [OwnedClipboardFixture]::CopyFailureStage=$stage
        [OwnedClipboardFixture]::CopyFreeCount=0
        [OwnedClipboardFixture]::CopyFreed=$false
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{
            $copyHook.SetValue($null,[Delegate]::CreateDelegate([Action[IntPtr,int]],[OwnedClipboardFixture].GetMethod('CopyCheckpoint')))
            $copyRelease.SetValue($null,[Delegate]::CreateDelegate([Func[IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('ObserveCopyRelease')))
            $failed=$false
            try{$transaction.Begin('Must fail without leaking copy allocation')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-snapshot-failed'}
            Check $failed 'Controlled allocation/lock-boundary failure was not explicit.'
            Check ([OwnedClipboardFixture]::CopyFreeCount -eq 1 -and [OwnedClipboardFixture]::CopyFreed -and [OwnedClipboardFixture]::CopyIdentity -and [OwnedClipboardFixture]::CopyUnlocked) 'Failed copy was not unlocked and actually freed exactly once.'
            Check ($fixture.LockCount(13) -eq 0) 'Failed copy left its original source handle locked.'
            Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before -and [OwnedClipboardFixture]::GetClipboardOwner() -eq $owner) 'Failed copy changed original clipboard identity.'
            $restored=Read-Mixed $fixture $format $rich
            Check ($restored.text -eq $expected.text -and $restored.metadata -eq $expected.metadata -and $restored.rich -eq $expected.rich) 'Failed copy changed original clipboard bytes.'
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure { $copyHook.SetValue($null,$null);$copyRelease.SetValue($null,$realRelease) }}
    }
    $checks.Add('post-allocation-and-post-lock-copy-faults-release-native-allocation-once')
    [OwnedClipboardFixture]::CaseId=35
    $fixture.Put([uint32[]]@(13),[byte[][]](,$text))
    $closeSetter=[TranscriptClipboard].GetField('sealClose',$static)
    $realClose=$closeSetter.GetValue($null)
    [OwnedClipboardFixture]::RealSealClose=$realClose
    [OwnedClipboardFixture]::ProbeMode=0
    [OwnedClipboardFixture]::ManagedFailureClosed=$false
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $probeReader.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr]],[OwnedClipboardFixture].GetMethod('ControlledProbe')))
        $closeSetter.SetValue($null,[Delegate]::CreateDelegate([Func[bool]],[OwnedClipboardFixture].GetMethod('ControlledSealCloseFailure')))
        $caught=$null
        try{$transaction.Begin('Must retain both validation and close faults')}catch{$caught=$_.Exception}
        Check ($null -ne $caught) 'Combined validation/close seam unexpectedly succeeded.'
        Check ([OwnedClipboardFixture]::ManagedFailureClosed) 'Combined-failure control did not actually close its native lock.'
        $projection=ConvertTo-ClipboardFailure $caught
        $wire=@{clipboardCauses=@($projection.causes);clipboardCausesTruncated=$projection.truncated}|ConvertTo-Json -Compress -Depth 6|ConvertFrom-Json
        Check ($wire.clipboardCauses.Count -eq 2 -and -not $wire.clipboardCausesTruncated) 'Combined failure did not preserve exactly two wire causes.'
        Check ($wire.clipboardCauses[0].stage -eq 'publication-state' -and $wire.clipboardCauses[0].format -eq 13 -and $wire.clipboardCauses[1].stage -eq 'publication-close') 'Combined failure lost validation or close identity.'
        Check ($wire.clipboardCauses[0].errorNumber -eq 0 -and $wire.clipboardCauses[1].errorNumber -eq 0) 'Managed control failures fabricated a Win32 error.'
        $originalError=[Console]::Error
        $capturedError=[IO.StringWriter]::new()
        try{[Console]::SetError($capturedError);Report-TransactionFault 'operation' $caught}
        finally{[Console]::SetError($originalError)}
        $logged=@($capturedError.ToString() -split '\r?\n'|Where-Object {$_ -like 'VI_CLIP_FAILURE *'})
        $capturedError.Dispose()
        Check ($logged.Count -eq 2 -and $logged[0] -like '*stage=publication-state*' -and $logged[1] -like '*stage=publication-close*') 'Fixture logging lost one aggregate member.'
        $assertion=$null
        try{Check $false 'PRIVATE_ASSERTION_MESSAGE' 'partial-sequence'}catch{$assertion=$_.Exception}
        $capturedAssertion=[IO.StringWriter]::new()
        try{[Console]::SetError($capturedAssertion);Report-TransactionFault 'operation' $assertion}
        finally{[Console]::SetError($originalError)}
        $assertionLog=$capturedAssertion.ToString().Trim()
        $capturedAssertion.Dispose()
        Check ($assertionLog -eq 'VI_CLIP_FAILURE operation case=35 code=fixture-assertion check=partial-sequence') 'Fixture assertion reporting lost its fixed check identity or exposed raw content.'
        $extra=[AggregateException]::new('Synthetic bounded aggregate',[Exception[]]@($caught,[InvalidOperationException]::new('PRIVATE_SYNTHETIC_CAUSE')))
        $bounded=ConvertTo-ClipboardFailure $extra
        Check ($bounded.causes.Count -eq 2 -and $bounded.truncated) 'Excess aggregate members were silently discarded.'
        Check (($bounded|ConvertTo-Json -Depth 6) -notmatch 'PRIVATE_SYNTHETIC_CAUSE') 'Bounded projection exposed raw exception content.'
        $probeReader.SetValue($null,$realProbe)
        $closeSetter.SetValue($null,$realClose)
        $fixture.Put([uint32[]]@(13),[byte[][]](,$text))
        [TranscriptClipboard]::RecoverPending()
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure { $probeReader.SetValue($null,$realProbe);$closeSetter.SetValue($null,$realClose) }}
    $checks.Add('combined-native-validation-and-close-failure-preserves-two-scalar-causes')
    [OwnedClipboardFixture]::CaseId=36
    $classify=[ViClipboard.ClipboardSnapshot].GetMethod('ClassifyRegisteredName',$static)
    $knownNames=@('Ole Private Data','DataObject','FileContents','FileGroupDescriptor','FileGroupDescriptorW','Embed Source','Embedded Object','Link Source')
    for($i=0;$i -lt $knownNames.Count;$i++){
        $lower=$knownNames[$i].ToLowerInvariant()
        $upper=$knownNames[$i].ToUpperInvariant()
        $lowerId=[OwnedClipboardFixture]::RegisterClipboardFormat($lower)
        $upperId=[OwnedClipboardFixture]::RegisterClipboardFormat($upper)
        Check ($lowerId -ge 0xc000 -and $lowerId -eq $upperId) 'Native registered format identity changed with casing.'
        $classification=2
        if($i -lt 2){$classification=1}
        foreach($variant in @($knownNames[$i],$lower,$upper)){
            Check ($classify.Invoke($null,[object[]]@($variant)) -eq $classification) 'Known registered format classification changed with casing.'
        }
    }
    Check ($classify.Invoke($null,[object[]]@('VI synthetic metadata')) -eq 0) 'Supported registered metadata was misclassified.'
    foreach($name in $knownNames[2..7]){
        foreach($variant in @($name.ToLowerInvariant(),$name.ToUpperInvariant())){
            $virtual=[OwnedClipboardFixture]::RegisterClipboardFormat($variant)
            $fixture.Put([uint32[]]@(13,$format,$rich,$virtual),[byte[][]]@($text,[byte[]]@(0),$html,[byte[]]@(0,0,0,0)))
            $expected=Read-Mixed $fixture $format $rich
            $virtualBytes=[Convert]::ToBase64String($fixture.Read($virtual))
            $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
            $owner=[OwnedClipboardFixture]::GetClipboardOwner()
            $transaction=[TranscriptClipboard]::new()
            $operationFailure=$null
            try{
                $caught=$null
                try{$transaction.Begin('Must reject unsupported registered formats')}catch{$caught=$_.Exception}
                Check ($null -ne $caught) 'Unsupported registered format was captured.'
                $description=Get-ClipboardExceptionLeaves $caught
                Check ($description.leaves.Count -eq 1 -and -not $description.truncated) 'Unsupported format fault lost its identity.'
                $cause=$description.leaves[0]
                Check ($cause.Code -eq 'clipboard-format' -and $cause.Stage -eq 'snapshot-format' -and $cause.Format -eq $virtual -and $cause.NativeCode -eq 0) 'Unsupported format did not fail before copying with a numeric format only.'
                Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before -and [OwnedClipboardFixture]::GetClipboardOwner() -eq $owner) 'Unsupported format rejection changed original clipboard identity.'
                $after=Read-Mixed $fixture $format $rich
                Check ($after.text -eq $expected.text -and $after.metadata -eq $expected.metadata -and $after.rich -eq $expected.rich -and [Convert]::ToBase64String($fixture.Read($virtual)) -eq $virtualBytes) 'Unsupported format rejection changed full original payloads.'
            }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
            finally{Close-Transaction $transaction $operationFailure}
        }
    }
    [OwnedClipboardFixture]::CaseId=37
    $fixture.Put([uint32[]]@(13,$format,$rich),[byte[][]]@($text,[byte[]]@(0),$html))
    $expected=Read-Mixed $fixture $format $rich
    $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
    $owner=[OwnedClipboardFixture]::GetClipboardOwner()
    $nameReader=[ViClipboard.ClipboardSnapshot].GetField('readFormatName',$static)
    $realNameReader=$nameReader.GetValue($null)
    [OwnedClipboardFixture]::RealFormatNameRead=$realNameReader
    [OwnedClipboardFixture]::NameFailureFormat=$format
    [OwnedClipboardFixture]::NativeNameFailure=$false
    $transaction=[TranscriptClipboard]::new()
    $operationFailure=$null
    try{
        $nameReader.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,Text.StringBuilder,int,int]],[OwnedClipboardFixture].GetMethod('FailRegisteredName')))
        $caught=$null
        try{$transaction.Begin('Must reject unresolved registered names')}catch{$caught=$_.Exception}
        Check ($null -ne $caught -and [OwnedClipboardFixture]::NativeNameFailure) 'Native format name failure did not reject capture.'
        $description=Get-ClipboardExceptionLeaves $caught
        Check ($description.leaves.Count -eq 1 -and -not $description.truncated) 'Native format name failure lost its identity.'
        $cause=$description.leaves[0]
        Check ($cause.Code -eq 'clipboard-snapshot-failed' -and $cause.Stage -eq 'snapshot-format-name' -and $cause.Format -eq $format -and $cause.NativeCode -eq [OwnedClipboardFixture]::NameFailureError) 'Format name failure lost its actual numeric native error.'
        Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before -and [OwnedClipboardFixture]::GetClipboardOwner() -eq $owner) 'Format name failure changed original clipboard identity.'
        $after=Read-Mixed $fixture $format $rich
        Check ($after.text -eq $expected.text -and $after.metadata -eq $expected.metadata -and $after.rich -eq $expected.rich) 'Format name failure changed full original payloads.'
    }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
    finally{Close-Transaction $transaction $operationFailure { $nameReader.SetValue($null,$realNameReader) }}
    $checks.Add('registered-format-case-identity-and-native-name-failure-reject-before-mutation')
    foreach($restoreCopy in @($false,$true)){
        foreach($stage in @(0,1)){
            foreach($mode in @(1,2)){
                [OwnedClipboardFixture]::CaseId=38+([int]$restoreCopy*4)+($stage*2)+$mode-1
                $fixture.Put([uint32[]]@(13,$format,$rich),[byte[][]]@($text,[byte[]]@(0),$html))
                $expected=Read-Mixed $fixture $format $rich
                $transaction=[TranscriptClipboard]::new()
                $operationFailure=$null
                try{
                    if($restoreCopy){$transaction.Begin('Must preserve master on copy release failure')}
                    $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
                    $owner=[OwnedClipboardFixture]::GetClipboardOwner()
                    [OwnedClipboardFixture]::CopyFailureStage=$stage
                    [OwnedClipboardFixture]::CopyReleaseMode=$mode
                    [OwnedClipboardFixture]::CopyFreeCount=0
                    [OwnedClipboardFixture]::CopyFreed=$false
                    [OwnedClipboardFixture]::CopyPrimaryFailure=$null
                    [OwnedClipboardFixture]::CopyReleaseFailure=$null
                    $copyHook.SetValue($null,[Delegate]::CreateDelegate([Action[IntPtr,int]],[OwnedClipboardFixture].GetMethod('CopyCheckpoint')))
                    $copyRelease.SetValue($null,[Delegate]::CreateDelegate([Func[IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('ObserveCopyRelease')))
                    $caught=$null
                    try{
                        if($restoreCopy){$transaction.Restore()}else{$transaction.Begin('Must preserve copy and release faults')}
                    }catch{$caught=$_.Exception}
                    Check ($null -ne $caught) 'Copy/release fault control unexpectedly succeeded.'
                    $description=Get-ClipboardExceptionLeaves $caught
                    Check ($description.leaves.Count -eq 2 -and -not $description.truncated) 'Copy failure or release cleanup was replaced.'
                    $primary=$description.leaves[0]
                    $cleanup=$description.leaves[1]
                    $expectedCode='clipboard-snapshot-failed'
                    $expectedStage='snapshot-copy'
                    if($restoreCopy){$expectedCode='restore-failed';$expectedStage='restore-copy'}
                    Check ($primary.Code -eq $expectedCode -and $primary.Stage -eq $expectedStage -and $cleanup.Code -eq $expectedCode -and $cleanup.Stage -eq 'snapshot-release') 'Copy/release phases or top-level failure policy were lost.'
                    $originalPrimary=$primary.InnerException
                    $originalCleanup=$cleanup
                    if($restoreCopy){$originalPrimary=$originalPrimary.InnerException;$originalCleanup=$cleanup.InnerException}
                    Check ([Object]::ReferenceEquals($originalPrimary,[OwnedClipboardFixture]::CopyPrimaryFailure)) 'Original primary exception was replaced.'
                    Check ([Object]::ReferenceEquals($originalCleanup.InnerException,[OwnedClipboardFixture]::CopyReleaseFailure)) 'Release exception identity or explicit returned-failure status was lost.'
                    Check ([OwnedClipboardFixture]::CopyFreeCount -eq 1 -and [OwnedClipboardFixture]::CopyFreed -and [OwnedClipboardFixture]::CopyIdentity -and [OwnedClipboardFixture]::CopyUnlocked) 'Release control did not actually free exactly its unlocked copy once.'
                    Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before -and [OwnedClipboardFixture]::GetClipboardOwner() -eq $owner) 'Copy/release failure changed clipboard identity.'
                    $projection=ConvertTo-ClipboardFailure $caught
                    $wire=$projection|ConvertTo-Json -Compress -Depth 6|ConvertFrom-Json
                    Check ($wire.causes.Count -eq 2 -and -not $wire.truncated -and $wire.causes[0].stage -eq $expectedStage -and $wire.causes[1].stage -eq 'snapshot-release') 'Copy/release pair did not survive scalar wire projection.'
                    Check ($wire.causes[0].errorNumber -eq 0 -and $wire.causes[1].errorNumber -eq 0 -and $wire.causes[0].format -eq 13 -and $wire.causes[1].format -eq 13) 'Controlled managed/status failure fabricated a native error or lost its format.'
                    Check (($wire|ConvertTo-Json -Depth 6) -notmatch 'Controlled|successful native free|InnerException|Message') 'Copy/release projection exposed original raw exceptions.'
                    $originalError=[Console]::Error
                    $capturedError=[IO.StringWriter]::new()
                    try{[Console]::SetError($capturedError);Report-TransactionFault 'operation' $caught}
                    finally{[Console]::SetError($originalError)}
                    $logged=@($capturedError.ToString() -split '\r?\n'|Where-Object {$_ -like 'VI_CLIP_FAILURE *'})
                    $capturedError.Dispose()
                    Check ($logged.Count -eq 2 -and $logged[0] -like "*stage=$expectedStage*" -and $logged[1] -like '*stage=snapshot-release*') 'Fixture logging lost the primary or release failure.'
                    $copyHook.SetValue($null,$null)
                    $copyRelease.SetValue($null,$realRelease)
                    if($restoreCopy){$transaction.Restore()}
                    Check ($fixture.LockCount(13) -eq 0) 'Copy/release failure left the original source locked.'
                    $after=Read-Mixed $fixture $format $rich
                    Check ($after.text -eq $expected.text -and $after.metadata -eq $expected.metadata -and $after.rich -eq $expected.rich) 'Copy/release failure lost full original master payloads.'
                }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
                finally{Close-Transaction $transaction $operationFailure { $copyHook.SetValue($null,$null);$copyRelease.SetValue($null,$realRelease);[OwnedClipboardFixture]::CopyReleaseMode=0 }}
            }
        }
    }
    $checks.Add('capture-and-restore-copy-release-failures-preserve-primary-and-cleanup-with-one-real-free')
    $completionSetter=[ViClipboard.ClipboardSnapshot].GetField('completeTextWrite',$static)
    $realCompletion=$completionSetter.GetValue($null)
    $restoreCloser=[TranscriptClipboard].GetField('restoreClose',$static)
    $realRestoreClose=$restoreCloser.GetValue($null)
    $savedField=[TranscriptClipboard].GetField('saved',[Reflection.BindingFlags]'Instance,NonPublic')
    [OwnedClipboardFixture]::RealCompletionSetter=$realCompletion
    [OwnedClipboardFixture]::RealRestoreClose=$realRestoreClose
    foreach($mode in @(0,1,2,3,4,5)){
        [OwnedClipboardFixture]::CaseId=46+$mode
        $fixture.Put([uint32[]]@(13,$format,$rich,16),[byte[][]]@($text,[byte[]]@(0),$html,[BitConverter]::GetBytes([uint32]1031)))
        $expected=Read-Mixed $fixture $format $rich
        $expectedLocale=[Convert]::ToBase64String($fixture.Read(16))
        $expectedAnsi=[Convert]::ToBase64String($fixture.Read(1))
        $expectedOem=[Convert]::ToBase64String($fixture.Read(7))
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{
            $transaction.Begin('Must retain partial text publication authority')
            $master=$savedField.GetValue($transaction)
            [OwnedClipboardFixture]::RestoreWindow=$transaction.Handle
            [OwnedClipboardFixture]::RestoreCloseMode=$mode
            [OwnedClipboardFixture]::NativeRestoreClosed=$false
            [OwnedClipboardFixture]::CompletionFails=$false
            [OwnedClipboardFixture]::CompletionAttempts=0
            [OwnedClipboardFixture]::CompletionWrites=0
            [OwnedClipboardFixture]::CompletionFormats.Clear()
            [OwnedClipboardFixture]::FailAfter=2
            [OwnedClipboardFixture]::Writes=0
            $setter.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('RestoreSetter')))
            $completionSetter.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('CompletionSetter')))
            $restoreCloser.SetValue($null,[Delegate]::CreateDelegate([Func[bool]],[OwnedClipboardFixture].GetMethod('RestoreCloseBoundary')))
            $caught=$null
            try{$transaction.Dispose()}catch{$caught=$_.Exception}
            Check ($null -ne $caught) 'Original partial restore failure was hidden by text completion.'
            Check ([OwnedClipboardFixture]::Writes -eq 2) 'Original first-text fault boundary changed.'
            Check ([OwnedClipboardFixture]::CompletionAttempts -eq 2 -and [OwnedClipboardFixture]::CompletionWrites -eq 2 -and [OwnedClipboardFixture]::CompletionFormats.Contains(1) -and [OwnedClipboardFixture]::CompletionFormats.Contains(7)) 'Text cleanup did not separately transfer the two prepared native representations.'
            Check ([OwnedClipboardFixture]::NativeRestoreClosed -and -not $transaction.RenderAttempted) 'Partial completion did not close its lock or rendered the temporary transcript.'
            $causes=ConvertTo-ClipboardFailure $caught
            Check ($causes.causes[0].code -eq 'restore-failed' -and $causes.causes[0].stage -eq 'restore-write') 'Text completion replaced the original failure cause.'
            $setter.SetValue($null,$original)
            $completionSetter.SetValue($null,$realCompletion)
            $restoreCloser.SetValue($null,$realRestoreClose)
            if($mode -eq 5){
                Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy during restore close') 'Restore close overwrote a genuinely newer owner.'
            }else{
                Check ([Object]::ReferenceEquals($savedField.GetValue($transaction),$master) -and [Object]::ReferenceEquals([TranscriptClipboard].GetField('deferred',$static).GetValue($null),$transaction)) 'Partial restore discarded or replaced its pending master.'
                if($mode -eq 0){
                    $sequence=[TranscriptClipboard].GetField('sequence',[Reflection.BindingFlags]'Instance,NonPublic').GetValue($transaction)
                    Check ($sequence -eq [OwnedClipboardFixture]::GetClipboardSequenceNumber() -and $causes.causes.Count -eq 1 -and -not $causes.truncated) 'Completed text publication did not preserve its pre-close sequence.'
                    Check ([Convert]::ToBase64String($fixture.Read(13)) -eq $expected.text -and [Convert]::ToBase64String($fixture.Read(16)) -eq $expectedLocale -and [Convert]::ToBase64String($fixture.Read(1)) -eq $expectedAnsi -and [Convert]::ToBase64String($fixture.Read(7)) -eq $expectedOem) 'Partial text completion changed saved native bytes.'
                    Check (-not [OwnedClipboardFixture]::IsClipboardFormatAvailable($format) -and -not [OwnedClipboardFixture]::IsClipboardFormatAvailable($rich)) 'Text completion retried the failed full restoration.'
                }else{
                    Check ($causes.causes.Count -eq 2 -and -not $causes.truncated -and $causes.causes[1].stage -eq 'restore-sequence') 'Restore close accepted unknown same-owner mutation.'
                    $failed=$false
                    try{$transaction.Restore()}catch{$failed=(Fault-Code $_.Exception) -eq 'restore-failed'}
                    Check $failed 'Recovery adopted unknown same-owner close-window changes.'
                    Check ([Object]::ReferenceEquals($savedField.GetValue($transaction),$master)) 'Rejected close-window changes lost the original master.'
                    $fixture.Put([uint32[]]@(13),[byte[][]](,[Text.Encoding]::Unicode.GetBytes("New copy after restore conflict`0")))
                }
            }
            [TranscriptClipboard]::RecoverPending()
            if($mode -eq 0){
                $restored=Read-Mixed $fixture $format $rich
                Check ($restored.text -eq $expected.text -and $restored.metadata -eq $expected.metadata -and $restored.rich -eq $expected.rich -and [Convert]::ToBase64String($fixture.Read(16)) -eq $expectedLocale) 'Partial text recovery did not restore the full saved formats.'
            }elseif($mode -eq 5){Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy during restore close') 'Recovery replaced the newer close-window copy.'}
            else{Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy after restore conflict') 'Recovery replaced a newer copy after a same-owner conflict.'}
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure { $setter.SetValue($null,$original);$completionSetter.SetValue($null,$realCompletion);$restoreCloser.SetValue($null,$realRestoreClose) }}
    }
    $checks.Add('partial-text-completion-preserves-pre-close-authority-and-rejects-close-window-mutations')
    foreach($mode in @(0,1,2)){
        [OwnedClipboardFixture]::CaseId=52+$mode
        $fixture.Put([uint32[]]@(13,$format,$rich,16),[byte[][]]@($text,[byte[]]@(0),$html,[BitConverter]::GetBytes([uint32]1031)))
        $transaction=[TranscriptClipboard]::new()
        $operationFailure=$null
        try{
            $transaction.Begin('Must retain text completion and close failures')
            $master=$savedField.GetValue($transaction)
            [OwnedClipboardFixture]::RestoreWindow=$transaction.Handle
            [OwnedClipboardFixture]::RestoreCloseMode=0
            if($mode -ne 0){[OwnedClipboardFixture]::RestoreCloseMode=6}
            [OwnedClipboardFixture]::NativeRestoreClosed=$false
            [OwnedClipboardFixture]::CompletionFails=$mode -eq 0
            [OwnedClipboardFixture]::CompletionAttempts=0
            [OwnedClipboardFixture]::CompletionWrites=0
            [OwnedClipboardFixture]::CompletionFormats.Clear()
            [OwnedClipboardFixture]::FailAfter=2
            if($mode -eq 2){[OwnedClipboardFixture]::FailAfter=-1}
            [OwnedClipboardFixture]::Writes=0
            $setter.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('RestoreSetter')))
            $completionSetter.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('CompletionSetter')))
            $restoreCloser.SetValue($null,[Delegate]::CreateDelegate([Func[bool]],[OwnedClipboardFixture].GetMethod('RestoreCloseBoundary')))
            $caught=$null
            try{$transaction.Dispose()}catch{$caught=$_.Exception}
            Check ($null -ne $caught -and [OwnedClipboardFixture]::NativeRestoreClosed -and ($mode -eq 2 -or [OwnedClipboardFixture]::Writes -eq 2)) 'Controlled cleanup failure lost the original boundary or left a native lock open.'
            $projection=ConvertTo-ClipboardFailure $caught
            $wire=$projection|ConvertTo-Json -Compress -Depth 6|ConvertFrom-Json
            $expectedStage='restore-text'
            if($mode -ne 0){$expectedStage='restore-close'}
            if($mode -eq 2){
                Check ($wire.causes.Count -eq 1 -and -not $wire.truncated -and $wire.causes[0].stage -eq 'restore-close' -and $wire.causes[0].errorNumber -eq 0 -and [OwnedClipboardFixture]::CompletionAttempts -eq 0) 'A full restore fabricated an original write failure or ignored Close failure.'
            }else{
                Check ($wire.causes.Count -eq 2 -and $wire.causes[0].stage -eq 'restore-write' -and $wire.causes[1].stage -eq $expectedStage -and $wire.causes[1].errorNumber -eq 0) 'Original write and cleanup failure did not survive bounded scalar projection.'
            }
            if($mode -eq 0){Check ([OwnedClipboardFixture]::CompletionAttempts -eq 1 -and [OwnedClipboardFixture]::CompletionWrites -eq 0) 'Failed text completion retried or falsely claimed transfer.'}
            elseif($mode -eq 1){Check ([OwnedClipboardFixture]::CompletionAttempts -eq 2 -and [OwnedClipboardFixture]::CompletionWrites -eq 2 -and -not $wire.truncated) 'Close failure lost completed transfers or fabricated additional causes.'}
            Check ([TranscriptClipboard].GetField('began',[Reflection.BindingFlags]'Instance,NonPublic').GetValue($transaction) -and [Object]::ReferenceEquals($savedField.GetValue($transaction),$master) -and [Object]::ReferenceEquals([TranscriptClipboard].GetField('deferred',$static).GetValue($null),$transaction)) 'Cleanup failure committed completion or discarded the pending original master.'
            $setter.SetValue($null,$original)
            $completionSetter.SetValue($null,$realCompletion)
            $restoreCloser.SetValue($null,$realRestoreClose)
            [OwnedClipboardFixture]::CompletionFails=$false
            $fixture.Put([uint32[]]@(13),[byte[][]](,[Text.Encoding]::Unicode.GetBytes("New copy after cleanup failure`0")))
            [TranscriptClipboard]::RecoverPending()
            Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy after cleanup failure') 'Cleanup recovery overwrote the newer copy.'
        }catch{$operationFailure=$_.Exception;Report-OperationFailure $transaction $operationFailure;throw}
        finally{Close-Transaction $transaction $operationFailure { $setter.SetValue($null,$original);$completionSetter.SetValue($null,$realCompletion);$restoreCloser.SetValue($null,$realRestoreClose);[OwnedClipboardFixture]::CompletionFails=$false }}
    }
    $checks.Add('partial-restore-text-and-close-cleanup-errors-preserve-original-cause-and-master')
    $report=@{status='passed';checks=@($checks);zeroAllocation=$zero;zeroAllocationOutcome=$zeroOutcome;clipboardData='CI-owned synthetic only';inputEventsSent=0}
}catch{$fixtureFailure=$_.Exception;throw}
finally{
    try{$fixture.Dispose()}catch{
        $cleanupFailure=$_.Exception
        Report-TransactionFault 'fixture-cleanup' $cleanupFailure
        if($fixtureFailure){
            throw [AggregateException]::new('Owned fixture operation and cleanup both failed.',
                [Exception[]]@($fixtureFailure,$cleanupFailure))
        }
        throw
    }
}
$report|ConvertTo-Json -Compress
