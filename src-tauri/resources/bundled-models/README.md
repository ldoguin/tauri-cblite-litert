Drop any `.tflite` task model from `src/lib/taskModels.ts`'s `TASK_CATALOGUE`
here (filename must match the entry's `fileName` exactly) to ship it inside
the app package instead of relying on `handleDownload`. Originally meant for
the auth-gated / dead-link entries (`manualDownloadNote`, no `downloadUrl`:
`efficientnet_lite4.tflite`, `movenet_lightning_f16.tflite`,
`midas_v21_small_256.tflite`, `style_predict_f16.tflite`,
`style_transfer_f16.tflite`) — but any catalogue model can go here if you'd
rather bundle it than fetch it at runtime.

Any file placed in this directory is automatically:

- bundled into the desktop `.deb`/`.AppImage`/etc via `bundle.resources` in
  `../../tauri.conf.json`, and copied into `<app_local_data_dir>/models/` on
  first launch (see `seed_bundled_models()` in `../../src/lib.rs`)
- synced into the Android APK as a raw asset — Tauri's mobile build copies
  `bundle.resources` into `gen/android/app/src/main/assets/` automatically,
  no manual Gradle wiring needed — and extracted into the same `models/`
  directory on first launch via `tauri-plugin-litert`'s `extractBundledModels`
  Kotlin command

Once a file is here, `get_model_path` finds it immediately — no UI changes
needed, `TaskModelPanel.tsx` already treats anything `get_model_path` resolves
as "downloaded".

This directory's contents are gitignored except for this README and
`.placeholder.tflite` (keeps Tauri's resource glob non-empty when no real
models are present yet) — don't commit multi-hundred-MB model files to the
repo.
