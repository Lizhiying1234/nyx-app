# Nyx Glance helper - watch the current text selection, print one JSON line per new hit.
#
# WHY A SEPARATE PROCESS AT ALL
#   "select text, get a lookup, press nothing" needs UI Automation, and Electron/Node
#   has no binding for it. The alternatives were a native addon (this repo already lost
#   a day to `bindings` + asar during an install) or this: one small PowerShell process
#   that Nyx starts only while Glance is ON and kills when it goes OFF.
#   Windows ships UIAutomationClient, so there is nothing to install and nothing to rebuild.
#
# WHAT IT WILL NOT DO
#   * never reads a password field  (IsPassword -> skip, before the text is ever fetched)
#   * never reads anything while it is not running; Nyx only runs it while Glance is ON
#   * prints the SELECTION ONLY - never the surrounding page, never the window title
#   The rest of the judgement (blocklist, length, dedupe) lives in core/glance.ts, tested.
#
# ASCII ONLY on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI unless there is a BOM,
# and a UTF-8-no-BOM file with non-ASCII in it dies at parse time. (Hit that on 2026-09-13.)
#
# Output: one line of JSON per NEW selection:
#   {"text":"...","proc":"msedge","password":false,"rect":[x,y,w,h]}
#
# WHY THE RECT (user, 2026-09-14 evening)
#   > The popup should appear right below the selected text. Its position should be
#   > based on where the selection is, not fixed somewhere else.
#   Until now the card was placed at the MOUSE CURSOR - which is only near the
#   selection when he just finished dragging, and is somewhere else entirely when he
#   selected by keyboard, or moved the mouse afterwards.
#   UIA hands us the real thing: TextPatternRange.GetBoundingRectangles(). One line
#   per selection can span several rects (wrapped text); we send the UNION, because
#   "below the selection" means below all of it, not below its first line.
#   rect is omitted when UIA gives us nothing - the caller then falls back to the cursor.

param([int]$IntervalMs = 500)

$ErrorActionPreference = 'Continue'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Write-Output '{"fatal":"UIAutomation not available"}'
  exit 1
}

# Force UTF-8 on the way out. Without this the console encoding (GBK on this
# machine) mangles anything non-ASCII: the 2026-09-13 Frame test read Chinese UI text
# and it arrived as mojibake. Node reads the pipe as UTF-8, so the writer must agree.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$AE = [System.Windows.Automation.AutomationElement]
$TP = [System.Windows.Automation.TextPattern]::Pattern
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

# JSON by hand: ConvertTo-Json in PS 5.1 pretty-prints across lines, and we need ONE line.
function Esc([string]$s) {
  # .Replace() is a LITERAL replace - no regex, so no escaping to get wrong.
  # (The first version used -replace with a lone backslash pattern; a Bash heredoc
  #  had eaten one level of escaping, the regex was invalid, Esc threw every poll,
  #  the outer try swallowed it, and the helper printed NOTHING while looking alive.)
  $s = $s.Replace('\', '\\')
  $s = $s.Replace('"', '\"')
  $s = $s.Replace([char]13, ' ')
  $s = $s.Replace([char]10, ' ')
  $s = $s.Replace([char]9, ' ')
  return $s
}

$last = ''

while ($true) {
  try {
    $el = $AE::FocusedElement
    if ($null -ne $el) {

      # --- password gate, FIRST: bail before we even look at the text -------------
      $isPwd = $false
      try { $isPwd = [bool]$el.Current.IsPassword } catch { $isPwd = $false }
      if ($isPwd) {
        Start-Sleep -Milliseconds $IntervalMs
        continue
      }

      $proc = ''
      try { $proc = (Get-Process -Id $el.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}

      # --- find the element that actually owns the selection ----------------------
      # On a web page the focus often sits on a button while the SELECTION belongs to
      # the document, so walk up until something exposes TextPattern.
      $pattern = $null
      $cur = $el
      $depth = 0
      while ($null -ne $cur -and $depth -le 12) {
        $p = $null
        if ($cur.TryGetCurrentPattern($TP, [ref]$p) -and $null -ne $p) { $pattern = $p; break }
        try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
        $depth = $depth + 1
      }

      if ($env:NYX_GLANCE_LOG) {
        $dbg = 'poll proc=' + $proc + ' pwd=' + $isPwd + ' pattern=' + ($null -ne $pattern)
        Add-Content -Path $env:NYX_GLANCE_LOG -Value $dbg -Encoding UTF8
      }
      if ($null -ne $pattern) {
        $txt = ''
        try {
          foreach ($r in $pattern.GetSelection()) { $txt = $txt + $r.GetText(400) }
        } catch {}
        $txt = $txt.Trim()
        if ($txt.Length -gt 0 -and $txt -ne $last) {
          $last = $txt
          # --- where is it on screen (union of every rect this selection covers) ---
          $rect = ''
          try {
            $x1 = [double]::MaxValue; $y1 = [double]::MaxValue
            $x2 = [double]::MinValue; $y2 = [double]::MinValue
            foreach ($r in $pattern.GetSelection()) {
              foreach ($b in $r.GetBoundingRectangles()) {
                if ($b.Width -le 0 -or $b.Height -le 0) { continue }
                if ($b.X -lt $x1) { $x1 = $b.X }
                if ($b.Y -lt $y1) { $y1 = $b.Y }
                if (($b.X + $b.Width) -gt $x2) { $x2 = $b.X + $b.Width }
                if (($b.Y + $b.Height) -gt $y2) { $y2 = $b.Y + $b.Height }
              }
            }
            if ($x2 -gt $x1 -and $y2 -gt $y1) {
              $rect = ',"rect":[' + [int]$x1 + ',' + [int]$y1 + ',' + [int]($x2 - $x1) + ',' + [int]($y2 - $y1) + ']'
            }
          } catch {}
          # Straight to the stdout STREAM, then flush.
          # Write-Output goes through the PowerShell pipeline, and when the parent is a
          # GUI-subsystem process (Electron) with no console, that pipeline can sit on the
          # bytes forever: the helper looks alive and says nothing. Verified 2026-09-13 -
          # identical script printed in ~2s under plain node, and NOTHING under Electron.
          [Console]::Out.WriteLine('{"text":"' + (Esc $txt) + '","proc":"' + (Esc $proc) + '","password":false' + $rect + '}')
          [Console]::Out.Flush()
        } elseif ($txt.Length -eq 0) {
          # selection cleared -> allow the same text to fire again next time, AND tell
          # Nyx, so the floating card can go away.
          #
          # WHY THE HELPER IS THE ONE WHO SAYS THIS (2026-09-14)
          #   The lookup card lives in a `focusable: false` BrowserWindow, on purpose
          #   (ASSIST_CONTRACT: never take over the foreground). A window that never
          #   takes focus never gets a blur event, and a click anywhere else on the
          #   screen goes straight to the other app - Nyx never hears about it.
          #   So the card just sat there. The user reported exactly that:
          #   "when I click somewhere else the popup still will not go away".
          #   This process is already watching the selection 2x a second, and clicking
          #   somewhere else IS what clears a selection. So it is the cheapest true
          #   signal available - no mouse hook, no extra process, no polling loop.
          #
          # Fires once per transition (guarded on $last), not once per poll.
          if ($last -ne '') {
            [Console]::Out.WriteLine('{"cleared":true}')
            [Console]::Out.Flush()
          }
          $last = ''
        }
      } elseif ($last -ne '') {
        # Focus moved to something with no text at all - another app, a toolbar button.
        # Whatever we were showing a card for is not on screen in any meaningful sense.
        [Console]::Out.WriteLine('{"cleared":true}')
        [Console]::Out.Flush()
        $last = ''
      }
    }
  } catch {
    # One bad poll must never kill the loop: Nyx would stop watching and never say so.
  }
  Start-Sleep -Milliseconds $IntervalMs
}
