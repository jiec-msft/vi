param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$file=[IO.File]::ReadAllText((Join-Path $Source 'windows-delivery.ps1'))
$match=[regex]::Match($file,"(?s)\`$clipboardSource=@'\r?\n(.*?)\r?\n'@")
if(-not $match.Success){throw 'Actual clipboard transaction source was not found.'}
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition (
    $match.Groups[1].Value+[IO.File]::ReadAllText((Join-Path $Source 'windows-clipboard-snapshot.cs')))
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class OwnedClipboardFixture : NativeWindow, IDisposable {
 readonly List<IntPtr> privateMemory=new List<IntPtr>();
 [DllImport("user32.dll")]static extern bool OpenClipboard(IntPtr owner);
 [DllImport("user32.dll")]static extern bool CloseClipboard();
 [DllImport("user32.dll")]static extern bool EmptyClipboard();
 [DllImport("user32.dll")]static extern IntPtr SetClipboardData(uint format,IntPtr data);
 [DllImport("user32.dll")]static extern IntPtr GetClipboardData(uint format);
 [DllImport("user32.dll")]public static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern uint RegisterClipboardFormat(string name);
 [DllImport("kernel32.dll")]static extern IntPtr GlobalAlloc(uint flags,UIntPtr size);
 [DllImport("kernel32.dll")]static extern IntPtr GlobalLock(IntPtr data);
 [DllImport("kernel32.dll")]static extern bool GlobalUnlock(IntPtr data);
 [DllImport("kernel32.dll")]static extern UIntPtr GlobalSize(IntPtr data);
 [DllImport("kernel32.dll")]static extern IntPtr GlobalFree(IntPtr data);
 public OwnedClipboardFixture(){CreateHandle(new CreateParams{Parent=new IntPtr(-3)});}
 public void Put(uint[] formats,byte[][] payloads){
  if(!OpenClipboard(Handle))throw new Exception("Owned fixture clipboard lock failed.");
  try{
   if(!EmptyClipboard())throw new Exception("Owned fixture reset failed.");
   foreach(var memory in privateMemory)GlobalFree(memory);privateMemory.Clear();
   for(int i=0;i<formats.Length;i++){
    IntPtr memory=GlobalAlloc(0x42,new UIntPtr((uint)payloads[i].Length));
    if(memory==IntPtr.Zero)throw new Exception("Owned fixture allocation failed.");
    if(payloads[i].Length>0){
     IntPtr pointer=GlobalLock(memory);
     if(pointer==IntPtr.Zero)throw new Exception("Owned fixture memory lock failed.");
     try{Marshal.Copy(payloads[i],0,pointer,payloads[i].Length);}finally{GlobalUnlock(memory);}
    }
    if(SetClipboardData(formats[i],memory)==IntPtr.Zero){GlobalFree(memory);throw new Exception("Owned fixture write failed.");}
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
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Fault-Code($Exception){
    while($Exception.InnerException){$Exception=$Exception.InnerException}
    if($Exception -is [ViClipboard.ClipboardPreparationException]){return $Exception.Code}
    throw $Exception
}
$fixture=[OwnedClipboardFixture]::new()
$text=[Text.Encoding]::Unicode.GetBytes("Owned Unicode sample`0")
$html=[Text.Encoding]::UTF8.GetBytes('Owned synthetic HTML fragment')
$format=[OwnedClipboardFixture]::RegisterClipboardFormat('VI synthetic metadata')
$rich=[OwnedClipboardFixture]::RegisterClipboardFormat('HTML Format')
$checks=[Collections.Generic.List[string]]::new()
try{
    foreach($empty in @($false,$true)){
        if($empty){$fixture.Put([uint32[]]@(),[byte[][]]@())}
        else{$fixture.Put([uint32[]]@(13,$format,$rich),[byte[][]]@($text,[byte[]]@(),$html))}
        $transaction=[TranscriptClipboard]::new()
        try{
            $transaction.Begin('Approved fixture result')
            Check ([Windows.Forms.Clipboard]::GetText() -eq 'Approved fixture result') 'Delayed render did not expose the approved text.'
            $transaction.Restore()
            if($empty){Check ([Windows.Forms.Clipboard]::GetText() -eq '') 'Empty clipboard was not restored.'}
            else{
                Check ([Convert]::ToBase64String($fixture.Read(13)) -eq [Convert]::ToBase64String($text)) 'Unicode bytes changed.'
                Check ($fixture.Read($format).Length -eq 0) 'Empty registered metadata was lost.'
                Check ([Convert]::ToBase64String($fixture.Read($rich)) -eq [Convert]::ToBase64String($html)) 'Rich format bytes changed.'
            }
        }finally{$transaction.Dispose()}
        if($empty){Check ([Windows.Forms.Clipboard]::GetText() -eq '') 'Disposal reintroduced the temporary transcript.'}
        else{Check ([Convert]::ToBase64String($fixture.Read(13)) -eq [Convert]::ToBase64String($text)) 'Disposal changed the restored Unicode bytes.'}
    }
    $checks.Add('empty-unicode-rich-zero-metadata-native-roundtrip')
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
    $fixture.Put([uint32[]]@(13),[byte[][]]@($text))
    $fixture.Hold(80)
    $transaction=[TranscriptClipboard]::new()
    try{$transaction.Begin('Approved after transient lock');$transaction.Restore()}finally{$transaction.Dispose()}
    $checks.Add('transient-lock-recovers-without-content-loss')
    $fixture.Hold(600)
    $transaction=[TranscriptClipboard]::new()
    try{
        $failed=$false
        try{$transaction.Begin('Must not replace busy clipboard')}catch{$failed=(Fault-Code $_.Exception) -eq 'clipboard-busy'}
        Check $failed 'Persistent lock was not classified busy.'
    }finally{$transaction.Dispose()}
    Start-Sleep -Milliseconds 650
    Check ([Convert]::ToBase64String($fixture.Read(13)) -eq [Convert]::ToBase64String($text)) 'Busy failure changed clipboard bytes.'
    $checks.Add('busy-fails-closed')
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
    }finally{$transaction.Dispose()}
    $checks.Add('restore-failure-is-explicit-and-backup-retained')
    @{status='passed';checks=@($checks);clipboardData='CI-owned synthetic only';inputEventsSent=0}|ConvertTo-Json -Compress
}finally{$fixture.Dispose()}
