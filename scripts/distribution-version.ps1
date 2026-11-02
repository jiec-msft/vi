param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$Version,[switch]$ReadOnly)
$ErrorActionPreference='Stop'
if($Version -notmatch '^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-preview(?:\.\d+)?)?$'){throw 'Unsupported distribution version.'}
$major=[uint32]$Matches[1];$minor=[uint32]$Matches[2];$patch=[uint32]$Matches[3]
if($ReadOnly){
    $actual=[Diagnostics.FileVersionInfo]::GetVersionInfo([IO.Path]::GetFullPath($Executable))
    @{file=$actual.FileVersion;product=$actual.ProductVersion;name=$actual.ProductName}|ConvertTo-Json -Compress
    exit
}
$originalCopyright=(Get-Item -LiteralPath $Executable).VersionInfo.LegalCopyright
if((Get-AuthenticodeSignature -LiteralPath $Executable).Status -ne 'NotSigned'){
    throw 'Resource editing requires the unsigned generic Windows Electron runtime.'
}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
public static class DistributionVersion {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr BeginUpdateResourceW(string file,bool remove);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool UpdateResourceW(IntPtr handle,IntPtr type,IntPtr name,ushort language,byte[] data,uint bytes);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool EndUpdateResourceW(IntPtr handle,bool discard);
 static byte[] Block(string key,ushort type,byte[] value,ushort valueLength,params byte[][] children) {
  using(var stream=new MemoryStream())using(var writer=new BinaryWriter(stream)) {
   writer.Write((ushort)0);writer.Write(valueLength);writer.Write(type);
   writer.Write(Encoding.Unicode.GetBytes(key+"\0"));while(stream.Length%4!=0)writer.Write((byte)0);
   writer.Write(value);foreach(var child in children){while(stream.Length%4!=0)writer.Write((byte)0);writer.Write(child);}
   if(stream.Length>65535)throw new InvalidOperationException("Version resource exceeds its bound.");
   var bytes=stream.ToArray();bytes[0]=(byte)bytes.Length;bytes[1]=(byte)(bytes.Length>>8);return bytes;
  }
 }
 static byte[] Text(string key,string value){return Block(key,1,Encoding.Unicode.GetBytes(value+"\0"),(ushort)(value.Length+1));}
 public static void Set(string file,uint major,uint minor,uint patch,string display,string copyright) {
  byte[] fixedInfo;
  using(var stream=new MemoryStream())using(var writer=new BinaryWriter(stream)){
   foreach(uint value in new uint[]{0xfeef04bd,0x10000,(major<<16)|minor,patch<<16,(major<<16)|minor,patch<<16,0x3f,0,0x40004,1,0,0,0})writer.Write(value);
   fixedInfo=stream.ToArray();
  }
  string numeric=major+"."+minor+"."+patch+".0";
  var strings=Block("StringFileInfo",1,new byte[0],0,
   Block("040904B0",1,new byte[0],0,Text("FileVersion",numeric),Text("ProductVersion",display),
    Text("FileDescription","VI"),Text("ProductName","VI"),Text("InternalName","VI"),Text("OriginalFilename","VI.exe"),
    Text("LegalCopyright",copyright??"")));
  var translation=Block("VarFileInfo",1,new byte[0],0,Block("Translation",0,new byte[]{9,4,0xb0,4},4));
  var resource=Block("VS_VERSION_INFO",0,fixedInfo,(ushort)fixedInfo.Length,strings,translation);
  IntPtr update=BeginUpdateResourceW(file,false);if(update==IntPtr.Zero)throw new InvalidOperationException("Cannot begin version resource update.");
  bool completed=false;
  try{
   if(!UpdateResourceW(update,new IntPtr(16),new IntPtr(1),1033,resource,(uint)resource.Length))throw new InvalidOperationException("Cannot update version resource.");
   completed=EndUpdateResourceW(update,false);
   update=IntPtr.Zero;
   if(!completed)throw new InvalidOperationException("Cannot commit version resource.");
  }finally{if(update!=IntPtr.Zero)EndUpdateResourceW(update,true);}
 }
}
'@
[DistributionVersion]::Set([IO.Path]::GetFullPath($Executable),$major,$minor,$patch,$Version,$originalCopyright)
$actual=(Get-Item -LiteralPath $Executable).VersionInfo
if($actual.FileVersion -ne "$major.$minor.$patch.0" -or $actual.ProductVersion -ne $Version -or $actual.ProductName -ne 'VI'){
    throw 'Generated executable version metadata did not match.'
}
