# Prompt — build a complete end-user manual

Paste the fenced block into a fresh session and fill the three `<<< >>>` slots.

It produces a Word manual in this project's house style via a python-docx pipeline.
The gotchas are the expensive part: each one below is a failure that hangs the build or
silently cancels formatting, and none is obvious from the error.

## Before you use it

The original prompt pointed at two files that do not resolve on this machine:

| Referenced | Reality |
|---|---|
| `C:\Projects\Restaurantnexgenn-main\document\manual\MANUAL-FORMAT-PROMPT.md` | that project is not on this machine |
| `documents\App manual\kra_kpi_admin_manual.docx` | moved on 21 Aug 2026 to `documents/kra-kpi-admin-manual.docx` |

The block below is corrected: it names the reference document where it actually lives, and
treats "measure the reference yourself" as the primary route rather than the fallback,
since no written spec is reachable here. If you do get hold of `MANUAL-FORMAT-PROMPT.md`,
add it back as the first source — a measured spec beats re-deriving one.

---

```
Build a complete end-user manual for this project.

Product name: <<< NAME >>>
Brand for cover/header/footer: <<< BRAND >>>
Names that must NOT appear anywhere: <<< or "none" >>>

FORMAT
Match the house style exactly. The reference document is
  C:\Projects\KRA_KPI\documents\kra-kpi-admin-manual.docx
There is no written spec on this machine, so derive one: unzip that .docx and
measure it yourself — page geometry, styles, table borders and shading, the step
badge, the callout, figure sizing, header and footer — then follow it
construction for construction.

PIPELINE
  <docs>/manual/<product>-user-manual.md   content only, plain Markdown
  build_manual.py                          python-docx generator, all formatting
  build-manual.ps1                         .md -> .docx -> .pdf via Word
  screenshots/manifest.json                IMAGE n -> filename + what to capture
Do not use an HTML -> Word pipeline. It cannot express run shading, negative
indents, repeating header rows, hanging-indent bullets or multi-paragraph
footers. It also imports <img> as LINKED pictures, so the .docx carries file
paths instead of image bytes and shows red X placeholders the moment it is
emailed.

CONTENT
Write it from the source, not from existing docs or READMEs — those are stale.
Send parallel Explore agents and establish: every screen a user can actually
reach (exclude registered-but-unreachable routes), the literal on-screen strings
quoted verbatim, the exact tap sequence per flow, roles (or the absence of any),
anything configured outside the app, behaviour that would surprise a user, and
what the product genuinely cannot do.

Structure: cover, About This Guide, a "… at a Glance" rhythm list, then PART n
sections of numbered steps. Each step: short second-person paragraphs with
on-screen labels in bold, then a two-column table whose header reads as a
question, then a figure. End with QUICK REFERENCE, Things to Remember, a
one-sentence banner and the closing line. Split into two books inside one
document if day-to-day users and whoever sets the system up need different
guides.

GOTCHAS
- Never set bold/italic/underline to False on a run in a styled paragraph — it
  writes <w:b w:val="0"/> and cancels the bold Heading 1/2/3 supply. Use None.
- Run the Python and Word stages in separate processes, or Word COM stalls
  indefinitely without emitting a PDF. Re-invoke the script with -RenderOnly.
- Do not call Fields.Update() over header/footer collections; with NUMPAGES it
  loops forever. ExportAsFixedFormat resolves fields while rendering.
- Always $word.Quit() in a finally. A killed Word leaves recovery state in
  HKCU:\...\Word\Resiliency and every later automated start blocks on it.

VERIFY
Write a script that unzips the generated .docx and asserts every construct
against the measured spec — page geometry, banner, step badge, tables, callout,
figure, bullets, header, footer — reporting pass/fail per check, all green
required. Locate elements by their distinctive formatting, not their text;
heading text also appears in contents tables and produces false failures. Then
confirm page count, that the cover has no header/footer, that PDF bookmarks show
the Part/Step outline, that every step heading survived, and run a banned-name
sweep across the .md, .py, .ps1, .docx and the pdftotext output of the .pdf.

If any image ends up in the .docx, assert word/media is non-empty and r:link is
zero — a linked image passes every visual check on the machine that built it.
```

## Notes

- The three `<<< >>>` slots are mandatory. Without a product name and brand the session
  cannot write a cover, and without the banned-name list the final sweep has nothing to
  check.
- `pdftotext` is needed for the banned-name sweep of the PDF. If it is not installed, say
  so rather than skipping that check — a name surviving only in the PDF is exactly the
  case the sweep exists to catch.
- This project's own manuals do **not** use this pipeline. They are HTML built by
  `scripts/build-manuals.ps1`, which is why that script has to break image links by hand.
  Use this prompt for a new manual, not to rebuild those.
