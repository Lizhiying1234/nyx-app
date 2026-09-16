Android icon set
================

res/
  mipmap-anydpi-v26/
    ic_launcher.xml            adaptive icon (API 26+)
    ic_launcher_round.xml      same layers; launchers that ask for round
  mipmap-<density>/
    ic_launcher_background.png 108dp gradient plate, NO corner radius
    ic_launcher_foreground.png 108dp sparkles only, transparent
    ic_launcher_monochrome.png 108dp silhouette for Android 13 themed icons
    ic_launcher.png            legacy 48dp pre-masked square (API < 26)
    ic_launcher_round.png      legacy 48dp pre-masked circle (API < 26)
play_store_512.png             Play Console listing icon, no transparency

Install: drop the contents of res/ into app/src/main/res/, then make sure
AndroidManifest.xml points at it:

    <application
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher_round"
        ...>

Why the background layer has square corners
-------------------------------------------
Adaptive icons are masked by the launcher. Samsung uses a squircle, Pixel a
circle, others a teardrop or rounded square. If you bake a corner radius into
the background layer you get the icon's own corners clipped a second time,
which reads as a pale halo or a chipped edge. Ship it square and let the OS cut.

Safe zone
---------
The layers are 108dp. Only the centre 72dp is reliably visible and only a 66dp
circle is safe on every mask. The sparkles here sit inside 72dp, matching the
proportions of the Windows icon.
