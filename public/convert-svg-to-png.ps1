# convert-svg-to-png.ps1

# --- CONFIG ---
$Source     = ".\icons\ion"       # where your SVGs are
$OutDir     = ".\icons\ion-png"   # output PNG folder
$Size       = 24                  # export width/height in px
# -------------

# Prefer the console binary (prints output); fallback to GUI exe
$Inkscape = @(
  "C:\Program Files\Inkscape\bin\inkscape.com",
  "C:\Program Files\Inkscape\bin\inkscape.exe",
  "C:\Program Files (x86)\Inkscape\bin\inkscape.com",
  "C:\Program Files (x86)\Inkscape\bin\inkscape.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $Inkscape) {
  Write-Error "Inkscape not found. Edit paths if installed elsewhere."
  exit 1
}
Write-Host "Using Inkscape → $Inkscape"

# Ensure output directory exists
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Get all SVG files
$svgs = Get-ChildItem -Path $Source -Filter *.svg -Recurse
if ($svgs.Count -eq 0) {
  Write-Warning "No SVG files found in $Source"
  exit 0
}

# Regex prepared once (replace FIRST <svg ...> only)
$regex = New-Object System.Text.RegularExpressions.Regex('<svg([^>]*)>', [System.Text.RegularExpressions.RegexOptions]::Singleline)

foreach ($svg in $svgs) {
  $inFull = $svg.FullName
  $rel    = $inFull.Substring((Resolve-Path $Source).Path.Length).TrimStart('\','/')
  $outPng = Join-Path $OutDir ($rel -replace '\.svg$','.png')

  # Ensure output subfolder exists
  New-Item -ItemType Directory -Force -Path (Split-Path $outPng) | Out-Null

  # Create a temporary modified SVG with forced white fill
  $tmpDir = Join-Path $env:TEMP "svg-white-export"
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $tmpSvg = Join-Path $tmpDir ([IO.Path]::GetFileName($inFull))

  $content  = Get-Content -Raw -Encoding UTF8 $inFull
  $styleTag = "<style>*{fill:#fff !important;stroke:#fff !important;}</style>"

  if ($regex.IsMatch($content)) {
    # Replace only the FIRST <svg ...> with an injected style
    $content = $regex.Replace($content, '<svg$1>' + $styleTag, 1)
  } else {
    # Fallback: prepend style (very rare malformed svg)
    $content = "<svg>$styleTag</svg>" + $content
  }

  Set-Content -Path $tmpSvg -Value $content -Encoding UTF8

  # Convert using Inkscape
  & "$Inkscape" "$tmpSvg" `
      --export-type=png `
      --export-width=$Size `
      --export-height=$Size `
      --export-filename="$outPng" | Out-Null

  if ($LASTEXITCODE -eq 0) {
    Write-Host "Converted: $rel → $(Split-Path $outPng -Leaf)"
  } else {
    Write-Warning "Failed: $rel (exit $LASTEXITCODE)"
  }

  # Cleanup temp file
  Remove-Item $tmpSvg -Force -ErrorAction SilentlyContinue
}

Write-Host "`nDone! White PNGs are in: $OutDir"
