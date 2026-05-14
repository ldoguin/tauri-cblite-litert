fn main() {
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        linux_fixups();
    }
}

// ── Linux runtime library fixups ─────────────────────────────────────────────
//
// A) Cargo does not propagate `rustc-link-arg` transitively — re-emit rpaths.
//
// B) libGemmaModelConstraintProvider.so is absent from litert-sys 0.2.1's
//    Linux prebuilt list but is a hard NEEDED dep of libLiteRtLmC.so.
//    Downloaded once into the litert-sys cache dir (stable across rebuilds).
//
// C) libLiteRtLmC.so ships with a Bazel RUNPATH. A patched copy is kept in
//    the litert-lm-sys cache dir alongside a symlink to the Gemma library.
//    The cache dir is stable — OUT_DIR changes every rebuild and would
//    trigger a re-download loop.

const LITERT_TAG: &str = "v0.10.2";
const GEMMA_LIB: &str = "libGemmaModelConstraintProvider.so";
const LITERTLM_LIB: &str = "libLiteRtLmC.so";

fn linux_fixups() {
    let target     = std::env::var("TARGET").unwrap_or_default();
    let cache_root = cache_root();
    let cargo_home = cargo_home();

    let litert_dir   = cache_root.join("litert-sys")   .join(LITERT_TAG).join(&target);
    let litertlm_dir = cache_root.join("litert-lm-sys").join(LITERT_TAG).join(&target);

    // ── A. Re-emit rpaths ─────────────────────────────────────────────────
    for dir in &[&litert_dir, &litertlm_dir] {
        if dir.is_dir() {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
        }
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

    let upstream_dir = match target.as_str() {
        "x86_64-unknown-linux-gnu"  => "linux_x86_64",
        "aarch64-unknown-linux-gnu" => "linux_arm64",
        other => {
            println!("cargo:warning=build.rs: no LiteRT extras for target {other}");
            // Still rerun when cache dirs appear
            println!("cargo:rerun-if-changed={}", litert_dir.display());
            println!("cargo:rerun-if-changed={}", litertlm_dir.display());
            return;
        }
    };

    std::fs::create_dir_all(&litert_dir).expect("create litert-sys cache dir");
    std::fs::create_dir_all(&litertlm_dir).expect("create litert-lm-sys cache dir");

    // ── B. Download libGemmaModelConstraintProvider.so once ───────────────
    // Stored in the litert-sys cache dir — stable across rebuilds so we
    // never re-download unless the file is missing.
    let gemma_in_litert = litert_dir.join(GEMMA_LIB);
    if !gemma_in_litert.exists() {
        let url = format!(
            "https://media.githubusercontent.com/media/google-ai-edge/LiteRT-LM/{}/prebuilt/{}/{}",
            LITERT_TAG, upstream_dir, GEMMA_LIB,
        );
        download_file(&gemma_in_litert, &url);
    }

    // ── C. Keep a patched libLiteRtLmC.so in the litert-lm-sys cache dir ──
    // Symlink the Gemma library next to it so $ORIGIN resolves correctly.
    let litertlm_src  = litertlm_dir.join(LITERTLM_LIB);
    let gemma_symlink = litertlm_dir.join(GEMMA_LIB);

    // Rerun when the upstream file appears (litert-lm-sys downloads it on
    // the same build invocation; Cargo will re-run us on the next build).
    println!("cargo:rerun-if-changed={}", litertlm_src.display());
    println!("cargo:rerun-if-changed={}", litert_dir.display());
    println!("cargo:rerun-if-changed={}", litertlm_dir.display());

    if litertlm_src.exists() {
        // Patch RUNPATH in-place (idempotent — skipped if already $ORIGIN).
        patch_runpath(&litertlm_src);

        // Symlink so $ORIGIN finds the Gemma library in the same dir.
        if !gemma_symlink.exists() {
            std::os::unix::fs::symlink(&gemma_in_litert, &gemma_symlink)
                .expect("symlink libGemmaModelConstraintProvider.so");
        }
    } else {
        println!("cargo:warning=build.rs: {LITERTLM_LIB} not in cache yet — \
                  will be patched on next build after litert-lm-sys downloads it.");
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
        Ok(out) if out.stdout.starts_with(b"$ORIGIN") => return, // already patched
        Ok(_) => {}
    }
    let st = std::process::Command::new("patchelf")
        .args(["--set-rpath", "$ORIGIN", so.to_str().unwrap()])
        .status().expect("patchelf --set-rpath");
    assert!(st.success(), "patchelf exited {st}");
    println!("cargo:warning=build.rs: patched RUNPATH of {} to $ORIGIN", so.display());
}
