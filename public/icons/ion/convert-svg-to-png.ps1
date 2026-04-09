# convert-svg-to-png.ps1
$Source = ".\icons\ion"
$OutDir = ".\icons\ion-png"  # or reuse $Source if you want to overwrite
$Size   = 20                 # target pixel size (width & height)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Get-ChildItem -Path $Source -Filter *.svg -Recurse | ForEach-Object {
  $in  = $_.FullName
  $rel = $_.FullName.Substring($Source.Length).TrimStart('\','/')
  $out = Join-Path $OutDir ($rel -replace '\.svg$','.png')

  # ensure subfolders exist
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

  # Inkscape export
  inkscape "$in" --export-type=png --export-width=$Size --export-height=$Size --export-filename="$out"
  Write-Host "OK  $rel -> $(Resolve-Path $out -Relative)"
}
