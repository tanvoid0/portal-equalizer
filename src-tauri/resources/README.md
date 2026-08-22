# Bundled engine installer

Drop Equalizer APO's official installer in this folder and the release will
carry it, so users never leave the app to get the DSP engine.

    src-tauri/resources/EqualizerAPO64-1.4.exe

Any file here whose name starts with `EqualizerAPO` and ends in `.exe` is
picked up — the version in the filename does not matter, so a newer installer
needs no code change. Get it from
<https://sourceforge.net/projects/equalizerapo/>.

Leave the folder empty and everything still builds. `install_engine` falls back
to opening the download page, and `eapo_status.installer_bundled` reports
`false` so the UI says so.

Equalizer APO is a separate program under its own licence. We ship its
installer unmodified and never link against it — we generate its `config.txt`,
which is plain text. Before publishing a build that includes the binary, put
its licence file next to it here and check the source-offer obligation.
