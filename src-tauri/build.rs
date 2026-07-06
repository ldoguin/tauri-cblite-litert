fn main() {
    tauri_build::build();

    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux")   => linux_fixups(),
        Ok("macos")   => macos_fixups(),
        Ok("windows") => windows_fixups(),
        _ => {}
    }
}

// ── macOS runtime library fixups ─────────────────────────────────────────────
//
// `rustc-link-arg` emitted by a build script is NOT propagated transitively
// to the final binary — only the crate that emits it gets the flag.
// We must re-emit every rpath here so dyld can find the dylibs at runtime.
//
// DEP_ variable naming rules:
//   - sys crates with `links = "Foo"` → DEP_FOO_<KEY>
//   - non-sys crates (no `links`)     → DEP_<PACKAGE_NAME_UPPER>_<KEY>
//     (hyphens in package name → underscores)
//
// litert-lm-sys  links="LiteRtLm"  → DEP_LITERTLM_LIB_DIR  (libLiteRtLmC dir)
// litert-sys     links="LiteRt"    → DEP_LITERT_LIB_DIR     (libLiteRt dir)
//
// litertlm (no links) re-exports both as:
//   cargo:lib_dir        → DEP_LITERTLM_LIB_DIR      (LM dylib dir)
//   cargo:litert_lib_dir → DEP_LITERTLM_LITERT_LIB_DIR (base LiteRt dir)
fn macos_fixups() {
    // libLiteRtLmC.dylib — re-exported by litertlm's build.rs as cargo:lib_dir
    println!("cargo:rerun-if-env-changed=DEP_LITERTLM_LIB_DIR");
    if let Ok(dir) = std::env::var("DEP_LITERTLM_LIB_DIR") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    }

    // libLiteRt.dylib + accelerators — re-exported by litertlm as cargo:litert_lib_dir
    println!("cargo:rerun-if-env-changed=DEP_LITERTLM_LITERT_LIB_DIR");
    if let Ok(dir) = std::env::var("DEP_LITERTLM_LITERT_LIB_DIR") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    }
}

// ── Windows runtime library fixups ───────────────────────────────────────────
//
// On Windows the dynamic linker uses PATH, not rpath. The build scripts copy
// the DLLs next to the binary via rustc-link-search, which is sufficient for
// `cargo run`. For `tauri build` the bundler copies them via tauri.conf.json
// `externalBin` / `resources`. No rpath emission needed.
// ── Windows runtime DLL fixups ────────────────────────────────────────────────
//
// Windows has no rpath. The dynamic linker searches the directory containing
// the executable, then PATH. For both `cargo tauri dev` and `tauri build` the
// binary lands in target/<profile>/; we copy DLLs there directly so they are
// found at runtime without any PATH manipulation.
//
// DLLs required at runtime:
//   litert-sys prebuilts → libLiteRt.dll, libLiteRtWebGpuAccelerator.dll,
//                          libLiteRtTopKWebGpuSampler.dll
//   cblite git checkout  → cblite.dll
//
// litert-lm-sys has no Windows DLL (WASM fallback); its stubs are pure Rust.
//
// We cannot rely on litert-sys having already populated its cache: Cargo does
// not guarantee build-script ordering for transitive dependencies unless there
// is a `links` edge. Instead we download the DLLs ourselves into our own cache
// using the same GitHub LFS OIDs that litert-sys uses, then copy them to the
// binary output directory.
//
// OUT_DIR is  target/<profile>/build/<crate>-<hash>/out/
// The binary is target/<profile>/  →  three levels up from OUT_DIR.

// These OIDs and sizes must match WINDOWS_X86_64 in litert-sys/build.rs.
const WIN_DLLS: &[(&str, &str, u64)] = &[
    (
        "libLiteRt.dll",
        "d87f00b4161046f23c911fe8f64224bcbdff8399be792bcb62bf95b52cbbccc5",
        11_013_632,
    ),
    (
        "libLiteRtWebGpuAccelerator.dll",
        "69a8b4671fe5f9f16054b5be211c484d954b95fbf459359d445319c6039b176b",
        21_816_320,
    ),
    (
        "libLiteRtTopKWebGpuSampler.dll",
        "31cfc379259d553ea4eeb7f4f949f116629b4882feafce343de57d2e837b3903",
        16_971_776,
    ),
];
const LITERT_SYS_WIN_TAG: &str = "v0.10.2"; // must match litert-sys LITERT_LM_TAG

fn windows_fixups() {
    println!("cargo:rerun-if-env-changed=DEP_LITERTLM_LIB_DIR");
    println!("cargo:rerun-if-env-changed=DEP_LITERTLM_LITERT_LIB_DIR");

    let target     = std::env::var("TARGET").unwrap_or_default();
    let cache_root = cache_root();
    let cargo_home = cargo_home();

    // Derive the profile output directory (target/debug/ or target/release/)
    // from OUT_DIR: out/ → <hash>/ → build/ → <profile>/
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let bin_dir = out_dir.ancestors().nth(3)
        .expect("OUT_DIR has unexpected depth")
        .to_path_buf();

    // ── litert-sys DLLs ───────────────────────────────────────────────────────
    // Cache under the same path litert-sys uses so both share the download.
    let litert_cache = cache_root
        .join("litert-sys")
        .join(LITERT_SYS_WIN_TAG)
        .join(&target);
    std::fs::create_dir_all(&litert_cache).expect("create litert-sys cache dir");

    // Resolve download URLs for any DLLs not yet cached via the LFS batch API.
    let missing: Vec<_> = WIN_DLLS.iter()
        .filter(|(name, _, size)| file_size(&litert_cache.join(name)) != *size)
        .collect();

    if !missing.is_empty() {
        let urls = resolve_lfs_urls_windows(&missing);
        for (name, _oid, _size) in &missing {
            let url = urls.get(*name)
                .unwrap_or_else(|| panic!("no LFS URL resolved for {name}"));
            let dest = litert_cache.join(name);
            println!("cargo:warning=build.rs: downloading {name} ({} bytes, first build only)",
                     WIN_DLLS.iter().find(|(n,_,_)| n == name).unwrap().2);
            download_file(&dest, url);
        }
    }

    for (dll, _, _) in WIN_DLLS {
        let src = litert_cache.join(dll);
        println!("cargo:rerun-if-changed={}", src.display());
        if src.exists() {
            let dst = bin_dir.join(dll);
            if file_size(&src) != file_size(&dst) {
                std::fs::copy(&src, &dst)
                    .unwrap_or_else(|e| panic!("copy {dll} to bin dir: {e}"));
            }
        }
    }

    // ── cblite.dll ────────────────────────────────────────────────────────────
    let cblite_dll = (|| {
        let checkouts = cargo_home.join("git").join("checkouts");
        let entries = std::fs::read_dir(&checkouts).ok()?;
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with("couchbase-lite-rust") {
                continue;
            }
            if let Ok(commits) = std::fs::read_dir(entry.path()) {
                for commit in commits.flatten() {
                    let candidate = commit.path()
                        .join("libcblite_community")
                        .join("lib")
                        .join(&target)
                        .join("cblite.dll");
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    })();

    match cblite_dll {
        Some(src) => {
            println!("cargo:rerun-if-changed={}", src.display());
            let dst = bin_dir.join("cblite.dll");
            if file_size(&src) != file_size(&dst) {
                std::fs::copy(&src, &dst)
                    .unwrap_or_else(|e| panic!("copy cblite.dll to bin dir: {e}"));
            }
        }
        None => {
            println!("cargo:warning=build.rs: cblite.dll not found in cargo git checkouts");
        }
    }

    // Belt-and-suspenders: also emit link-search for the bin dir so the linker
    // can resolve DLL import stubs (litert-sys already emits its cache dir).
    println!("cargo:rustc-link-search=native={}", bin_dir.display());
}

/// Resolve GitHub LFS download URLs for the given Windows DLL entries via the
/// LFS batch API. Returns a map of filename → download URL.
fn resolve_lfs_urls_windows(
    files: &[&(&'static str, &'static str, u64)],
) -> std::collections::HashMap<&'static str, String> {
    #[derive(serde::Deserialize)]
    struct BatchResp { objects: Vec<LfsObj> }
    #[derive(serde::Deserialize)]
    struct LfsObj { oid: String, actions: Option<LfsActions>, error: Option<LfsError> }
    #[derive(serde::Deserialize)]
    struct LfsActions { download: LfsHref }
    #[derive(serde::Deserialize)]
    struct LfsHref { href: String }
    #[derive(serde::Deserialize)]
    struct LfsError { message: String }

    let objects: Vec<_> = files.iter().map(|(_, oid, size)| {
        serde_json::json!({ "oid": oid, "size": size })
    }).collect();

    let body = serde_json::json!({
        "operation": "download",
        "transfers": ["basic"],
        "objects": objects,
    }).to_string();

    let resp = ureq::post(
        "https://github.com/google-ai-edge/litert-lm.git/info/lfs/objects/batch"
    )
    .set("Accept", "application/vnd.git-lfs+json")
    .set("Content-Type", "application/vnd.git-lfs+json")
    .send_string(&body)
    .unwrap_or_else(|e| panic!("LFS batch request failed: {e}"));

    let parsed: BatchResp = serde_json::from_reader(resp.into_reader())
        .expect("parse LFS batch response");

    // Build oid → url map, then re-key by filename.
    let oid_to_url: std::collections::HashMap<_, _> = parsed.objects.into_iter()
        .map(|obj| {
            if let Some(err) = obj.error {
                panic!("LFS server refused oid {}: {}", obj.oid, err.message);
            }
            let href = obj.actions
                .unwrap_or_else(|| panic!("LFS object {} has no actions", obj.oid))
                .download.href;
            (obj.oid, href)
        })
        .collect();

    files.iter().map(|(name, oid, _)| {
        let url = oid_to_url.get(*oid)
            .unwrap_or_else(|| panic!("LFS batch response missing URL for {name}"))
            .clone();
        (*name, url)
    }).collect()
}

// ── Linux runtime library fixups ─────────────────────────────────────────────
//
// Strategy: copy all prebuilt .so files that have broken or missing runtime
// paths into OUT_DIR, patch libLiteRtLmC.so's RUNPATH to $ORIGIN, and emit
// a single rpath pointing to OUT_DIR. This avoids hardcoding any absolute
// home-directory paths into the binary — OUT_DIR is inside the build tree
// and the rpath is written as an absolute path to the current machine's
// OUT_DIR, which is correct for the binary built on that machine.
//
// The download is cached in the litert-sys cache dir so it only happens once
// per machine regardless of how many times the build runs.

// libGemmaModelConstraintProvider.so and libLiteRtTopKWebGpuSampler.so come from
// the LiteRT-LM git LFS prebuilt dir (no GCS equivalent).
const LITERT_TAG: &str = "v0.13.1";
// libLiteRtTopKWebGpuSampler.so from this tag (LiteRT-LM git LFS).
const WEBGPU_TAG: &str = "v0.13.1";

// libLiteRt.so and libLiteRtWebGpuAccelerator.so must match LITERTLM_CACHE_TAG
// (libLiteRtLmC.so).  Using mismatched versions (e.g. accel v0.10.1 with LM
// v0.13.1) causes a SIGSEGV in LiteRT-LM's execution thread because the LM
// engine calls through function pointers that don't exist in the older accel.
const LITERT_GCS_VERSION: &str = "2.1.5";
const LITERT_GCS_BASE: &str = "https://storage.googleapis.com/litert/binaries";
const WEBGPU_ACCEL_TAG: &str = "v0.13.1";

// libLiteRtLmC.so comes from the litert-lm-sys crate's own cache (its build.rs
// hardcodes the version it downloads).  This must match litert-lm-sys's LITERT_LM_VERSION.
const LITERTLM_CACHE_TAG: &str = "v0.13.1";
const GEMMA_LIB: &str = "libGemmaModelConstraintProvider.so";
const LITERTLM_LIB: &str = "libLiteRtLmC.so";

fn linux_fixups() {
    let target     = std::env::var("TARGET").unwrap_or_default();
    let out_dir    = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let cache_root = cache_root();
    let cargo_home = cargo_home();

    let litert_cache   = cache_root.join("litert-sys")   .join(LITERT_TAG).join(&target);
    let litertlm_cache = cache_root.join("litert-lm-sys").join(LITERTLM_CACHE_TAG).join(&target);

    // ── cblite rpath (its own cache dir is fine — absolute path from this machine) ──
    let cblite_git = cargo_home.join("git").join("checkouts");
    if cblite_git.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&cblite_git) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with("couchbase-lite-rust") {
                    if let Ok(commits) = std::fs::read_dir(entry.path()) {
                        for commit in commits.flatten() {
                            let lib_dir = commit.path()
                                .join("libcblite_community").join("lib").join(&target);
                            if lib_dir.is_dir() {
                                println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
                            }
                        }
                    }
                }
            }
        }
    }

    let upstream_dir = match target.as_str() {
        "x86_64-unknown-linux-gnu"  => "linux_x86_64",
        "aarch64-unknown-linux-gnu" => "linux_arm64",
        other => {
            println!("cargo:warning=build.rs: no LiteRT extras for target {other}");
            println!("cargo:rerun-if-changed={}", litertlm_cache.display());
            return;
        }
    };

    std::fs::create_dir_all(&litert_cache).expect("create litert-sys cache dir");
    std::fs::create_dir_all(&litertlm_cache).expect("create litert-lm-sys cache dir");

    // ── Download libGemmaModelConstraintProvider.so into the cache (once) ──
    let gemma_cache = litert_cache.join(GEMMA_LIB);
    if !gemma_cache.exists() {
        let url = format!(
            "https://media.githubusercontent.com/media/google-ai-edge/LiteRT-LM/{}/prebuilt/{}/{}",
            LITERT_TAG, upstream_dir, GEMMA_LIB,
        );
        download_file(&gemma_cache, &url);
    }

    // ── Copy libLiteRtLmC.so + libGemmaModelConstraintProvider.so into OUT_DIR ──
    // OUT_DIR is machine-local and inside the build tree. The rpath we emit
    // points to OUT_DIR as an absolute path on THIS machine — no hardcoded
    // home directories from a different machine (e.g. the devcontainer).
    //
    // libLiteRtLmC.so is patched to $ORIGIN so it finds the Gemma library
    // in the same OUT_DIR directory.

    let litertlm_src = litertlm_cache.join(LITERTLM_LIB);

    // Rerun when the upstream file appears (litert-lm-sys downloads it on
    // the same build; Cargo re-runs us next build once it exists).
    println!("cargo:rerun-if-changed={}", litertlm_src.display());
    println!("cargo:rerun-if-changed={}", litert_cache.display());
    println!("cargo:rerun-if-changed={}", litertlm_cache.display());

    if !litertlm_src.exists() {
        println!("cargo:warning=build.rs: {LITERTLM_LIB} not in cache yet — \
                  will be set up on next build after litert-lm-sys downloads it.");
        return;
    }

    // Copy Gemma lib into OUT_DIR.
    let gemma_out = out_dir.join(GEMMA_LIB);
    if !gemma_out.exists() {
        std::fs::copy(&gemma_cache, &gemma_out)
            .unwrap_or_else(|e| panic!("copy {GEMMA_LIB} to OUT_DIR: {e}"));
    }

    // Copy libLiteRt.so from the litert-sys v0.10.2 cache into OUT_DIR.
    //
    // libLiteRtTopKWebGpuSampler.so (and libLiteRtWebGpuAccelerator.so) have
    // NEEDED = libLiteRt.so.  When they are dlopen'd by libLiteRtLmC.so the
    // dynamic linker searches the dlopen'd library's own RUNPATH, not the main
    // binary's.  Placing libLiteRt.so in OUT_DIR (== $ORIGIN after we patch the
    // dependent libs below) ensures it is found without LD_LIBRARY_PATH.
    //
    // All three libs (libLiteRtLmC.so, libLiteRt.so, libLiteRtWebGpuAccelerator.so)
    // must come from the same v0.13.1 generation to avoid ABI mismatches.
    let litertlm_lmsys_tag = "v0.13.1"; // must match LITERTLM_CACHE_TAG / WEBGPU_ACCEL_TAG
    let litert_v10_cache = cache_root.join("litert-sys").join(litertlm_lmsys_tag).join(&target);
    std::fs::create_dir_all(&litert_v10_cache).expect("create litert v0.10 cache dir");
    let litert_base_cache = litert_v10_cache.join("libLiteRt.so");
    if !litert_base_cache.exists() {
        // litert-sys hasn't run yet; download directly from LiteRT-LM git LFS
        // (same source the crate uses, OID matches litert-sys-0.2.1 LINUX_X86_64 spec).
        let url = format!(
            "https://media.githubusercontent.com/media/google-ai-edge/LiteRT-LM/{}/prebuilt/{}/libLiteRt.so",
            litertlm_lmsys_tag, upstream_dir,
        );
        download_file(&litert_base_cache, &url);
    }
    let litert_base_out = out_dir.join("libLiteRt.so");
    if file_size(&litert_base_cache) != file_size(&litert_base_out) {
        std::fs::copy(&litert_base_cache, &litert_base_out)
            .unwrap_or_else(|e| panic!("copy libLiteRt.so to OUT_DIR: {e}"));
    }

    // libLiteRtWebGpuAccelerator.so — pinned to v0.10.1 (LiteRT-LM git LFS).
    // Post-v0.10.2 versions call LiteRtGetEnvironmentOptionsValue with a tag enum
    // value added after v0.10.2, causing SIGSEGV due to ABI mismatch with
    // libLiteRtLmC.so v0.10.2.  v0.10.1 fails gracefully (EngineCreationFailed).
    let webgpu_accel_lm_cache = cache_root
        .join("litert-lm-sys-webgpu").join(WEBGPU_ACCEL_TAG).join(&target);
    std::fs::create_dir_all(&webgpu_accel_lm_cache).expect("create webgpu-accel cache dir");
    let webgpu_accel_cache = webgpu_accel_lm_cache.join("libLiteRtWebGpuAccelerator.so");
    if !webgpu_accel_cache.exists() {
        let url = format!(
            "https://media.githubusercontent.com/media/google-ai-edge/LiteRT-LM/{}/prebuilt/{}/libLiteRtWebGpuAccelerator.so",
            WEBGPU_ACCEL_TAG, upstream_dir,
        );
        download_file(&webgpu_accel_cache, &url);
    }
    let webgpu_accel_out = out_dir.join("libLiteRtWebGpuAccelerator.so");
    if file_size(&webgpu_accel_cache) != file_size(&webgpu_accel_out) {
        std::fs::copy(&webgpu_accel_cache, &webgpu_accel_out)
            .unwrap_or_else(|e| panic!("copy libLiteRtWebGpuAccelerator.so to OUT_DIR: {e}"));
        patch_runpath(&webgpu_accel_out);
    }

    // libLiteRtTopKWebGpuSampler.so — only available from LiteRT-LM git LFS (not in GCS).
    // Carries Bazel RUNPATH; patch to $ORIGIN so it finds libLiteRt.so in OUT_DIR.
    let webgpu_cache = cache_root.join("litert-lm-sys-webgpu").join(WEBGPU_TAG).join(&target);
    std::fs::create_dir_all(&webgpu_cache).expect("create webgpu cache dir");

    let topk_cached = webgpu_cache.join("libLiteRtTopKWebGpuSampler.so");
    if !topk_cached.exists() {
        let url = format!(
            "https://media.githubusercontent.com/media/google-ai-edge/LiteRT-LM/{}/prebuilt/{}/libLiteRtTopKWebGpuSampler.so",
            WEBGPU_TAG, upstream_dir,
        );
        download_file(&topk_cached, &url);
    }
    let topk_out = out_dir.join("libLiteRtTopKWebGpuSampler.so");
    if file_size(&topk_cached) != file_size(&topk_out) {
        std::fs::copy(&topk_cached, &topk_out)
            .unwrap_or_else(|e| panic!("copy libLiteRtTopKWebGpuSampler.so to OUT_DIR: {e}"));
        patch_runpath(&topk_out);
    }

    // Copy libLiteRtLmC.so into OUT_DIR and patch its RUNPATH to $ORIGIN.
    let litertlm_out = out_dir.join(LITERTLM_LIB);
    let needs_copy = !litertlm_out.exists()
        || file_size(&litertlm_src) != file_size(&litertlm_out);
    if needs_copy {
        std::fs::copy(&litertlm_src, &litertlm_out)
            .unwrap_or_else(|e| panic!("copy {LITERTLM_LIB} to OUT_DIR: {e}"));
        patch_runpath(&litertlm_out);
    }

    // Also emit rpath for litert-sys cache (libLiteRt.so etc.)
    if litert_cache.is_dir() {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", litert_cache.display());
    }

    // OUT_DIR contains our patched libLiteRtLmC.so + libGemmaModelConstraintProvider.so.
    // This path is absolute and correct for the machine running this build.
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", out_dir.display());
    println!("cargo:rustc-link-search=native={}", out_dir.display());

    // ── Populate bundle-libs/ for Tauri's deb bundler ────────────────────────
    // tauri.conf.json references bundle-libs/*.so as the source files for the
    // deb `files` section. build.rs runs before the Tauri bundler, so copying
    // here ensures the files exist when Tauri packages the .deb.
    let bundle_libs = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").unwrap()
    ).join("bundle-libs");
    std::fs::create_dir_all(&bundle_libs).expect("create bundle-libs dir");

    for name in &[
        "libLiteRtLmC.so",
        "libGemmaModelConstraintProvider.so",
        "libLiteRt.so",
        "libLiteRtWebGpuAccelerator.so",
        "libLiteRtTopKWebGpuSampler.so",
    ] {
        let src = out_dir.join(name);
        let dst = bundle_libs.join(name);
        if src.exists() && file_size(&src) != file_size(&dst) {
            std::fs::copy(&src, &dst)
                .unwrap_or_else(|e| panic!("copy {name} to bundle-libs: {e}"));
        }
    }

    // libcblite.so.4 — find it in the cargo git checkout.
    let cblite_so = (|| {
        let entries = std::fs::read_dir(&cblite_git).ok()?;
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with("couchbase-lite-rust") {
                continue;
            }
            if let Ok(commits) = std::fs::read_dir(entry.path()) {
                for commit in commits.flatten() {
                    let candidate = commit.path()
                        .join("libcblite_community").join("lib").join(&target)
                        .join("libcblite.so.4");
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    })();
    if let Some(src) = cblite_so {
        let dst = bundle_libs.join("libcblite.so.4");
        if file_size(&src) != file_size(&dst) {
            std::fs::copy(&src, &dst)
                .unwrap_or_else(|e| panic!("copy libcblite.so.4 to bundle-libs: {e}"));
        }
    } else {
        println!("cargo:warning=build.rs: libcblite.so.4 not found in cargo git checkouts");
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn cache_root() -> std::path::PathBuf {
    std::env::var("XDG_CACHE_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::PathBuf::from(std::env::var("HOME").expect("HOME not set")).join(".cache")
        })
}

fn cargo_home() -> std::path::PathBuf {
    std::env::var("CARGO_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::PathBuf::from(std::env::var("HOME").expect("HOME not set")).join(".cargo")
        })
}

fn file_size(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn download_file(dest: &std::path::Path, url: &str) {
    println!("cargo:warning=build.rs: downloading {} ...",
             dest.file_name().unwrap().to_string_lossy());
    let resp = ureq::get(url)
        .call()
        .unwrap_or_else(|e| panic!("Failed to download {url}: {e}"));
    let mut bytes: Vec<u8> = Vec::new();
    std::io::Read::read_to_end(&mut resp.into_reader(), &mut bytes)
        .expect("read download body");
    std::fs::write(dest, &bytes)
        .unwrap_or_else(|e| panic!("write {}: {e}", dest.display()));
    println!("cargo:warning=build.rs: saved {} ({} bytes)", dest.display(), bytes.len());
}

fn patch_runpath(so: &std::path::Path) {
    match std::process::Command::new("patchelf")
        .args(["--print-rpath", so.to_str().unwrap()])
        .output()
    {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            patch_runpath_native(so);
            return;
        }
        Err(e) => panic!("patchelf --print-rpath: {e}"),
        Ok(out) if out.stdout.trim_ascii_end() == b"$ORIGIN" => return,
        Ok(_) => {}
    }
    let st = std::process::Command::new("patchelf")
        .args(["--set-rpath", "$ORIGIN", so.to_str().unwrap()])
        .status().expect("patchelf --set-rpath");
    assert!(st.success(), "patchelf exited {st}");
    println!("cargo:warning=build.rs: patched RUNPATH of {} to $ORIGIN", so.display());
}

// Pure-Rust fallback: rewrite DT_RUNPATH/DT_RPATH in-place to "$ORIGIN".
// Works for 64-bit LE ELF (Linux x86_64 / aarch64). The new value is always
// shorter than the Bazel path baked into the upstream prebuilt, so it fits
// in the existing .dynstr slot without resizing the file.
fn patch_runpath_native(so: &std::path::Path) {
    let mut bytes = std::fs::read(so)
        .unwrap_or_else(|e| panic!("read {}: {e}", so.display()));

    if bytes.len() < 64 || &bytes[0..4] != b"\x7fELF" {
        println!("cargo:warning=build.rs: {} is not an ELF file, skipping RUNPATH patch", so.display());
        return;
    }
    if bytes[4] != 2 || bytes[5] != 1 {
        println!("cargo:warning=build.rs: {} is not a 64-bit LE ELF, skipping RUNPATH patch", so.display());
        return;
    }

    let u16_at = |o: usize| u16::from_le_bytes(bytes[o..o+2].try_into().unwrap()) as usize;
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o+4].try_into().unwrap()) as usize;
    let u64_at = |o: usize| u64::from_le_bytes(bytes[o..o+8].try_into().unwrap()) as usize;

    let e_shoff     = u64_at(40);
    let e_shentsize = u16_at(58);
    let e_shnum     = u16_at(60);

    // Find .dynamic section and its sh_link (index of .dynstr)
    let mut dyn_file_off  = 0usize;
    let mut dyn_size      = 0usize;
    let mut dynstr_shidx  = 0usize;

    for i in 0..e_shnum {
        let sh = e_shoff + i * e_shentsize;
        if u32_at(sh + 4) == 6 /* SHT_DYNAMIC */ {
            dyn_file_off = u64_at(sh + 24);
            dyn_size     = u64_at(sh + 32);
            dynstr_shidx = u32_at(sh + 40);
            break;
        }
    }
    if dyn_file_off == 0 {
        println!("cargo:warning=build.rs: no .dynamic section in {}", so.display());
        return;
    }

    let dynstr_sh    = e_shoff + dynstr_shidx * e_shentsize;
    let dynstr_foff  = u64_at(dynstr_sh + 24);

    // Scan .dynamic for DT_RUNPATH (29) or DT_RPATH (15)
    let num_dyn = dyn_size / 16;
    for i in 0..num_dyn {
        let d = dyn_file_off + i * 16;
        let d_tag = i64::from_le_bytes(bytes[d..d+8].try_into().unwrap());
        if d_tag == 29 /* DT_RUNPATH */ || d_tag == 15 /* DT_RPATH */ {
            let str_off  = u64_at(d + 8);
            let file_off = dynstr_foff + str_off;

            // Find the existing null-terminated string
            let str_end = bytes[file_off..].iter().position(|&b| b == 0)
                .map(|p| file_off + p)
                .unwrap_or(bytes.len());
            let current = std::str::from_utf8(&bytes[file_off..str_end]).unwrap_or("");

            if current == "$ORIGIN" {
                println!("cargo:warning=build.rs: {} already has RUNPATH=$ORIGIN", so.display());
                return;
            }

            let old_len = str_end - file_off;
            let new_val = b"$ORIGIN";
            assert!(
                old_len >= new_val.len(),
                "existing RUNPATH ({old_len} bytes) is shorter than \"$ORIGIN\" — cannot patch in-place"
            );
            bytes[file_off..file_off + new_val.len()].copy_from_slice(new_val);
            for b in &mut bytes[file_off + new_val.len()..=str_end] {
                *b = 0;
            }

            std::fs::write(so, &bytes)
                .unwrap_or_else(|e| panic!("write patched {}: {e}", so.display()));
            println!("cargo:warning=build.rs: patched RUNPATH of {} to $ORIGIN (native ELF patcher)", so.display());
            return;
        }
    }

    println!("cargo:warning=build.rs: no DT_RUNPATH/DT_RPATH found in {}", so.display());
}
