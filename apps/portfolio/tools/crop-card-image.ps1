<#
.SYNOPSIS
    Produce a portfolio card image at the exact size the card renders.

.DESCRIPTION
    The site is a static export with no image optimiser, so whatever lands in
    public/work/ is what a visitor downloads. This crops to the card's 16:10
    from the centre and re-encodes at a sensible quality, which is the whole
    job — an 8 MB camera original behind a 560 px card is the single easiest
    way to make a site about fast websites load slowly.

    Centre-cropping is a guess. Check the result before committing it; if the
    subject sits off-centre, crop it by hand instead.

.PARAMETER Source
    Path to the source photograph. Anything System.Drawing can open.

.PARAMETER Slug
    The `slug` of the entry in src/data/work.ts. Determines the output
    filename, so the two stay in step.

.EXAMPLE
    powershell -File tools/crop-card-image.ps1 -Source C:\photos\shop.jpg -Slug corner-bakery
#>
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Slug,
    [int]$Width = 1120,
    [int]$Height = 700,
    [int]$Quality = 82
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Source)) { throw "Source not found: $Source" }

$outDir = Join-Path $PSScriptRoot '..\public\work'
$outDir = [System.IO.Path]::GetFullPath($outDir)
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$dest = Join-Path $outDir "$Slug.jpg"

$img = [System.Drawing.Image]::FromFile($Source)
try {
    $targetRatio = $Width / $Height
    $srcRatio = $img.Width / $img.Height

    # Take the largest centred rectangle of the source that matches the target
    # aspect, then scale it down. Cropping first avoids the squash that
    # scaling straight to the target size would produce.
    if ($srcRatio -gt $targetRatio) {
        $cropH = $img.Height
        $cropW = [int]($img.Height * $targetRatio)
    }
    else {
        $cropW = $img.Width
        $cropH = [int]($img.Width / $targetRatio)
    }
    $cropX = [int](($img.Width - $cropW) / 2)
    $cropY = [int](($img.Height - $cropH) / 2)

    $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $rect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
            $g.DrawImage($img, $rect, $cropX, $cropY, $cropW, $cropH, [System.Drawing.GraphicsUnit]::Pixel)
        }
        finally { $g.Dispose() }

        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
            Where-Object { $_.MimeType -eq 'image/jpeg' }
        $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, $Quality)
        $bmp.Save($dest, $codec, $ep)
    }
    finally { $bmp.Dispose() }
}
finally { $img.Dispose() }

$kb = [math]::Round((Get-Item $dest).Length / 1KB)
Write-Host "Wrote $dest  ($Width x $Height, $kb KB)"
if ($kb -gt 250) {
    Write-Warning "Over 250 KB. Lower -Quality, or start from a smaller source."
}
