# Build the role-based user manuals: documents\*.html -> .docx + .pdf
#
# Word is the converter (it is already installed, and it is the only thing that
# reads our HTML and writes a real .docx). Driving it over COM keeps the HTML as
# the single source of truth: edit the .html, re-run this, and both output
# formats regenerate together and stay identical to each other.
#
#   powershell -File scripts/build-manuals.ps1
#   powershell -File scripts/build-manuals.ps1 -Only kra-kpi-admin-manual

param(
  # Build one manual instead of all three. Basename, no extension.
  [string]$Only = ''
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$docs = Join-Path $repo 'documents'
if (-not (Test-Path $docs)) { throw "No documents folder at $docs" }

$sources = Get-ChildItem (Join-Path $docs '*.html') | Sort-Object Name
if ($Only) { $sources = $sources | Where-Object { $_.BaseName -eq $Only } }
if (-not $sources) { throw "No matching .html sources in $docs" }

# Word format codes (WdSaveFormat).
$wdFormatDocumentDefault = 16   # .docx
$wdFormatPDF             = 17   # .pdf

Write-Host "Converting $($sources.Count) manual(s) via Word..." -ForegroundColor Cyan

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0          # wdAlertsNone - never block on a dialog

try {
  foreach ($src in $sources) {
    $base = Join-Path $src.DirectoryName $src.BaseName
    Write-Host "  $($src.Name)" -NoNewline

    # ReadOnly + AddToRecentFiles:false so building never mutates the source
    # or clutters Word's MRU list.
    $doc = $word.Documents.Open($src.FullName, $false, $true, $false)
    try {
      # No $doc.Convert() here: it throws "This command is not available" on a
      # read-only document, and SaveAs2 with wdFormatDocumentDefault already
      # writes a real .docx rather than a renamed web archive.
      $doc.SaveAs2("$base.docx", $wdFormatDocumentDefault)

      # PDF via ExportAsFixedFormat rather than SaveAs2: it exposes OptimizeFor,
      # and screen-optimised output is a fraction of the size. These PDFs get
      # downloaded over mobile data from the in-app User Manual screen, so the
      # saving matters. Args: path, format(17=PDF), openAfter, optimizeFor
      # (1 = wdExportOptimizeForOnScreen).
      $doc.ExportAsFixedFormat("$base.pdf", $wdFormatPDF, $false, 1)
    } finally {
      $doc.Close($false)
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
    }
    Write-Host "  ->  .docx + .pdf" -ForegroundColor Green
  }
} finally {
  # Always quit, or a headless WINWORD.EXE is left running and the next build
  # silently attaches to it.
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

Write-Host "`nDone. Output in $docs" -ForegroundColor Cyan
Get-ChildItem (Join-Path $docs '*.docx'), (Join-Path $docs '*.pdf') |
  Sort-Object Name |
  Format-Table Name, @{N = 'KB'; E = { [math]::Round($_.Length / 1KB, 1) } }, LastWriteTime -AutoSize
