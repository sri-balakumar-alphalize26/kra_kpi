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

      # STOP THINGS BREAKING ACROSS PAGES. HTML carries no pagination, so the
      # imported document had NOTHING holding it together -- measured on the
      # built file: keepNext 0, keepLines 0, cantSplit 0, tblHeader 0. That is
      # why a table row came out half on one page and half on the next, and why
      # a heading could sit alone at the foot of a page with its section
      # overleaf. None of this changes a word of content; it only decides where
      # Word is allowed to cut.

      # 1. Widow/orphan control across the whole body, in one call rather than
      #    per paragraph. Stops a lone first/last line stranded on its own page.
      $doc.Content.ParagraphFormat.WidowControl = $true

      # 2. Headings stay with what they introduce. Set on the STYLE so it holds
      #    for every heading, including any added later. The numeric constants
      #    are wdStyleHeading1/2/3 -- names are localised, these are not.
      foreach ($h in @(-2, -3, -4)) {
        $hs = $doc.Styles.Item($h).ParagraphFormat
        $hs.KeepWithNext = $true
        $hs.KeepTogether = $true
      }

      foreach ($tbl in $doc.Tables) {
        # 3. A row is an atom. This is the one that produced the reported
        #    "half here, remainder on the next page" -- a figure and its caption
        #    share a cell, so without this the picture and its own caption could
        #    land on different pages.
        $tbl.Rows.AllowBreakAcrossPages = $false

        # 4. Repeat the header row when a real data table does span pages, so
        #    the continuation is still readable. Only tables big enough to have
        #    a header: the figure and callout boxes are single-row, and marking
        #    their only row as a heading would repeat the whole box.
        if ($tbl.Rows.Count -ge 3) { $tbl.Rows.Item(1).HeadingFormat = $true }
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
