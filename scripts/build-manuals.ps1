# Build the role-based user manuals: documents\*.html -> .docx
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

Write-Host "Converting $($sources.Count) manual(s) via Word..." -ForegroundColor Cyan

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0          # wdAlertsNone - never block on a dialog

try {
  foreach ($src in $sources) {
    $base = Join-Path $src.DirectoryName $src.BaseName
    Write-Host "  $($src.Name)" -NoNewline

    # NOT ReadOnly, deliberately. Word imports <img> from HTML as LINKED
    # pictures, and the links have to be broken below before saving -- which it
    # refuses to do on a read-only document. The source is still never written:
    # SaveAs2 re-points the document at the .docx, so the Close($false) in the
    # finally block cannot touch the .html.
    # AddToRecentFiles:false just keeps Word's MRU list clean.
    $doc = $word.Documents.Open($src.FullName, $false, $false, $false)
    try {
      # EMBED THE IMAGES. Opening HTML gives linked pictures, so the .docx only
      # holds file paths -- 0 bytes of image data. It looks fine on the machine
      # that built it and shows red X placeholders everywhere the moment it is
      # emailed or the screenshots folder moves. Verified: before this, the
      # built files had word/media = 0 and 15/21/11 r:link entries.
      #
      # SavePictureWithDocument copies the bytes in; BreakLink then turns the
      # linked picture into a plain embedded one. Iterated BACKWARDS because
      # breaking a link re-indexes the collection.
      for ($i = $doc.InlineShapes.Count; $i -ge 1; $i--) {
        $shape = $doc.InlineShapes.Item($i)
        if ($null -ne $shape.LinkFormat) {
          $shape.LinkFormat.SavePictureWithDocument = $true
          $shape.LinkFormat.BreakLink()
        }
      }

      # No $doc.Convert() here: it throws "This command is not available" on a
      # read-only document, and SaveAs2 with wdFormatDocumentDefault already
      # writes a real .docx rather than a renamed web archive.
      $doc.SaveAs2("$base.docx", $wdFormatDocumentDefault)

      # No PDF: Word is the only output wanted. Nothing linked to the PDFs that
      # used to be written beside these files -- the in-app User Manual screen
      # serves whatever an admin uploads into kpi.user.manual, not this folder.
    } finally {
      $doc.Close($false)
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
    }
    Write-Host "  ->  .docx" -ForegroundColor Green
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
Get-ChildItem (Join-Path $docs '*.docx') |
  Sort-Object Name |
  Format-Table Name, @{N = 'KB'; E = { [math]::Round($_.Length / 1KB, 1) } }, LastWriteTime -AutoSize
