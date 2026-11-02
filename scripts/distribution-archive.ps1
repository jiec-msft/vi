param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Zip,
    [ValidateSet('create','extract')][string]$Action='create')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
$Root=[IO.Path]::GetFullPath($Root)
if($Action -eq 'extract'){
    if(Test-Path -LiteralPath $Root){throw 'Fresh distribution extraction requires a new directory.'}
    Expand-Archive -LiteralPath $Zip -DestinationPath $Root -ErrorAction Stop
    exit
}
if(Test-Path -LiteralPath $Zip){throw 'Distribution archives must be new files.'}
if(@(Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
}).Count){throw 'Windows neutral bases cannot contain reparse points.'}
$files=@(Get-ChildItem -LiteralPath $Root -File -Recurse -Force)
[long]$zip32Budget=4026531840
[long]$totalBytes=($files | Measure-Object Length -Sum).Sum
if($files.Count -eq 0 -or $files.Count -ge 65535 -or $totalBytes -lt 0 -or $totalBytes -ge $zip32Budget){
    throw "The neutral Windows payload must fit ZIP32 (files=$($files.Count), bytes=$totalBytes, limit=$zip32Budget)."
}
$names=@{}
$stream=[IO.File]::Open($Zip,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
    $archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
    try{
        foreach($file in $files | Sort-Object FullName){
            $relative=$file.FullName.Substring($Root.Length+1).Replace('\','/')
            if($file.Attributes -band [IO.FileAttributes]::ReparsePoint -or $relative -match '(^|/)\.\.?(/|$)|[\\:<>"|?*\x00-\x1f]' -or
                $relative -match '(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|/|$)|[ .](/|$)' -or
                $relative.StartsWith('/') -or $names.ContainsKey($relative.ToLowerInvariant())){
                throw 'Unsafe or case-colliding neutral archive entry.'
            }
            $names[$relative.ToLowerInvariant()]=$true
            $entry=$archive.CreateEntry($relative,[IO.Compression.CompressionLevel]::Optimal)
            $entry.ExternalAttributes=0
            $entry.LastWriteTime=[DateTimeOffset]::new(2026,1,1,0,0,0,[TimeSpan]::Zero)
            $input=$file.OpenRead()
            try{
                $output=$entry.Open()
                try{$input.CopyTo($output)}finally{$output.Dispose()}
            }finally{$input.Dispose()}
        }
    }finally{$archive.Dispose()}
}finally{$stream.Dispose()}
@{files=$files.Count;uncompressedBytes=$totalBytes;zip32Budget=$zip32Budget}|ConvertTo-Json -Compress
