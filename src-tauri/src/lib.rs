// lib.rs — Tauri application entry point.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

// ── Shared HTTP client (cookie store, browser UA) ────────────────────────────

/// Persistent reqwest client shared across all `fetch_url` calls.
/// Using a single client means cookies are retained between requests,
/// so SearXNG session cookies established on the first request are
/// reused on subsequent search requests — just like a browser would.
struct HttpClient(reqwest::Client);

// ── Active download cancellation ─────────────────────────────────────────────

/// Holds a cancellation sender for each in-progress download keyed by model ID.
struct Downloads(Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>);

impl Downloads {
    /// Locks the map, recovering from poison instead of panicking.
    /// A panic elsewhere while the lock was held must not turn every
    /// subsequent download/cancel call into a crash.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, tokio::sync::oneshot::Sender<()>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ── Event payload ─────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    model_id: String,
    received_bytes: u64,
    total_bytes: u64,
    fraction: f64,
}

// ── Path safety ───────────────────────────────────────────────────────────────

/// Joins `name` onto `base`, rejecting `..`, absolute paths, or any other
/// component that could let the resolved path escape `base`.
fn join_within(base: &std::path::Path, name: &str) -> Result<std::path::PathBuf, String> {
    let candidate = std::path::Path::new(name);
    let only_normal_components = candidate
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    if name.is_empty() || !only_normal_components {
        return Err(format!("invalid file name: {name}"));
    }
    Ok(base.join(candidate))
}

// ── Network safety ───────────────────────────────────────────────────────────

/// True for loopback, private, link-local, unspecified, or multicast
/// addresses — i.e. anything that isn't a routable public address.
/// `fetch_url` is exposed to agent tools that pass model-chosen URLs
/// (e.g. links found via web search), so it must not be usable to reach
/// internal services (localhost, RFC1918 ranges, cloud metadata
/// endpoints like 169.254.169.254, etc).
fn is_non_routable(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique local
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
        }
    }
}

/// Resolves `host:port` and rejects it if any resolved address is
/// non-routable. This is a best-effort SSRF guard (DNS rebinding between
/// this check and the actual connect is not addressed), but it blocks the
/// common cases: literal localhost/private-IP targets and hostnames that
/// only resolve internally.
async fn reject_non_routable_host(host: &str, port: u16) -> Result<(), String> {
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("resolve {host}: {e}"))?;
    for addr in addrs {
        if is_non_routable(addr.ip()) {
            return Err(format!("'{host}' resolves to a non-routable address"));
        }
    }
    Ok(())
}

// ── Bundled-model seeding ───────────────────────────────────────────────────
//
// Small task models that can't be auto-downloaded (Kaggle/TF-Hub auth walls,
// dead CDN links — see manualDownloadNote entries in src/lib/taskModels.ts)
// ship inside the app package instead. This copies them into
// <app_local_data_dir>/models/ on first launch so get_model_path finds them
// exactly as if download_model had fetched them. Idempotent: skips files
// that already exist at the destination.

fn copy_new_files(src_dir: &std::path::Path, dest_dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(src_dir) else { return };
    if let Err(e) = std::fs::create_dir_all(dest_dir) {
        eprintln!("warning: seed_bundled_models: create_dir_all {}: {e}", dest_dir.display());
        return;
    }
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("tflite") {
            continue;
        }
        let Some(name) = path.file_name() else { continue };
        // Skip the .placeholder.tflite that keeps Tauri's resources glob non-empty
        // when no real bundled models have been sourced yet.
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let dest = dest_dir.join(name);
        if dest.exists() {
            continue;
        }
        match std::fs::copy(&path, &dest) {
            Ok(_) => println!("info: seeded bundled model {}", dest.display()),
            Err(e) => eprintln!("warning: seed_bundled_models: copy {} -> {}: {e}", path.display(), dest.display()),
        }
    }
}

/// Desktop: bundle.resources (tauri.conf.json) places files at
/// <resource_dir>/bundled-models/. In `cargo run`/dev mode the bundler never
/// ran, so also check the source tree directly — lets the seeding path be
/// tested without a full release build.
///
/// Takes AppHandle (not &App) so it can run on a background thread spawned
/// from .setup() — the bundled set can be hundreds of MB, and blocking
/// .setup() on the copy/extract delays the window opening with no progress
/// indicator, which reads as a hung app on first launch.
#[cfg(not(target_os = "android"))]
fn seed_bundled_models(app: &AppHandle) {
    let data_dir = match app.path().app_local_data_dir() {
        Ok(d) => d,
        Err(e) => { eprintln!("warning: seed_bundled_models: app_local_data_dir: {e}"); return; }
    };
    let models_dir = data_dir.join("models");

    if let Ok(resource_dir) = app.path().resource_dir() {
        copy_new_files(&resource_dir.join("bundled-models"), &models_dir);
    }

    #[cfg(debug_assertions)]
    {
        let dev_src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/bundled-models");
        copy_new_files(&dev_src, &models_dir);
    }
}

/// Android: there is no filesystem-level resource dir — Tauri's mobile build
/// syncs bundle.resources (tauri.conf.json) into app/src/main/assets/
/// automatically, but reading APK assets requires the platform's
/// AssetManager, which only Kotlin can reach.
///
/// Takes AppHandle (not &App) so it can run on a background thread spawned
/// from .setup() — see the desktop variant's doc comment for why.
#[cfg(target_os = "android")]
fn seed_bundled_models(app: &AppHandle) {
    use tauri_plugin_litert::LiteRtExt;

    let data_dir = match app.path().app_local_data_dir() {
        Ok(d) => d,
        Err(e) => { eprintln!("warning: seed_bundled_models: app_local_data_dir: {e}"); return; }
    };
    let models_dir = data_dir.join("models");
    let target = models_dir.to_string_lossy().into_owned();

    match app.litert().extract_bundled_models(&target) {
        Ok(n) => if n > 0 { println!("info: seeded {n} bundled model(s) from APK assets") },
        Err(e) => eprintln!("warning: seed_bundled_models: extract_bundled_models: {e}"),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Download a model file to the app local data directory, emitting
/// `model-download-progress` events as bytes arrive.
/// Returns the absolute path to the saved file.
#[tauri::command]
async fn download_model(
    app: AppHandle,
    downloads: State<'_, Downloads>,
    model_id: String,
    url: String,
    file_name: String,
    hf_token: Option<String>,
) -> Result<String, String> {
    // Cancel any existing download for this model.
    let mut cancel_rx = {
        let mut map = downloads.lock();
        if let Some(tx) = map.remove(&model_id) {
            let _ = tx.send(());
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        map.insert(model_id.clone(), tx);
        rx
    };

    // Resolve destination: <appLocalDataDir>/models/<file_name>
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let models_dir = data_dir.join("models");
    tokio::fs::create_dir_all(&models_dir)
        .await
        .map_err(|e| format!("create models dir: {e}"))?;
    let dest = models_dir.join(&file_name);

    // Already fully downloaded — return immediately.
    if dest.exists() {
        downloads.lock().remove(&model_id);
        return Ok(dest.to_string_lossy().into_owned());
    }

    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if let Some(token) = &hf_token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let response = req.send().await.map_err(|e| format!("fetch {url}: {e}"))?;

    if !response.status().is_success() {
        downloads.lock().remove(&model_id);
        return Err(format!("HTTP {} for {url}", response.status()));
    }

    let total_bytes = response.content_length().unwrap_or(0);

    // Write to a .part file; rename on completion so a partial download is
    // never mistaken for a complete one.
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("create {}: {e}", tmp.display()))?;

    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut stream = response.bytes_stream();
    let mut received_bytes: u64 = 0;

    loop {
        // Race the next chunk against the cancellation signal.
        let chunk_result = tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err("cancelled".into());
            }
            result = stream.next() => result,
        };

        match chunk_result {
            None => break,
            Some(Err(e)) => {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp).await;
                downloads.lock().remove(&model_id);
                return Err(format!("stream error: {e}"));
            }
            Some(Ok(chunk)) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("write: {e}"))?;
                received_bytes += chunk.len() as u64;
                let fraction = if total_bytes > 0 {
                    received_bytes as f64 / total_bytes as f64
                } else {
                    0.0
                };
                let _ = app.emit(
                    "model-download-progress",
                    DownloadProgress {
                        model_id: model_id.clone(),
                        received_bytes,
                        total_bytes,
                        fraction,
                    },
                );
            }
        }
    }

    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    drop(file);
    tokio::fs::rename(&tmp, &dest)
        .await
        .map_err(|e| format!("rename to {}: {e}", dest.display()))?;

    downloads.lock().remove(&model_id);
    Ok(dest.to_string_lossy().into_owned())
}

/// Cancel an in-progress download.
#[tauri::command]
fn cancel_model_download(downloads: State<'_, Downloads>, model_id: String) {
    let mut map = downloads.lock();
    if let Some(tx) = map.remove(&model_id) {
        let _ = tx.send(());
    }
}

/// Check whether a model file exists in the app local data dir.
/// Returns the absolute path if present, null otherwise.
#[tauri::command]
async fn get_model_path(app: AppHandle, file_name: String) -> Result<Option<String>, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let path = join_within(&data_dir.join("models"), &file_name)?;
    Ok(if path.exists() { Some(path.to_string_lossy().into_owned()) } else { None })
}

/// Read and remove a JSON config import file.
/// Checks several candidate locations so it works regardless of how Tauri
/// maps app_data_dir on a given platform:
///   1. app_data_dir()/config.json          (internal storage on Android, standard on desktop)
///   2. /sdcard/Android/data/<pkg>/files/config.json  (external files dir on Android)
/// Returns the raw JSON string when found, null when absent.
#[tauri::command]
async fn read_config_import(app: AppHandle) -> Result<Option<String>, String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(d) = app.path().app_data_dir() {
        candidates.push(d.join("config.json"));
    }

    // Android external files dir fallback. The canonical API is
    // Environment.getExternalStorageDirectory() (not available via Tauri FFI),
    // which typically resolves to /storage/emulated/0 on modern devices.
    // We probe both common mount points; the first that exists wins.
    // This is a best-effort fallback — internal storage (candidate 0) is preferred.
    #[cfg(target_os = "android")]
    {
        let pkg = app.config().identifier.to_string();
        for root in &["/storage/emulated/0", "/sdcard"] {
            candidates.push(std::path::PathBuf::from(format!(
                "{root}/Android/data/{pkg}/files/config.json"
            )));
        }
    }

    for path in &candidates {
        if path.exists() {
            let contents = tokio::fs::read_to_string(path)
                .await
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            // Remove after reading so it only imports once.
            let _ = tokio::fs::remove_file(path).await;
            return Ok(Some(contents));
        }
    }
    Ok(None)
}

/// Fetch a URL server-side (bypasses WebView CORS restrictions on Android).
/// Uses the shared HTTP client with a persistent cookie store so that
/// session cookies (e.g. from SearXNG) are retained across requests.
/// Returns the response body as a UTF-8 string.
#[tauri::command]
async fn fetch_url(http: State<'_, HttpClient>, url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("unsupported scheme: {}", parsed.scheme()));
    }
    let host = parsed.host_str().ok_or_else(|| "url has no host".to_string())?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    reject_non_routable_host(host, port).await?;

    let response = http.0
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.5")
        .header("Accept-Encoding", "gzip, deflate, br")
        .send()
        .await
        .map_err(|e| format!("fetch {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} for {url}", response.status()));
    }
    response.text().await.map_err(|e| format!("read body: {e}"))
}

/// Save a base64-encoded PDF to {app_local_data_dir}/pdfs/<filename>.
/// Returns the absolute path to the saved file.
#[tauri::command]
async fn save_pdf(app: AppHandle, filename: String, data_b64: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let bytes = STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let pdfs_dir = data_dir.join("pdfs");
    tokio::fs::create_dir_all(&pdfs_dir)
        .await
        .map_err(|e| format!("create pdfs dir: {e}"))?;
    let dest = join_within(&pdfs_dir, &filename)?;
    tokio::fs::write(&dest, &bytes)
        .await
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Read a file and return its contents as a base64 string.
/// Used by the PDF tools to load stored PDFs for text extraction.
/// Restricted to files under {app_local_data_dir}/pdfs — the only place
/// `save_pdf` ever writes to — so this can't be used to read arbitrary
/// files on disk.
#[tauri::command]
async fn read_pdf_bytes(app: AppHandle, path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let pdfs_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?
        .join("pdfs");
    let canonical_pdfs_dir = tokio::fs::canonicalize(&pdfs_dir)
        .await
        .map_err(|e| format!("pdfs dir: {e}"))?;
    let canonical_path = tokio::fs::canonicalize(&path)
        .await
        .map_err(|e| format!("read {path}: {e}"))?;
    if !canonical_path.starts_with(&canonical_pdfs_dir) {
        return Err(format!("'{path}' is outside the pdfs directory"));
    }
    let bytes = tokio::fs::read(&canonical_path)
        .await
        .map_err(|e| format!("read {path}: {e}"))?;
    Ok(STANDARD.encode(&bytes))
}

/// Open a PDF file in the system viewer at the specified page (1-based).
/// On Linux tries evince then okular then xdg-open.
/// On macOS uses `open`. On Windows uses `start`.
#[tauri::command]
async fn open_pdf_page(path: String, page: u32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // evince supports --page-label (1-based page number)
        if std::process::Command::new("evince")
            .arg("--page-label")
            .arg(page.to_string())
            .arg(&path)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        // okular supports -p (1-based)
        if std::process::Command::new("okular")
            .arg("-p")
            .arg(page.to_string())
            .arg(&path)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        // Fallback: open without page support
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("xdg-open failed: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = page; // macOS open doesn't easily support page numbers
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        let _ = page;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("start failed: {e}"))?;
    }
    #[cfg(target_os = "android")]
    {
        let _ = (path, page);
        return Err("open_pdf_page not supported on Android".into());
    }
    Ok(())
}

/// Write a text file to a user-accessible location and return the path.
/// On Android: /sdcard/Android/data/<pkg>/files/<filename>  (ADB-accessible)
/// On desktop:  ~/Downloads/<filename>  (falls back to home dir)
#[tauri::command]
async fn write_export_file(app: AppHandle, filename: String, data: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    let dest = {
        // Prefer /storage/emulated/0 (canonical on API 29+); fall back to /sdcard symlink.
        let pkg = app.config().identifier.to_string();
        let root = if std::path::Path::new("/storage/emulated/0").exists() {
            "/storage/emulated/0"
        } else {
            "/sdcard"
        };
        std::path::PathBuf::from(format!("{root}/Android/data/{pkg}/files/{filename}"))
    };
    #[cfg(not(target_os = "android"))]
    let dest = {
        let dir = app
            .path()
            .download_dir()
            .or_else(|_| app.path().home_dir())
            .map_err(|e| format!("cannot resolve output dir: {e}"))?;
        join_within(&dir, &filename)?
    };

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    tokio::fs::write(&dest, data.as_bytes())
        .await
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Delete a cached model file from the app local data dir.
#[tauri::command]
async fn delete_model_file(app: AppHandle, file_name: String) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let path = join_within(&data_dir.join("models"), &file_name)?;
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Walk a folder and return all .litertlm files as `{name, path, capabilities?}` objects.
/// For each model, a sidecar `<stem>.json` is read if present and merged as `capabilities`.
#[tauri::command]
async fn scan_models(folder: String) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = std::path::Path::new(&folder);
        if !dir.is_dir() {
            return Err(format!("'{}' is not a directory", folder));
        }
        let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
        let mut models = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().map(|e| e == "litertlm").unwrap_or(false) {
                let stem = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
                let path = p.to_string_lossy().into_owned();
                // Try to read a sidecar JSON file alongside the model
                let sidecar_path = p.with_extension("json");
                let capabilities: Option<serde_json::Value> = sidecar_path
                    .exists()
                    .then(|| std::fs::read_to_string(&sidecar_path).ok())
                    .flatten()
                    .and_then(|s| serde_json::from_str(&s).ok());
                let mut entry = serde_json::json!({ "name": stem, "path": path });
                if let Some(caps) = capabilities {
                    entry["capabilities"] = caps;
                }
                models.push(entry);
            }
        }
        models.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(models)
    })
    .await
    .map_err(|e| format!("scan_models task: {e}"))?
}

/// Walk a folder and return all .tflite files as `{name, path}` objects.
#[tauri::command]
async fn scan_tflite_models(folder: String) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = std::path::Path::new(&folder);
        if !dir.is_dir() {
            return Ok(vec![]);
        }
        let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
        let mut models = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().map(|e| e == "tflite").unwrap_or(false) {
                let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let path = p.to_string_lossy().into_owned();
                models.push(serde_json::json!({ "name": name, "path": path }));
            }
        }
        models.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(models)
    })
    .await
    .map_err(|e| format!("scan_tflite_models task: {e}"))?
}

// ── App setup ─────────────────────────────────────────────────────────────────

/// Device RAM info — available and total, in bytes.
/// Reads /proc/meminfo on Linux and Android (same kernel interface).
/// Returns null on macOS and Windows (different APIs, not yet implemented).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryInfo {
    total_bytes: u64,
    available_bytes: u64,
}

#[tauri::command]
async fn get_memory_info() -> Option<MemoryInfo> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let text = tokio::fs::read_to_string("/proc/meminfo").await.ok()?;
        let mut total_kb: Option<u64> = None;
        let mut available_kb: Option<u64> = None;
        for line in text.lines() {
            let mut parts = line.split_ascii_whitespace();
            match parts.next() {
                Some("MemTotal:") => { total_kb = parts.next().and_then(|v| v.parse().ok()); }
                Some("MemAvailable:") => { available_kb = parts.next().and_then(|v| v.parse().ok()); }
                _ => {}
            }
            if total_kb.is_some() && available_kb.is_some() { break; }
        }
        Some(MemoryInfo {
            total_bytes: total_kb? * 1024,
            available_bytes: available_kb? * 1024,
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    { None }
}

/// Open a URL in the OS default browser.
/// Uses platform-native launchers: xdg-open (Linux), open (macOS), start (Windows).
/// Android is intentionally a no-op — the WebView there handles links normally.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd").args(["/c", "start", "", &url]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // On Linux, the LiteRT WebGPU (Vulkan) backend and the WebKit compositor
    // both try to use Vulkan on the same iGPU, causing a Wayland compositor
    // crash when large models are loaded.  Force WebKit into software
    // compositing so the GPU is exclusively available to LiteRT inference.
    // Also disable the OpenCL ICD loader — it conflicts with WebGPU/Vulkan
    // context creation on AMD RDNA2.
    // On Linux with AMD iGPU (RDNA2/3): loading large GPU models via LiteRT's
    // WebGPU (Vulkan) backend causes the Wayland compositor to crash when the
    // GTK/WebKit stack also holds Vulkan resources on the same device.  Force
    // the entire GTK rendering stack onto software (Cairo/CPU) so the GPU is
    // exclusively available to LiteRT inference.
    // OCL_ICD_VENDORS=/dev/null prevents OpenCL from conflicting with the
    // WebGPU/Vulkan context on AMD hardware.
    // On Linux with AMD iGPU (RDNA2/3): when LiteRT-LM loads a large GPU model
    // via WebGPU/Vulkan, the RADV driver crashes if the Tauri app also holds a
    // native-Wayland display connection (GTK Wayland WSI + Vulkan compute on
    // the same device conflict).  Forcing GDK_BACKEND=x11 makes GTK/WebKitGTK
    // use XWayland for its display connection instead, so RADV's compute path
    // is the only Vulkan user.  The user's compositor and desktop stay running.
    // We also force software rendering so GTK itself never touches the GPU.
    // OCL_ICD_VENDORS=/dev/null disables OpenCL ICD discovery to prevent the
    // OpenCL runtime from conflicting with WebGPU/Vulkan on AMD hardware.
    // On Linux with AMD iGPU (RDNA2/3): Dawn (LiteRT's WebGPU backend)
    // initialises Vulkan with Wayland WSI extensions when WAYLAND_DISPLAY is
    // set, which conflicts with the AMD RADV driver when another GPU context
    // (GTK/WebKit) is also active on the same device.
    //
    // Fix strategy:
    // 1. GDK_BACKEND=x11 — GTK/WebKit uses X11 (XWayland) not native Wayland.
    // 2. WAYLAND_DISPLAY="" — hides the Wayland socket from Dawn so it creates
    //    a headless/compute-only Vulkan instance without WSI extensions.
    // 3. GSK/GDK software rendering — GTK itself never touches the GPU.
    // 4. OCL_ICD_VENDORS=/dev/null — disables OpenCL ICD discovery to prevent
    //    the OpenCL runtime from conflicting with WebGPU/Vulkan on AMD hardware.
    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("OCL_ICD_VENDORS", "/dev/null");
        std::env::set_var("GDK_BACKEND", "x11");
        std::env::set_var("WAYLAND_DISPLAY", "");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("GSK_RENDERER", "cairo");
        std::env::set_var("GDK_RENDERING", "image");
    }

    // Fall back to a bare-default client (no custom UA/cookie store) rather
    // than crashing app startup if the configured client fails to build
    // (e.g. a broken TLS backend on the host).
    let http_client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|e| {
            eprintln!("warning: failed to build configured HTTP client ({e}), using default");
            reqwest::Client::new()
        });

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_cblite::init())
        .plugin(tauri_plugin_litert::init());

    builder
        .manage(HttpClient(http_client))
        .manage(Downloads(Mutex::new(HashMap::new())))
        // Grant microphone/camera (getUserMedia) requests from the WebView —
        // used by wake-word detection, voice input, and the background-removal
        // camera preview. On Linux/WebKitGTK these are denied by default unless
        // the app explicitly allows the UserMediaPermissionRequest signal.
        // Every other permission kind (geolocation, notifications, pointer
        // lock, etc) is explicitly denied rather than blanket-allowed — this
        // app only ever needs user-media access.
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{glib::Cast, PermissionRequestExt, UserMediaPermissionRequest, WebViewExt};
                let window = app.get_webview_window("main")
                    .expect("main window not found");
                window.with_webview(|wv| {
                    wv.inner().connect_permission_request(|_view, req| {
                        if req.downcast_ref::<UserMediaPermissionRequest>().is_some() {
                            req.allow();
                        } else {
                            req.deny();
                        }
                        true
                    });
                })?;
            }
            // Spawned, not called inline: the bundled set can be hundreds of
            // MB (Android extraction goes through a blocking JNI round-trip),
            // and blocking .setup() on it delays the window opening with no
            // progress indicator — looks like a hung app on first launch.
            let seed_handle = app.handle().clone();
            std::thread::spawn(move || {
                seed_bundled_models(&seed_handle);
                let _ = seed_handle.emit("bundled-models-seeded", ());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            download_model,
            cancel_model_download,
            get_model_path,
            delete_model_file,
            read_config_import,
            fetch_url,
            save_pdf,
            read_pdf_bytes,
            open_pdf_page,
            write_export_file,
            scan_models,
            scan_tflite_models,
            open_url,
            get_memory_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    // ── join_within: path-traversal guard used by save_pdf, write_export_file,
    // delete_model_file, and get_model_path ──────────────────────────────────

    #[test]
    fn join_within_accepts_plain_filenames() {
        let base = std::path::Path::new("/data/pdfs");
        assert_eq!(
            join_within(base, "report.pdf").unwrap(),
            std::path::PathBuf::from("/data/pdfs/report.pdf")
        );
    }

    #[test]
    fn join_within_accepts_nested_normal_components() {
        let base = std::path::Path::new("/data/pdfs");
        assert_eq!(
            join_within(base, "sub/dir/report.pdf").unwrap(),
            std::path::PathBuf::from("/data/pdfs/sub/dir/report.pdf")
        );
    }

    #[test]
    fn join_within_rejects_parent_dir_traversal() {
        let base = std::path::Path::new("/data/pdfs");
        assert!(join_within(base, "../../../etc/passwd").is_err());
        assert!(join_within(base, "../evil.txt").is_err());
        assert!(join_within(base, "a/../../b").is_err());
    }

    #[test]
    fn join_within_rejects_absolute_paths() {
        let base = std::path::Path::new("/data/pdfs");
        assert!(join_within(base, "/etc/passwd").is_err());
        assert!(join_within(base, "/etc/cron.d/evil").is_err());
    }

    #[test]
    fn join_within_rejects_empty_name() {
        let base = std::path::Path::new("/data/pdfs");
        assert!(join_within(base, "").is_err());
    }

    // ── is_non_routable / reject_non_routable_host: SSRF guard for fetch_url ──

    #[test]
    fn is_non_routable_blocks_loopback() {
        assert!(is_non_routable("127.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_non_routable("::1".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn is_non_routable_blocks_private_ranges() {
        assert!(is_non_routable("10.1.2.3".parse::<IpAddr>().unwrap()));
        assert!(is_non_routable("172.16.0.5".parse::<IpAddr>().unwrap()));
        assert!(is_non_routable("192.168.1.1".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn is_non_routable_blocks_link_local_and_cloud_metadata() {
        // 169.254.169.254 is the AWS/GCP/Azure instance-metadata endpoint —
        // the classic SSRF target for stealing cloud credentials.
        assert!(is_non_routable("169.254.169.254".parse::<IpAddr>().unwrap()));
        assert!(is_non_routable("fe80::1".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn is_non_routable_blocks_unspecified_and_unique_local_v6() {
        assert!(is_non_routable("0.0.0.0".parse::<IpAddr>().unwrap()));
        assert!(is_non_routable("::".parse::<IpAddr>().unwrap()));
        assert!(is_non_routable("fc00::1".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn is_non_routable_allows_public_addresses() {
        assert!(!is_non_routable("8.8.8.8".parse::<IpAddr>().unwrap()));
        assert!(!is_non_routable("1.1.1.1".parse::<IpAddr>().unwrap()));
        assert!(!is_non_routable(
            "2606:4700:4700::1111".parse::<IpAddr>().unwrap()
        ));
    }

    // reject_non_routable_host resolves via tokio::net::lookup_host. IP
    // literals resolve without any real DNS/network I/O, so these stay
    // hermetic and safe to run offline/in CI.

    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fut)
    }

    #[test]
    fn reject_non_routable_host_blocks_loopback_literal() {
        let result = block_on(reject_non_routable_host("127.0.0.1", 80));
        assert!(result.is_err());
    }

    #[test]
    fn reject_non_routable_host_blocks_cloud_metadata_literal() {
        let result = block_on(reject_non_routable_host("169.254.169.254", 80));
        assert!(result.is_err());
    }

    #[test]
    fn reject_non_routable_host_allows_public_ip_literal() {
        let result = block_on(reject_non_routable_host("8.8.8.8", 80));
        assert!(result.is_ok());
    }
}
