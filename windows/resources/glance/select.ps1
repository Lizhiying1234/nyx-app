# Nyx Point helper - make unselectable text selectable. Watches the real mouse and
# reports what the drag covers. One JSON line per change, forever.
#
# WHY THIS EXISTS (user, 2026-09-14, third batch)
#   > Point should not depend on a shortcut key. Once I turn Point on from the icon it
#   > should already be working.
#   > Point's real purpose: make text that cannot normally be selected selectable.
#   > It should feel like an ordinary web page - I drag across the words with the mouse
#   > and then Assist looks them up.
#   > Go look at how Android's Point does it first.
#
# WHAT ANDROID DOES (NyxAssistService.java, read 2026-09-14)
#   enterMode() adds a FULLSCREEN TYPE_ACCESSIBILITY_OVERLAY layer. That layer is
#   TOUCHABLE, so it swallows every touch; to keep the host app usable it then REPLAYS
#   the touches it did not consume back onto the host as synthetic gestures
#   (forwardGesture + GestureDescription, D-402 "the host still works inside the mode").
#   A 380ms long press is what separates "select this word" from "tap this button".
#
# WHY WINDOWS DOES NOT NEED THE REPLAY HALF
#   Android has to swallow first because an accessibility overlay cannot watch without
#   capturing. Here we can simply WATCH: GetAsyncKeyState tells us the button state and
#   GetCursorPos tells us where, without touching the input stream at all.
#   And the premise of the whole feature carries the rest: the text he is dragging over
#   CANNOT BE SELECTED - so the drag does nothing in the host app anyway. Nothing to
#   suppress, nothing to replay, no chance of eating one of his clicks. Strictly less
#   machinery than Android for the same effect.
#
# A DRAG, NOT A CLICK  (the same question Android answers with the long press)
#   A bare click is NOT a selection here. If it were, every button he clicked anywhere
#   on the desktop while Point is on would pop a dictionary card. So the trigger is
#   movement past DRAG_MIN while the button is down - which is also exactly the gesture
#   he described ("select the words with the mouse, like a normal web page").
#
# DPI - READ THIS BEFORE TOUCHING ANY COORDINATE HERE
#   Windows PowerShell 5.1 is DPI-UNAWARE, so GetCursorPos hands back VIRTUALISED
#   coordinates (his machine: 1707x1067) while UI Automation always speaks PHYSICAL
#   pixels (2560x1600). Measured 2026-09-14: cursor 1649,802 unaware -> 2474,1203 aware.
#   SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) is therefore MANDATORY, not a
#   nicety: without it every point we feed UIA lands up and to the left, and the further
#   right he is on screen the more wrong it gets. (That is the same bug he reported for
#   the old shortcut: "the word it looks up is not the word under the mouse.")
#   Everything on stdout is PHYSICAL pixels. Nyx converts at its own edge (src/main/dpi.ts).
#
# HOW A SELECTION IS BUILT (measured on a user-select:none page in Edge, 2026-09-14)
#   RangeFromPoint(a) and RangeFromPoint(b), expand EACH to Word, then join.
#   * Joining first and expanding afterwards does NOT work - Chromium's
#     ExpandToEnclosingUnit(Word) collapses the joined range back to the first word.
#     Measured: "unspooling " instead of "unspooling consequences of that signed policy".
#   * Dragging past the end of the text makes RangeFromPoint THROW
#     ("Screen coordinate is outside the bounding rectangle") - caught, and the last
#     good endpoint is kept, which is what a browser does too.
#   * Wrapped selections report one rectangle per line (measured: 2 lines -> 2 rects).
#   * Starting the drag in EMPTY SPACE still returns text: Edge clamps to the nearest
#     run rather than failing (measured 2026-09-14: a drag begun 300px below the last
#     paragraph selected its final word). So "we got a word" is not "he pointed at a
#     word". We therefore report "dist" - how far the anchor was from the word we
#     landed on - and let core/glance.ts decide the tolerance. Same split as point.ps1:
#     THIS SCRIPT MEASURES, CORE JUDGES. Android does the same (its 60px note).
#
# OCR FALLBACK - WHY IT IS BACK  (I-177, user 2026-09-14 "fallback is fine, do it your way")
#   He reported: Point cannot select a single word inside the real Genshin client.
#   Measured on his machine that day, in the running game (windowed, Quest Item page):
#     * GenshinImpact runs at SYSTEM integrity (anti-cheat). Nyx is Medium. So
#       AutomationElement.FromPoint does not return null there - it THROWS
#       "Access is denied". UIPI blocks the cross-process hit test outright.
#     * Even past that there is nothing to read: the top-level element is a bare
#       UnityWndClass with ZERO descendants in the RAW view, supporting only
#       Window/Transform patterns. No TextPattern anywhere in the tree.
#   Two independent locks on the same door, so "a different UIA call" or "special-case
#   that screen" cannot work. This is exactly the ASSIST_CONTRACT row
#   "fully self-drawn UI that exposes no text nodes -> OCR only", and the same case
#   Android answers with startOcr (D-304 / D-395 allow it; OCR is ALWAYS last).
#
#   What we do: UIA first, always. Only when a whole gesture yields no real text do we
#   grab a frame and hand the recognised word boxes to core to judge.
#   Measured: 17-19 ms warm (7 shot + 8 convert + 2-4 ocr).
#
#   TWO GRABS PER GESTURE, and only two (user ruled this on 2026-09-14, "option B")
#     1. FIRST MOVEMENT past DRAG_MIN - a band around the anchor. This one exists so
#        the drag LIGHTS UP AS HE DRAGS, which is the whole point he asked for:
#        "it should feel like an ordinary web page - I drag across the words". With a
#        release-only grab the screen stays dead until he lets go.
#     2. RELEASE - the band the drag actually covered. THIS one is the answer.
#        Re-grabbing is what makes 1. safe: the picture can move mid-drag (it is a
#        game), so the cached words may be stale by the time he lets go. The highlight
#        can afford to be a frame behind; the word we look up cannot.
#   That is two grabs, not a stream - we never poll the screen.
#
#   * BEFORE THE RELEASE GRAB WE CLEAR THE HIGHLIGHT and wait a beat. Otherwise we
#     photograph our own highlight sitting on top of his text: at best a tint over the
#     letters, at worst (see NyxRects) a full-screen window that swallows the band.
#   * NEVER TOUCHES DISK. Bitmap -> LockBits -> IBuffer -> SoftwareBitmap, all in
#     memory. A screenshot of his screen must not be sitting in a temp folder, not
#     even for 20 ms.
#   * The band only - not the screen, not the window. We read what he dragged over.
#   KNOWN LIMIT (measured, do not promise otherwise): text dimmed behind a modal is
#   NOT recognised. 3x upscale plus auto-levels did not rescue it and cost 381 ms,
#   so there is no preprocessing here at all - raw pixels go straight to the engine.
#
# PROTOCOL (stdout, one JSON line each)
#   {"ready":true}
#   {"clear":true}                                     drag started / nothing selected
#   {"sel":"...","proc":"msedge","dist":0,"rects":[[x,y,w,h],...]}       while dragging
#   {"sel":"...","proc":"msedge","dist":0,"rects":[...],"done":true}     on release
#   {"ocr":true,"proc":"genshinimpact","ax":..,"ay":..,"bx":..,"by":..,
#    "words":[{"t":"word","x":..,"y":..,"w":..,"h":..},...],"done":true}  recognised
#   {"why":"..."}                                      gave up on this gesture
#   ALL COORDINATES ARE PHYSICAL SCREEN PIXELS, including the OCR word boxes.
#
# WHEN THE SELECTION GOES AWAY  (user, 2026-09-15: "I do not want the kind of effect
# where it vanishes as soon as I drag")
#   The highlight and the card STAY after a drag. Their lifetime is deliberately
#   decoupled from the gesture, the way Android's is. Exactly four things end them,
#   and every one of them is something HE does:
#     1. he clicks somewhere that is not one of our own windows  (the branch below)
#     2. he clicks the X on the card                             (main/index.ts)
#     3. he starts a new drag - the old selection goes at the FIRST MOVEMENT, not at
#        release, so he never sees two selections at once        (the clear lines)
#     4. he turns Point off                                      (applyPoint)
#   *** THERE IS NO TIMER. Do not add one. *** A selection that disappears on its own
#   is the exact complaint this section exists to answer, and a timeout would bring it
#   back wearing a different hat.
#
# WHAT IT WILL NOT DO
#   * never reads a password field (IsPassword is checked before any text is fetched)
#   * never reads anything while the drag started on one of Nyx's own windows
#   * never reads anything unless the button is actually down
#   * never OCRs when UIA gave us real text - that would demote the real-text path,
#     which D-395 forbids in so many words
#   * never OCRs a gesture that died on the password / self / no-range gates
#   The rest of the judgement (blocklist, length, mode, WHICH WORD he meant) lives in
#   core/glance.ts, tested. THIS SCRIPT MEASURES, CORE JUDGES - OCR included.
#
# ASCII ONLY on purpose - see point.ps1 for why.

param([int]$SelfPid = 0, [string]$SelfName = '')

$ErrorActionPreference = 'Continue'

Add-Type @"
using System;using System.Runtime.InteropServices;
public class NyxIn {
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out NyxPt p);
  // Used only on the OCR path: UI Automation is denied over a SYSTEM-integrity window,
  // but this plain hit test still answers "which process owns the pixels under here".
  // Without it the blocklist gate (1password and friends) would have nothing to match
  // on, and OCR would be the one path that can read a blocked app. Measured working
  // on the real Genshin window, where FromPoint throws.
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(NyxPt p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  // Used to find OUR OWN windows so their pixels never get read back as the host's
  // text. See NyxRects().
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out NyxRect r);
}
[StructLayout(LayoutKind.Sequential)] public struct NyxPt { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct NyxRect { public int L; public int T; public int R; public int B; }
"@
# -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. See the DPI note above.
[void][NyxIn]::SetProcessDpiAwarenessContext([IntPtr](-4))

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  [Console]::Out.WriteLine('{"why":"uia-unavailable"}')
  [Console]::Out.Flush()
  exit 1
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# --- OCR fallback, loaded lazily -------------------------------------------------
# Nothing here runs unless a gesture actually needs it. Most of what he points at is
# real text, and a Point session should not pay for WinRT it never uses.
$OCR_READY = $false      # tried and succeeded
$OCR_DEAD  = $false      # tried and failed - do not try again, do not spam him
$OCR_ENG   = $null
$OCR_ASTASK = $null

function OcrInit {
  if ($script:OCR_READY -or $script:OCR_DEAD) { return $script:OCR_READY }
  try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
    # PS 5.1 cannot await a WinRT IAsyncOperation directly - go through AsTask<T>.
    $script:OCR_ASTASK = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    # English only. This is an English-learning app; a zh recogniser here would hand
    # core Chinese "words" that the lookup path has nothing to do with.
    $lang = New-Object Windows.Globalization.Language 'en-US'
    $script:OCR_ENG = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if ($null -eq $script:OCR_ENG) { $script:OCR_DEAD = $true; return $false }
    $script:OCR_READY = $true
    return $true
  } catch {
    $script:OCR_DEAD = $true
    return $false
  }
}

# Await a WinRT operation, but NEVER hang on it.
#   $task.Wait(ms) returns $false on timeout - and reading $task.Result after that
#   BLOCKS FOREVER. This loop is the only thread the helper has, so one stuck call
#   would stop Point dead: no cards, no errors, nothing, until he restarts Nyx.
#   That is the exact failure shape this whole change exists to remove, so the
#   timeout has to mean "give up", not "wait harder".
# $null back = treat it as "read nothing here", which the caller already handles
# and which puts a card on screen saying so.
function OcrAwait($op, $t) {
  try {
    $m = $script:OCR_ASTASK.MakeGenericMethod($t)
    $task = $m.Invoke($null, @($op))
    if (-not $task.Wait(4000)) { return $null }
    return $task.Result
  } catch {
    return $null
  }
}

# Where OUR OWN top-level windows are, right now, in physical screen pixels.
#
# WHY THIS EXISTS - it is not tidiness, it is the D-304 failure mode
#   The grab is a BitBlt off the composited desktop, so it reads whatever is ON TOP,
#   and Nyx's own windows are on top by construction: the lookup card
#   (alwaysOnTop 'screen-saver'), the little bubble, the highlight layer. Read one of
#   those back and we would hand core a word that came from OUR UI and label it as
#   text from his game - an OCR-grade wrong term that syncs home looking exactly like
#   a real one, which D-304 calls out as the most expensive accident this system has.
#
#   The card is already dismissed at drag start (the clear line below), but the bubble
#   is not: it is his ON/OFF indicator and blinking it on every drag would be worse
#   than the problem. Blanking it from capture entirely (SetWindowDisplayAffinity)
#   would also remove it from screenshots HE takes. So we do neither - we just drop
#   the words that landed inside one of our own windows. Those words were never his
#   host's text anyway; they were covered up on screen too.
#
# * The walk is GetTopWindow + GW_HWNDNEXT, NOT FindWindowEx and NOT EnumWindows.
#   EnumWindows needs a delegate, which PS 5.1 makes needlessly sharp. FindWindowEx
#   with a null parent is the documented way to list top-level windows and it
#   DOES NOT WORK from here - measured 2026-09-14: the very first call returns 0 and
#   the walk ends with zero windows seen, for every process, silently. The first
#   version of this function used it, so the filter below was a NO-OP that looked
#   exactly like a working filter (nothing got dropped because nothing was found).
#   Same walk, measured on the same machine: 361 windows, 28 visible, Genshin/Edge
#   found by name. If you change this walk, count what it returns before trusting it.
#
# *** A WINDOW THAT COVERS THE WHOLE BAND IS SKIPPED - and that is not a nicety.
#   The highlight layer (main/marker.ts) is a FULL-SCREEN transparent window:
#   it setBounds() to the entire display. Under the release-only design it was never
#   visible while we grabbed, so this never came up. Under the live-highlight design
#   it IS visible at release - and then its rect contains every word in the band, so
#   "drop words that overlap one of our windows" would drop EVERY word and every
#   lookup would come back "nothing readable here". A silent, total failure.
#   Skipping it is also the right answer on the merits: that layer is transparent and
#   has no text of its own, so there is nothing of ours to read out of it, while the
#   windows this filter exists for (the card, the bubble) are small and opaque.
#   * The test is "contains the whole band", not "bigger than N pixels" - no magic
#     number, and it names exactly the degenerate case where filtering cannot help.
function NyxRects($bx1, $by1, $bx2, $by2) {
  $out = New-Object System.Collections.ArrayList
  if ($SelfPid -le 0) { return $out }
  try {
    $h = [NyxIn]::GetTopWindow([IntPtr]::Zero)
    $guard = 0
    while ($h -ne [IntPtr]::Zero -and $guard -lt 5000) {
      $guard = $guard + 1
      if ([NyxIn]::IsWindowVisible($h)) {
        $wpid = 0
        [void][NyxIn]::GetWindowThreadProcessId($h, [ref]$wpid)
        if ($wpid -eq $SelfPid) {
          $r = New-Object NyxRect
          if ([NyxIn]::GetWindowRect($h, [ref]$r)) {
            if (($r.R - $r.L) -gt 0 -and ($r.B - $r.T) -gt 0) {
              $swallows = ($r.L -le $bx1 -and $r.T -le $by1 -and $r.R -ge $bx2 -and $r.B -ge $by2)
              if (-not $swallows) { [void]$out.Add($r) }
            }
          }
        }
      }
      $h = [NyxIn]::GetWindow($h, 2)     # GW_HWNDNEXT
    }
  } catch {}
  return $out
}

# The band the drag covered -> recognised words, in PHYSICAL SCREEN pixels.
# Returns $null when we could not read anything at all (caller must still say so).
function OcrBand($x, $y, $w, $h) {
  if (-not (OcrInit)) { return $null }
  $bmp = $null
  $sb = $null
  try {
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gr = [System.Drawing.Graphics]::FromImage($bmp)
    # CopyFromScreen = GDI BitBlt off the composited desktop. PrintWindow was measured
    # on the real game and returns False with an all-black bitmap, so it is not an option.
    # Consequence worth knowing: this grabs the SCREEN, so whatever is on top is what we
    # read. Nyx's own card is hidden at drag start (see the clear line below).
    $gr.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)),
      [System.Drawing.CopyPixelOperation]::SourceCopy)
    $gr.Dispose()

    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bytes = New-Object byte[] ($bd.Stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $bytes, 0, $bytes.Length)
    $bmp.UnlockBits($bd)
    $bmp.Dispose(); $bmp = $null

    # CopyFromScreen leaves the alpha byte at 0. Feeding that to the engine reads as a
    # fully transparent image and comes back with zero lines - measured, and it looks
    # exactly like "there was no text there". Force opaque.
    for ($i = 3; $i -lt $bytes.Length; $i += 4) { $bytes[$i] = 255 }

    $buf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
    $sb = New-Object Windows.Graphics.Imaging.SoftwareBitmap(
      [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $w, $h,
      [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)
    $sb.CopyFromBuffer($buf)
    $res = OcrAwait ($script:OCR_ENG.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
    $sb.Dispose(); $sb = $null
    if ($null -eq $res) { return $null }

    # Flatten in READING ORDER (line by line, left to right within a line). core slices
    # the run between the two endpoints out of this array, so the order IS the meaning -
    # shuffle it and he drags over three words and gets half a page.
    $mine = NyxRects $x $y ($x + $w) ($y + $h)
    $out = New-Object System.Collections.ArrayList
    foreach ($ln in $res.Lines) {
      foreach ($wd in $ln.Words) {
        $t = $wd.Text
        if ($null -eq $t -or $t.Trim().Length -eq 0) { continue }
        $b = $wd.BoundingRect
        $wx = [int]$b.X + $x        # band-local -> physical screen px, here and nowhere else
        $wy = [int]$b.Y + $y
        $ww = [int]$b.Width
        $wh = [int]$b.Height
        # Landed inside one of our own windows -> it is our UI, not his host's text.
        $ours = $false
        foreach ($r in $mine) {
          if ($wx -lt $r.R -and ($wx + $ww) -gt $r.L -and $wy -lt $r.B -and ($wy + $wh) -gt $r.T) {
            $ours = $true
            break
          }
        }
        if ($ours) { continue }
        [void]$out.Add(@{ t = $t; x = $wx; y = $wy; w = $ww; h = $wh })
      }
    }
    return $out
  } catch {
    return $null
  } finally {
    if ($null -ne $bmp) { try { $bmp.Dispose() } catch {} }
    if ($null -ne $sb) { try { $sb.Dispose() } catch {} }
  }
}

$AE     = [System.Windows.Automation.AutomationElement]
$TP     = [System.Windows.Automation.TextPattern]::Pattern
$WALK   = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$EP_S   = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start
$EP_E   = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End
$UNIT_W = [System.Windows.Automation.Text.TextUnit]::Word

$VK_LBUTTON = 1
$DRAG_MIN   = 8      # physical px. Below this it is a click, not a drag (see note above).
$TICK_MS    = 30     # ~33Hz. Idle cost is one GetAsyncKeyState - free.
$MAX_CHARS  = 600

function Esc([string]$s) {
  # Literal .Replace(), never -replace: no regex means no escaping to get wrong.
  $s = $s.Replace('\', '\\')
  $s = $s.Replace('"', '\"')
  $s = $s.Replace([char]13, ' ')
  $s = $s.Replace([char]10, ' ')
  $s = $s.Replace([char]9, ' ')
  return $s
}

function Say([string]$line) {
  # Straight to the stream then flush - under a GUI-subsystem parent the PowerShell
  # pipeline can sit on the bytes forever and the helper looks alive while saying nothing.
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

# The element at the point, and the nearest ancestor that actually owns the text.
# On a web page the element under the cursor is usually a span while TextPattern lives
# on the document, so we walk up.
function GetPattern($pt) {
  # FromPoint THROWS "Access is denied" over a window whose process runs at a higher
  # integrity level than ours - the real Genshin client does exactly this (I-177).
  # Unguarded it is survivable ($el stays null, the loop keeps turning) but it dumps a
  # multi-line .NET error record on stderr every single drag, and 'no-element' hides
  # the reason. Catch it and say which wall we hit.
  $el = $null
  try {
    $el = $AE::FromPoint($pt)
  } catch {
    return @{ pat = $null; why = 'denied' }
  }
  if ($null -eq $el) { return @{ pat = $null; why = 'no-element' } }

  # --- password gate, FIRST: bail before we even look at the text ---------------
  $isPwd = $false
  try { $isPwd = [bool]$el.Current.IsPassword } catch { $isPwd = $false }
  if ($isPwd) { return @{ pat = $null; why = 'password' } }

  # --- ours? then this is him dragging our own card or bubble, not selecting ----
  $proc = ''
  try {
    $pid2 = $el.Current.ProcessId
    if ($SelfPid -gt 0 -and $pid2 -eq $SelfPid) { return @{ pat = $null; why = 'self' } }
    $proc = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName
  } catch {}
  if ($SelfName.Length -gt 0 -and $proc -eq $SelfName) { return @{ pat = $null; why = 'self' } }

  $cur = $el
  $depth = 0
  while ($null -ne $cur -and $depth -le 12) {
    $p = $null
    if ($cur.TryGetCurrentPattern($TP, [ref]$p) -and $null -ne $p) {
      return @{ pat = $p; why = ''; proc = $proc }
    }
    try { $cur = $WALK.GetParent($cur) } catch { $cur = $null }
    $depth = $depth + 1
  }
  return @{ pat = $null; why = 'no-text-pattern' }
}

# How far a point is from a range's boxes. 0 = inside. -1 = no geometry to measure.
function DistTo($r, $x, $y) {
  $best = 99999
  try {
    foreach ($b in $r.GetBoundingRectangles()) {
      if ($b.Width -le 0 -or $b.Height -le 0) { continue }
      $dx = 0
      if ($x -lt $b.X) { $dx = $b.X - $x } elseif ($x -gt ($b.X + $b.Width)) { $dx = $x - ($b.X + $b.Width) }
      $dy = 0
      if ($y -lt $b.Y) { $dy = $b.Y - $y } elseif ($y -gt ($b.Y + $b.Height)) { $dy = $y - ($b.Y + $b.Height) }
      $d = [Math]::Sqrt(($dx * $dx) + ($dy * $dy))
      if ($d -lt $best) { $best = $d }
    }
  } catch {}
  if ($best -gt 99998) { return -1 }
  return [int]$best
}

# The top-level window under a point, as a rect. '' -> $null.
# * We clamp every grab to this. Without it the band is just "a stripe of the desktop"
#   and it reads whatever else happens to be lying along that stripe - measured on the
#   very first option-B run: a drag inside the test surface came back with words from
#   the chat window behind it ("Nyx-Point", "Proje"). Two things wrong with that: the
#   highlight can light up a word from another app, and we are reading pixels he never
#   dragged over. The band is supposed to be "what he dragged over", and "over" means
#   inside the thing he is pointing at.
function HostRect($x, $y) {
  try {
    $pt = New-Object NyxPt
    $pt.X = $x; $pt.Y = $y
    $h = [NyxIn]::WindowFromPoint($pt)
    if ($h -eq [IntPtr]::Zero) { return $null }
    $h = [NyxIn]::GetAncestor($h, 2)      # GA_ROOT
    if ($h -eq [IntPtr]::Zero) { return $null }
    $r = New-Object NyxRect
    if (-not [NyxIn]::GetWindowRect($h, [ref]$r)) { return $null }
    if (($r.R - $r.L) -le 0 -or ($r.B - $r.T) -le 0) { return $null }
    return $r
  } catch { return $null }
}

# Grab + recognise the band around two points, clamped to the desktop AND to the
# window he is pointing at.
# Returns the word list (possibly empty) or $null. Shared by both grabs so the band
# maths cannot drift between "what we lit up" and "what we answered with".
function OcrAround($ax, $ay, $bx, $by, $padX, $padY) {
  $x1 = [Math]::Min($ax, $bx) - $padX
  $y1 = [Math]::Min($ay, $by) - $padY
  $x2 = [Math]::Max($ax, $bx) + $padX
  $y2 = [Math]::Max($ay, $by) + $padY
  # He can absolutely drag off the edge of the screen; a band that runs off it makes
  # CopyFromScreen read rubbish (or throw).
  $vx = [NyxIn]::GetSystemMetrics(76); $vy = [NyxIn]::GetSystemMetrics(77)
  $vw = [NyxIn]::GetSystemMetrics(78); $vh = [NyxIn]::GetSystemMetrics(79)
  if ($x1 -lt $vx) { $x1 = $vx }
  if ($y1 -lt $vy) { $y1 = $vy }
  if ($x2 -gt ($vx + $vw)) { $x2 = $vx + $vw }
  if ($y2 -gt ($vy + $vh)) { $y2 = $vy + $vh }
  # ...and to the host window, so we never read the app next door (see HostRect).
  $hr = HostRect $ax $ay
  if ($null -ne $hr) {
    if ($x1 -lt $hr.L) { $x1 = $hr.L }
    if ($y1 -lt $hr.T) { $y1 = $hr.T }
    if ($x2 -gt $hr.R) { $x2 = $hr.R }
    if ($y2 -gt $hr.B) { $y2 = $hr.B }
  }
  if (($x2 - $x1) -le 0 -or ($y2 - $y1) -le 0) { return $null }
  return OcrBand $x1 $y1 ($x2 - $x1) ($y2 - $y1)
}

# One "{"ocr":...}" line. $done marks the release one - the only one that looks anything up.
function SayOcr($words, $proc, $ax, $ay, $bx, $by, $done) {
  $parts = @()
  if ($null -ne $words) {
    foreach ($wd in $words) {
      $parts += ('{"t":"' + (Esc ([string]$wd.t)) + '","x":' + $wd.x + ',"y":' + $wd.y +
        ',"w":' + $wd.w + ',"h":' + $wd.h + '}')
    }
  }
  $tail = ''
  if ($done) { $tail = ',"done":true' }
  Say ('{"ocr":true,"proc":"' + (Esc $proc) + '","ax":' + $ax + ',"ay":' + $ay +
    ',"bx":' + $bx + ',"by":' + $by + ',"words":[' + ($parts -join ',') + ']' + $tail + '}')
}

# Which process owns the pixels under this point. Plain user32, no UI Automation, so
# it still answers where FromPoint is denied. '' when we cannot tell - and '' is NOT
# treated as safe by the caller (see the OCR branch: no name, no OCR).
function ProcAt($x, $y) {
  try {
    $p = New-Object NyxPt
    $p.X = $x; $p.Y = $y
    $h = [NyxIn]::WindowFromPoint($p)
    if ($h -eq [IntPtr]::Zero) { return '' }
    $pid2 = 0
    [void][NyxIn]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ($pid2 -le 0) { return '' }
    if ($SelfPid -gt 0 -and $pid2 -eq $SelfPid) { return $SelfName }
    return (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName
  } catch {
    return ''
  }
}

# A word-snapped range at one point, or $null if the point is off the text.
function WordAt($pat, $pt) {
  try {
    $r = $pat.RangeFromPoint($pt)
    if ($null -eq $r) { return $null }
    $r.ExpandToEnclosingUnit($UNIT_W)
    return $r
  } catch {
    # "Screen coordinate is outside the bounding rectangle" - he dragged past the end.
    return $null
  }
}

# ---------------------------------------------------------------------------------
Say '{"ready":true}'

$wasDown  = $false
$anchorX  = 0
$anchorY  = 0
$pat      = $null     # resolved lazily, on the first real movement
$anchorR  = $null
$proc     = ''
$dragging = $false
$lastSel  = ''
$anchorD  = -1
$lastLine = ''
$dead     = $false    # this gesture is not ours - stay quiet until the button comes up
# --- OCR fallback bookkeeping, per gesture ---------------------------------------
# $tryOcr is armed ONLY where the real-text path hit a wall that OCR can answer.
# It stays $false for password / self / no-range: those are refusals, not failures,
# and "we could not read it" must never turn into "so read it another way".
$tryOcr   = $false
$ocrProc  = ''
$ocrWords = $null     # words from grab 1, used to light up the drag as it happens
$ocrLastX = -99999    # cursor x/y at the last highlight line we emitted (see OCR_STEP)
$ocrLastY = -99999
$OCR_PAD  = 60        # physical px of slack above and below the drag band. One line of
                      # body text measured 31px tall in the game and 37-38px in Edge, so
                      # this is ~1.5 lines - enough that a word he grazed is whole in the
                      # picture, small enough that we are not reading the paragraph above.
# How far left/right of the anchor grab 1 reaches. He has not dragged yet, so we cannot
# know where he is going - this is "one long line of text", not "the screen".
$OCR_LEAD = 800
# Do not re-send the highlight line until the cursor has actually moved this far. The
# line carries the whole word list, and at 33Hz an unthrottled stream is kilobytes a
# second of stdout for a picture that has not changed.
$OCR_STEP = 6
# How long to let the highlight actually disappear before the release grab. It is a
# round trip: our line -> main process -> marker window hides. 80ms is ~2.5 frames.
$OCR_SETTLE = 80

while ($true) {
  Start-Sleep -Milliseconds $TICK_MS
  $down = ([NyxIn]::GetAsyncKeyState($VK_LBUTTON) -band 0x8000) -ne 0
  $p = New-Object NyxPt
  [void][NyxIn]::GetCursorPos([ref]$p)

  if ($down -and -not $wasDown) {
    # --- pressed: remember where, but do NO UIA work yet ------------------------
    # A plain click must cost nothing and must not look anything up.
    $anchorX = $p.X; $anchorY = $p.Y
    $pat = $null; $anchorR = $null; $dragging = $false; $dead = $false
    $lastSel = ''; $lastLine = ''; $anchorD = -1
    $tryOcr = $false; $ocrProc = ''
    $ocrWords = $null; $ocrLastX = -99999; $ocrLastY = -99999
  }
  elseif ($down -and $wasDown -and -not $dead) {
    $dx = $p.X - $anchorX
    $dy = $p.Y - $anchorY
    $far = (($dx * $dx) + ($dy * $dy)) -ge ($DRAG_MIN * $DRAG_MIN)
    if ($far) {
      if (-not $dragging) {
        # --- first real movement: this is a selection. Resolve the anchor now. ---
        $a = New-Object System.Windows.Point($anchorX, $anchorY)
        $g = GetPattern $a
        if ($null -eq $g.pat) {
          # Not text, not ours to read, or a password box. Say nothing more this gesture.
          $dead = $true
          if ($g.why -ne 'self') { Say ('{"why":"' + $g.why + '"}') }
          # --- is this a wall OCR can answer? ------------------------------------
          # 'denied'          : higher-integrity window (the real Genshin client)
          # 'no-text-pattern' : self-drawn UI with no text nodes anywhere up the tree
          # 'no-element'      : nothing there at all
          # NOT 'password', NOT 'self' - those are refusals. Reading them another way
          # would be the whole point of the gate, defeated.
          if ($g.why -eq 'denied' -or $g.why -eq 'no-text-pattern' -or $g.why -eq 'no-element') {
            # Ask user32 who owns those pixels, since UIA would not say. No name means
            # we cannot run the blocklist - and then we do not look at all.
            $ocrProc = ProcAt $anchorX $anchorY
            if ($ocrProc.Length -gt 0 -and
              -not ($SelfName.Length -gt 0 -and $ocrProc -eq $SelfName)) {
              $tryOcr = $true
              # He started a new gesture, so last lookup's card is stale. Two reasons to
              # say so now: it is the behaviour he asked for ("clicking elsewhere should
              # dismiss it"), and the card is an OPAQUE window that BitBlt would read
              # back to us as if it were the host's text.
              Say '{"clear":true}'
              # --- GRAB 1: so the drag lights up while he is still dragging ----------
              # A band along the anchor's line. He has not dragged yet, so the width is
              # a guess (OCR_LEAD) - which is exactly why the release grab re-reads
              # rather than trusting this one.
              $ocrWords = OcrAround $anchorX $anchorY $anchorX $anchorY $OCR_LEAD $OCR_PAD
            }
          }
        } else {
          $pat = $g.pat
          $proc = [string]$g.proc
          $anchorR = WordAt $pat $a
          if ($null -eq $anchorR) { $dead = $true; Say '{"why":"no-range"}' }
          else {
            # Measured once, at the anchor - the endpoint he actually aimed at.
            $anchorD = DistTo $anchorR $anchorX $anchorY
            $dragging = $true; Say '{"clear":true}'
          }
        }
      }
      if ($dragging) {
        $b = New-Object System.Windows.Point($p.X, $p.Y)
        $cur = WordAt $pat $b
        # Dragged off the text: keep the last good selection, exactly like a browser.
        if ($null -ne $cur) {
          try {
            $cmp = $anchorR.CompareEndpoints($EP_S, $cur, $EP_S)
            if ($cmp -le 0) { $sel = $anchorR.Clone(); $sel.MoveEndpointByRange($EP_E, $cur, $EP_E) }
            else            { $sel = $cur.Clone();     $sel.MoveEndpointByRange($EP_E, $anchorR, $EP_E) }
            $txt = $sel.GetText($MAX_CHARS)
            if ($null -ne $txt) { $txt = $txt.Trim() } else { $txt = '' }
            if ($txt.Length -gt 0 -and $txt -ne $lastSel) {
              $lastSel = $txt
              $parts = @()
              foreach ($r in $sel.GetBoundingRectangles()) {
                if ($r.Width -le 0 -or $r.Height -le 0) { continue }
                $parts += ('[' + [int]$r.X + ',' + [int]$r.Y + ',' + [int]$r.Width + ',' + [int]$r.Height + ']')
              }
              $lastLine = '{"sel":"' + (Esc $txt) + '","proc":"' + (Esc $proc) +
                '","dist":' + $anchorD + ',"rects":[' + ($parts -join ',') + ']'
              Say ($lastLine + '}')
            }
          } catch {}
        }
      }
    }
  }
  elseif ($down -and $wasDown -and $dead -and $tryOcr) {
    # --- OCR path: keep the drag lit while he is still dragging ----------------
    # NO PICTURE IS TAKEN HERE. We replay grab 1's words and let core decide which
    # of them the drag covers - the same judge the final answer goes through.
    #
    # ** Why this is its OWN branch and not part of the one above: that one is
    #   guarded by `-not $dead`, and `$dead` is set the moment the real-text path
    #   gives up - which is exactly when the OCR path takes over. Inside that guard
    #   the highlight froze one tick after it was armed. Measured on a real drag:
    #   exactly ONE live line reached stdout, then silence, and the highlight sat
    #   still while he kept dragging. `$dead` means "the real-text path is done with
    #   this gesture", not "nobody owns it".
    if ($tryOcr -and $null -ne $ocrWords) {
      $mx = $p.X - $ocrLastX
      $my = $p.Y - $ocrLastY
      if ((($mx * $mx) + ($my * $my)) -ge ($OCR_STEP * $OCR_STEP)) {
        $ocrLastX = $p.X; $ocrLastY = $p.Y
        SayOcr $ocrWords $ocrProc $anchorX $anchorY $p.X $p.Y $false
      }
    }
  }
  elseif ((-not $down) -and $wasDown) {
    # --- released ---------------------------------------------------------------
    if ($dragging -and $lastSel.Length -gt 0) { Say ($lastLine + ',"done":true}') }
    elseif ($dragging) { Say '{"clear":true}' }
    elseif ($tryOcr) {
      # --- GRAB 2: the answer ---------------------------------------------------
      # This is the frame he let go of. Grab 1 lit the drag up as he dragged; it may
      # be stale by now (the picture can move mid-drag - it is a game), so the word we
      # actually look up is read FRESH here. The highlight can afford to be a frame
      # behind; the word that ends up in his knowledge base cannot.
      # * Clear our own highlight FIRST and let it actually go away. Otherwise we
      #   photograph our highlight sitting on his text - a tint over the letters at
      #   best, and at worst a full-screen window over the whole band (see NyxRects).
      Say '{"clear":true}'
      Start-Sleep -Milliseconds $OCR_SETTLE
      $words = OcrAround $anchorX $anchorY $p.X $p.Y $OCR_PAD $OCR_PAD
      # Emitted even when the list is empty - an empty word list is how core learns to
      # put "nothing readable here" on the card instead of showing him nothing at all.
      SayOcr $words $ocrProc $anchorX $anchorY $p.X $p.Y $true
    }
    else {
      # --- a CLICK, not a drag: he is putting the selection away ------------------
      # User, 2026-09-15: he wants the selection and the card to STAY after a drag
      # (the Android behaviour). The moment they stay, something has to take them
      # away again, and the obvious gesture is the one everybody already uses:
      # click somewhere else.
      #
      # * WE DO NOT SWALLOW THAT CLICK. This helper only ever watches the mouse - it
      #   never injects and never consumes. So the click lands in his game exactly as
      #   it would have anyway; we just also notice it and say "put it away". That is
      #   the whole reason Windows does not need Android's touch-swallowing layer.
      # * Not on OUR OWN windows: clicking the card's buttons (Save, the dictionary
      #   picker, the X) must not count as "click elsewhere", or the card would shut
      #   the instant he tried to use it. ProcAt is plain user32 - no UI Automation,
      #   so it costs nothing and works even where UIA is denied.
      $who = ProcAt $anchorX $anchorY
      if (-not ($SelfName.Length -gt 0 -and $who -eq $SelfName)) { Say '{"clear":true}' }
    }
    $pat = $null; $anchorR = $null; $dragging = $false; $dead = $false
    $tryOcr = $false; $ocrProc = ''
    $ocrWords = $null; $ocrLastX = -99999; $ocrLastY = -99999
  }

  $wasDown = $down
}
