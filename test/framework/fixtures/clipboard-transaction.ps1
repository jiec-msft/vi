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
 public static int FailAfter=-1, Writes;
 static int caseId;
 public static int CaseId {
  get{return caseId;}
  set{caseId=value;Console.Error.WriteLine("VI_CLIP_STAGE case "+value);}
 }
 public static IntPtr RestoreSetter(uint format,IntPtr data){
  if(Writes==FailAfter)throw new InvalidOperationException("Controlled restore setter failure.");
  IntPtr result=RealSetter(format,data);if(result!=IntPtr.Zero)Writes++;return result;
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
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Fault-Code($Exception){
    while($Exception.InnerException){$Exception=$Exception.InnerException}
    if($Exception -is [ViClipboard.ClipboardPreparationException]){return $Exception.Code}
    throw $Exception
}
function Report-TransactionFault([string]$Phase,$Exception){
    while($Exception.InnerException){$Exception=$Exception.InnerException}
    if($Exception -is [ViClipboard.ClipboardPreparationException]){
        [Console]::Error.WriteLine("VI_CLIP_FAILURE $Phase case=$([OwnedClipboardFixture]::CaseId) code=$($Exception.Code) stage=$($Exception.Stage) format=$($Exception.Format) nativeError=$($Exception.NativeCode)")
        if($Exception.Stage -eq 'restore-sequence'){
            [Console]::Error.WriteLine("VI_CLIP_SEQUENCE expected=$($Exception.ExpectedSequence) current=$($Exception.CurrentSequence) ownerMatch=True")
        }
    }else{
        [Console]::Error.WriteLine("VI_CLIP_FAILURE $Phase case=$([OwnedClipboardFixture]::CaseId) code=fixture-assertion")
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
        try{
            $failed=$false
            try{$transaction.Begin('Must not replace discarded data')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-format'}
            Check $failed 'Published discarded metadata was not rejected.'
            Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before) 'Discarded metadata rejection changed the clipboard.'
            Check ([OwnedClipboardFixture]::IsClipboardFormatAvailable($format)) 'Discarded metadata was removed.'
        }finally{$transaction.Dispose()}
        $zeroOutcome='clipboard-format'
    }
    $checks.Add('zero-allocation-real-setclipboarddata-contract-recorded')
    [OwnedClipboardFixture]::CaseId=2
    $fixture.AdvertiseUnrenderable($format)
    $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
    $transaction=[TranscriptClipboard]::new()
    try{
        $failed=$false
        try{$transaction.Begin('Must not replace unrenderable data')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-format'}
        Check $failed 'Unbacked delayed metadata was not rejected.'
        Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before) 'Unrenderable metadata rejection changed the clipboard.'
        Check ([OwnedClipboardFixture]::IsClipboardFormatAvailable($format)) 'Unrenderable metadata was removed.'
    }finally{$transaction.Dispose()}
    $checks.Add('unbacked-metadata-fails-closed-without-mutation')
    foreach($empty in @($false,$true)){
        [OwnedClipboardFixture]::CaseId=3+[int]$empty
        if($empty){$fixture.Put([uint32[]]@(),[byte[][]]@())}
        else{
            $fixture.Put([uint32[]]@(13,$format,$rich),[byte[][]]@($text,[byte[]]@(0),$html))
            $expected=Read-Mixed $fixture $format $rich
        }
        $transaction=[TranscriptClipboard]::new()
        try{
            $transaction.Begin('Approved fixture result')
            Check ([Windows.Forms.Clipboard]::GetText() -eq 'Approved fixture result') 'Delayed render did not expose the approved text.'
            $transaction.Restore()
            if($empty){Check ([OwnedClipboardFixture]::CountClipboardFormats() -eq 0) 'Empty clipboard formats were not restored.'}
            else{
                $restored=Read-Mixed $fixture $format $rich
                Check ($restored.text -eq $expected.text) 'Unicode bytes changed.'
                Check ($restored.metadata -eq $expected.metadata) 'Zero-valued registered metadata bytes changed.'
                Check ($restored.rich -eq $expected.rich) 'Rich format bytes changed.'
            }
        }finally{$transaction.Dispose()}
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
            Report-TransactionFault 'operation' $operationFailure
            throw
        }finally{
            try{$transaction.Dispose()}catch{
                $cleanupFailure=$_.Exception
                Report-TransactionFault 'cleanup' $cleanupFailure
                if($operationFailure){
                    throw [AggregateException]::new('Owned transaction operation and cleanup both failed.',
                        [Exception[]]@($operationFailure,$cleanupFailure))
                }
                throw
            }
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
    try{
        $failed=$false
        try{$transaction.Begin('Must not replace virtual file data')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-format'}
        Check $failed 'Declared OLE virtual-file data did not fail closed.'
        Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before) 'Rejected OLE producer was modified.'
    }finally{$transaction.Dispose()}
    $checks.Add('ole-virtual-file-contract-fails-closed-before-data-access')
    [OwnedClipboardFixture]::CaseId=7
    $bitmap=[Drawing.Bitmap]::new(8,8)
    $bitmap.SetPixel(3,3,[Drawing.Color]::FromArgb(255,17,99,201))
    try{
        [Windows.Forms.Clipboard]::SetImage($bitmap)
        $transaction=[TranscriptClipboard]::new()
        try{$transaction.Begin('Approved image fixture');$transaction.Restore()}finally{$transaction.Dispose()}
        $image=[Windows.Forms.Clipboard]::GetImage()
        try{Check ($image.GetPixel(3,3).ToArgb() -eq $bitmap.GetPixel(3,3).ToArgb()) 'Image pixels were not preserved.'}
        finally{$image.Dispose()}
    }finally{$bitmap.Dispose()}
    $checks.Add('image-pixel-preservation')
    [OwnedClipboardFixture]::CaseId=8
    $fixture.Put([uint32[]]@(13),[byte[][]]@($text))
    $expectedText=[Convert]::ToBase64String($fixture.Read(13))
    $fixture.Hold(80)
    $transaction=[TranscriptClipboard]::new()
    try{$transaction.Begin('Approved after transient lock');$transaction.Restore()}finally{$transaction.Dispose()}
    Check ([Convert]::ToBase64String($fixture.Read(13)) -eq $expectedText) 'Transient lock recovery changed clipboard bytes.'
    $checks.Add('transient-lock-recovers-without-content-loss')
    [OwnedClipboardFixture]::CaseId=9
    $fixture.Hold(600)
    $transaction=[TranscriptClipboard]::new()
    try{
        $failed=$false
        try{$transaction.Begin('Must not replace busy clipboard')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-busy'}
        Check $failed 'Persistent lock was not classified busy.'
    }finally{$transaction.Dispose()}
    Start-Sleep -Milliseconds 650
    Check ([Convert]::ToBase64String($fixture.Read(13)) -eq $expectedText) 'Busy failure changed clipboard bytes.'
    $checks.Add('busy-fails-closed')
    [OwnedClipboardFixture]::CaseId=10
    $fixture.Put([uint32[]]@(13,0x200),[byte[][]]@($text,[byte[]]@(1,2,3)))
    $before=[OwnedClipboardFixture]::GetClipboardSequenceNumber()
    $transaction=[TranscriptClipboard]::new()
    try{
        $failed=$false
        try{$transaction.Begin('Must not replace unpreservable clipboard')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-format'}
        Check $failed 'Unpreservable owner-specific format was not rejected.'
        Check ([OwnedClipboardFixture]::GetClipboardSequenceNumber() -eq $before) 'Unsupported-format failure changed the clipboard.'
    }finally{$transaction.Dispose()}
    $checks.Add('unsupported-format-fails-without-mutation')
    [OwnedClipboardFixture]::CaseId=11
    $fixture.Put([uint32[]]@(13),[byte[][]]@($text))
    $transaction=[TranscriptClipboard]::new()
    try{
        $transaction.Begin('Approved cancelled result')
        [void][Windows.Forms.Clipboard]::GetText()
        Check $transaction.RenderedBeforePaste 'Early clipboard reader was not recorded.'
        $transaction.PasteStarted()
        $transaction.PasteFinished()
        Check ($transaction.WaitForRead()) 'Rendered clipboard data was not retained for a late reader.'
        Check ($transaction.HoldMilliseconds -ge 1000) 'Early history-style read shortened the existing minimum hold.'
        $fixture.Put([uint32[]]@(13),[byte[][]]@([Text.Encoding]::Unicode.GetBytes("New user copy`0")))
        $transaction.Restore()
        Check ([Windows.Forms.Clipboard]::GetText() -eq 'New user copy') 'A newer clipboard copy was overwritten.'
    }finally{$transaction.Dispose()}
    $checks.Add('early-reader-and-new-copy-win')
    [OwnedClipboardFixture]::CaseId=12
    $transaction=[TranscriptClipboard]::new()
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
    }finally{$transaction.Dispose()}
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
        try{
            $transaction.Begin('Approved partial restore fixture')
            [OwnedClipboardFixture]::FailAfter=$after
            [OwnedClipboardFixture]::Writes=0
            $setter.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('RestoreSetter')))
            $failed=$false
            try{$transaction.Dispose()}catch{$failed=(Fault-Code $_.Exception) -eq 'restore-failed'}
            Check $failed 'Controlled mid-restore failure did not retain the transaction.'
            Check ([OwnedClipboardFixture]::Writes -eq $after) 'Restore seam failed at a different mutation boundary.'
            $sequence=[TranscriptClipboard].GetField('sequence',[Reflection.BindingFlags]'Instance,NonPublic').GetValue($transaction)
            Check ($sequence -eq [OwnedClipboardFixture]::GetClipboardSequenceNumber()) 'Own partial restoration was not attributed under the lock.'
            [OwnedClipboardFixture]::RenderAll($transaction.Handle)
            if($after -eq 0){
                Check ([OwnedClipboardFixture]::CountClipboardFormats() -eq 0) 'Late rendering reintroduced data after empty restore.'
            }else{
                Check ([Convert]::ToBase64String($fixture.Read(16)) -eq $expectedLocale) 'Partial restoration did not preserve the saved locale prelude.'
                if($after -eq 1){Check (-not [OwnedClipboardFixture]::IsClipboardFormatAvailable(13)) 'Late rendering reintroduced the temporary transcript after the locale prelude.'}
                else{Check ([Convert]::ToBase64String($fixture.Read(13)) -eq $expected.text) 'Late rendering changed the restored first text format.'}
            }
            $setter.SetValue($null,$original)
            [TranscriptClipboard]::RecoverPending()
            $restored=Read-Mixed $fixture $format $rich
            Check ($restored.text -eq $expected.text) 'Mid-restore recovery lost the original Unicode bytes.'
            Check ($restored.metadata -eq $expected.metadata) 'Mid-restore recovery lost zero-valued metadata bytes.'
            Check ($restored.rich -eq $expected.rich) 'Mid-restore recovery lost rich bytes.'
            Check ([Convert]::ToBase64String($fixture.Read(16)) -eq $expectedLocale) 'Mid-restore recovery lost the original locale bytes.'
        }finally{$setter.SetValue($null,$original);$transaction.Dispose()}
    }
    $checks.Add('actual-empty-and-first-format-restore-faults-recover-all-original-bytes')
    [OwnedClipboardFixture]::CaseId=16
    $fixture.Put([uint32[]]@(13,$rich,16),[byte[][]]@($text,$html,[BitConverter]::GetBytes([uint32]1031)))
    $transaction=[TranscriptClipboard]::new()
    try{
        $transaction.Begin('Must never be repasted')
        [OwnedClipboardFixture]::FailAfter=2
        [OwnedClipboardFixture]::Writes=0
        $setter.SetValue($null,[Delegate]::CreateDelegate([Func[uint32,IntPtr,IntPtr]],[OwnedClipboardFixture].GetMethod('RestoreSetter')))
        try{$transaction.Dispose()}catch{Check ((Fault-Code $_.Exception) -eq 'restore-failed') 'Unexpected restore failure.'}
        Check ([OwnedClipboardFixture]::Writes -eq 2) 'External-copy fixture did not reach restored locale and first text.'
        $setter.SetValue($null,$original)
        $fixture.Put([uint32[]]@(13),[byte[][]]@([Text.Encoding]::Unicode.GetBytes("New external copy wins`0")))
        [TranscriptClipboard]::RecoverPending()
        Check ([Windows.Forms.Clipboard]::GetText() -eq 'New external copy wins') 'Deferred backup overwrote a genuinely newer external copy.'
    }finally{$setter.SetValue($null,$original);$transaction.Dispose()}
    $checks.Add('external-new-copy-wins-after-partial-restore')
    [OwnedClipboardFixture]::CaseId=17
    $fixture.Put([uint32[]]@(13),[byte[][]]@($text))
    $transaction=[TranscriptClipboard]::new()
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
        $fixture.Put([uint32[]]@(13),[byte[][]]@([Text.Encoding]::Unicode.GetBytes("New copy after unknown mutation`0")))
        [TranscriptClipboard]::RecoverPending()
        Check ([Windows.Forms.Clipboard]::GetText() -eq 'New copy after unknown mutation') 'Pending backup overwrote a newer external copy.'
    }finally{$transaction.Dispose()}
    $checks.Add('unknown-same-owner-mutation-is-not-laundered-by-own-rendering')
    @{status='passed';checks=@($checks);zeroAllocation=$zero;zeroAllocationOutcome=$zeroOutcome;clipboardData='CI-owned synthetic only';inputEventsSent=0}|ConvertTo-Json -Compress
}finally{$fixture.Dispose()}
