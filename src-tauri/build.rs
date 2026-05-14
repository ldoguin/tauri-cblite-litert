fn main() {
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        linux_fixups();
    }
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

const LITERT_TAG: &str = "v0.10.2";
const GEMMA_LIB: &str = "libGemmaModelConstraintProvider.so";
const LITERTLM_LIB: &str = "libLiteRtLmC.so";

fn linux_fixups() {
    let target     = std::env::var("TARGET").unwrap_or_default();
    let out_dir    = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let cache_root = cache_root();
    let cargo_home = cargo_home();

    let litert_cache   = cache_root.join("litert-sys")   .join(LITERT_TAG).join(&target);
    let litertlm_cache = cache_root.join("litert-lm-sys").join(LITERT_TAG).join(&target);

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
            println!("cargo:warning=build.rs: patchelf not found — \
                      install it (apt install patchelf) for \
                      libGemmaModelConstraintProvider.so to be found at runtime.");
            return;
        }
        Err(e) => panic!("patchelf --print-rpath: {e}"),
        Ok(out) if out.stdout.starts_with(b"$ORIGIN") => return,
        Ok(_) => {}
    }
    let st = std::process::Command::new("patchelf")
        .args(["--set-rpath", "$ORIGIN", so.to_str().unwrap()])
        .status().expect("patchelf --set-rpath");
    assert!(st.success(), "patchelf exited {st}");
    println!("cargo:warning=build.rs: patched RUNPATH of {} to $ORIGIN", so.display());
}
