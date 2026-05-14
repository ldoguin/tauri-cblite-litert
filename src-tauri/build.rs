fn main() {
    tauri_build::build();

    // All Linux-specific fixups are gated on the target OS so cross-compilation
    // and macOS/Windows builds are unaffected.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        linux_fixups();
    }
}

// ── Linux runtime library fixups ─────────────────────────────────────────────
//
// Three problems need solving before the binary can run on Linux:
//
// 1. Cargo does not propagate `rustc-link-arg` transitively. The -rpath flags
//    emitted by litert-sys, litert-lm-sys, and couchbase-lite-rust only apply
//    to those crates' own link steps, not the final binary. Re-emitted here.
//
// 2. libGemmaModelConstraintProvider.so is a hard NEEDED dependency of
//    libLiteRtLmC.so but is absent from litert-sys 0.2.1's Linux prebuilt
//    list. Downloaded here from the LiteRT-LM LFS release.
//
// 3. libLiteRtLmC.so ships with a RUNPATH pointing to Bazel build-tree paths
//    that don't exist outside Google's environment. Patched to $ORIGIN using
//    patchelf so the dynamic linker finds libGemmaModelConstraintProvider.so
//    in the same directory.

const LITERT_TAG: &str = "v0.10.2";
const GEMMA_LIB: &str = "libGemmaModelConstraintProvider.so";

fn linux_fixups() {
    let target = std::env::var("TARGET").unwrap_or_default();

    let cache_root   = cache_root();
    let litert_dir   = cache_root.join("litert-sys")   .join(LITERT_TAG).join(&target);
    let litertlm_dir = cache_root.join("litert-lm-sys").join(LITERT_TAG).join(&target);
    let cargo_home   = cargo_home();

    // ── 1. Re-emit rpaths for the final binary ────────────────────────────
    for dir in &[&litert_dir, &litertlm_dir] {
        if dir.is_dir() {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
        }
    }

    // couchbase-lite-rust bundles libcblite.so.3 in its git checkout.
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

    // Rerun when cache dirs first appear (populated on first build).
    println!("cargo:rerun-if-changed={}", litert_dir.display());
    println!("cargo:rerun-if-changed={}", litertlm_dir.display());

    // ── 2. Download libGemmaModelConstraintProvider.so if missing ─────────
    let upstream_dir = match target.as_str() {
        "x86_64-unknown-linux-gnu"  => "linux_x86_64",
        "aarch64-unknown-linux-gnu" => "linux_arm64",
        other => {
            println!("cargo:warning=build.rs: no LiteRT extras for target {other}, skipping");
            return;
        }
    };

    std::fs::create_dir_all(&litert_dir).expect("create litert-sys cache dir");
    std::fs::create_dir_all(&litertlm_dir).expect("create litert-lm-sys cache dir");

    let gemma_so   = litert_dir.join(GEMMA_LIB);
    let gemma_link = litertlm_dir.join(GEMMA_LIB);

    if !gemma_so.exists() {
        download_file(&gemma_so, &format!(
            "https://media.githubusercontent.com/media/google-ai-edge/LiteRT-LM/{}/{}/{}",
            LITERT_TAG, upstream_dir, GEMMA_LIB,
        ));
    }

    // ── 3. Symlink into litert-lm-sys dir ─────────────────────────────────
    // libLiteRtLmC.so's RUNPATH will be patched to $ORIGIN; the symlink
    // makes libGemmaModelConstraintProvider.so reachable from there.
    if !gemma_link.exists() {
        std::os::unix::fs::symlink(&gemma_so, &gemma_link)
            .expect("symlink libGemmaModelConstraintProvider.so");
    }

    // ── 4. Patch libLiteRtLmC.so RUNPATH to $ORIGIN ───────────────────────
    // If libLiteRtLmC.so doesn't exist yet it will be downloaded by
    // litert-lm-sys on this same build invocation. The rerun-if-changed
    // directive causes cargo to re-run this script once the file appears,
    // at which point the patch will be applied.
    let litertlm_so = litertlm_dir.join("libLiteRtLmC.so");
    println!("cargo:rerun-if-changed={}", litertlm_so.display());
    if litertlm_so.exists() {
        patch_runpath(&litertlm_so);
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
    println!("cargo:warning=build.rs: downloading {} ...", dest.file_name().unwrap().to_string_lossy());
    let resp = ureq::get(url)
        .call()
        .unwrap_or_else(|e| panic!("Failed to download {url}: {e}"));
    let mut bytes: Vec<u8> = Vec::new();
    std::io::Read::read_to_end(&mut resp.into_reader(), &mut bytes)
        .expect("read download body");
    std::fs::write(dest, &bytes)
        .unwrap_or_else(|e| panic!("Failed to write {}: {e}", dest.display()));
    println!("cargo:warning=build.rs: saved {} ({} bytes)", dest.display(), bytes.len());
}

fn patch_runpath(so: &std::path::Path) {
    let check = std::process::Command::new("patchelf")
        .args(["--print-rpath", so.to_str().unwrap()])
        .output();

    match check {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            println!(
                "cargo:warning=build.rs: patchelf not found — install it \
                 (apt install patchelf) so libGemmaModelConstraintProvider.so \
                 is found at runtime."
            );
            return;
        }
        Err(e) => panic!("patchelf --print-rpath: {e}"),
        Ok(out) if out.stdout.starts_with(b"$ORIGIN") => return, // already patched
        Ok(_) => {}
    }

    let status = std::process::Command::new("patchelf")
        .args(["--set-rpath", "$ORIGIN", so.to_str().unwrap()])
        .status()
        .expect("patchelf --set-rpath");
    assert!(status.success(), "patchelf exited with {status}");
    println!("cargo:warning=build.rs: patched RUNPATH of {} to $ORIGIN", so.display());
}
