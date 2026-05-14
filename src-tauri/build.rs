fn main() {
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        linux_fixups();
    }
}

// ── Linux runtime library fixups ─────────────────────────────────────────────
//
// Problem summary:
//
// A) Cargo does not propagate `rustc-link-arg` transitively, so -rpath flags
//    from litert-sys, litert-lm-sys, and couchbase-lite-rust never reach the
//    final binary linker. Re-emitted here.
//
// B) libGemmaModelConstraintProvider.so is a hard NEEDED dep of libLiteRtLmC.so
//    but absent from litert-sys 0.2.1's Linux prebuilt list.
//
// C) libLiteRtLmC.so's RUNPATH points to Bazel build-tree paths that don't
//    exist outside Google's environment.
//
// Solution for B+C: copy libLiteRtLmC.so into OUT_DIR, download
// libGemmaModelConstraintProvider.so alongside it, patch the copy's RUNPATH
// to $ORIGIN, and emit an rpath for OUT_DIR. The upstream cache file is never
// modified — this works on any machine regardless of build order.

const LITERT_TAG: &str = "v0.10.2";
const GEMMA_LIB: &str = "libGemmaModelConstraintProvider.so";
const LITERTLM_LIB: &str = "libLiteRtLmC.so";

fn linux_fixups() {
    let target    = std::env::var("TARGET").unwrap_or_default();
    let out_dir   = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let cache_root = cache_root();
    let cargo_home = cargo_home();

    let litert_cache   = cache_root.join("litert-sys")   .join(LITERT_TAG).join(&target);
    let litertlm_cache = cache_root.join("litert-lm-sys").join(LITERT_TAG).join(&target);

    // ── A. Re-emit rpaths that Cargo doesn't propagate ────────────────────

    // litert-sys cache (libLiteRt.so etc.) — still needed for those libs
    if litert_cache.is_dir() {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", litert_cache.display());
    }

    // couchbase-lite-rust (libcblite.so.3)
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

    // ── B+C. Prepare a patched libLiteRtLmC.so in OUT_DIR ────────────────

    let upstream_dir = match target.as_str() {
        "x86_64-unknown-linux-gnu"  => "linux_x86_64",
        "aarch64-unknown-linux-gnu" => "linux_arm64",
        other => {
            println!("cargo:warning=build.rs: no LiteRT extras for target {other}");
            return;
        }
    };

    // Download libGemmaModelConstraintProvider.so into OUT_DIR if missing.
    let gemma_dest = out_dir.join(GEMMA_LIB);
    if !gemma_dest.exists() {
        let url = format!(
            "https://media.githubusercontent.com/media/google-ai-edge/LiteRT-LM/{}/prebuilt/{}/{}",
            LITERT_TAG, upstream_dir, GEMMA_LIB,
        );
        download_file(&gemma_dest, &url);
    }

    // Copy libLiteRtLmC.so from the cache into OUT_DIR and patch its RUNPATH.
    // We copy rather than patch in-place so the user's cache is never modified
    // and the fix works regardless of which build script runs first.
    let litertlm_src  = litertlm_cache.join(LITERTLM_LIB);
    let litertlm_dest = out_dir.join(LITERTLM_LIB);

    if litertlm_src.exists() {
        // Only re-copy if the source changed (e.g. after a cache wipe).
        let needs_copy = !litertlm_dest.exists()
            || std::fs::metadata(&litertlm_src).map(|m| m.len()).unwrap_or(0)
            != std::fs::metadata(&litertlm_dest).map(|m| m.len()).unwrap_or(1);

        if needs_copy {
            std::fs::copy(&litertlm_src, &litertlm_dest)
                .unwrap_or_else(|e| panic!("copy {LITERTLM_LIB}: {e}"));
            patch_runpath(&litertlm_dest);
        }

        // OUT_DIR is on the rpath — the binary finds libLiteRtLmC.so here,
        // and $ORIGIN makes libLiteRtLmC.so find libGemmaModelConstraintProvider.so
        // in the same directory.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", out_dir.display());

        // Also tell the linker to prefer our patched copy over the cache copy.
        println!("cargo:rustc-link-search=native={}", out_dir.display());
    } else {
        // libLiteRtLmC.so not yet downloaded (litert-lm-sys runs after us).
        // Cargo will re-run this script once the file appears.
        println!("cargo:warning=build.rs: {LITERTLM_LIB} not in cache yet — \
                  will be patched on next build after litert-lm-sys downloads it.");
    }

    // Trigger re-run when the upstream cache file appears or changes.
    println!("cargo:rerun-if-changed={}", litertlm_src.display());
    println!("cargo:rerun-if-changed={}", litert_cache.display());
    println!("cargo:rerun-if-changed={}", litertlm_cache.display());
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
                      install it (apt install patchelf) for libGemmaModelConstraintProvider.so \
                      to be found at runtime.");
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
