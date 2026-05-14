fn main() {
    tauri_build::build();

    // On Linux, litert-sys and litert-lm-sys emit `rustc-link-arg=-Wl,-rpath`
    // only from their own build scripts. Cargo propagates link-search and
    // link-lib transitively but NOT link-arg, so the rpath never reaches the
    // final binary linker invocation.
    //
    // We reconstruct the same cache paths the sys crates use
    // ($XDG_CACHE_HOME or $HOME/.cache) and re-emit the rpath from here,
    // where it WILL be applied to the binary. No hardcoded usernames.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        let target = std::env::var("TARGET").unwrap_or_default();

        // ── LiteRT / LiteRT-LM prebuilt .so files ────────────────────────
        // litert-sys and litert-lm-sys cache prebuilt libraries under
        // $XDG_CACHE_HOME (or $HOME/.cache). Their build scripts emit
        // rustc-link-arg=-Wl,-rpath for their own crate but Cargo does not
        // propagate link-arg transitively, so we re-emit it here.
        let cache_root = std::env::var("XDG_CACHE_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").expect("HOME not set");
                std::path::PathBuf::from(home).join(".cache")
            });

        let litert_dir = cache_root.join("litert-sys").join("v0.10.2").join(&target);
        let litertlm_dir = cache_root.join("litert-lm-sys").join("v0.10.2").join(&target);

        for dir in &[&litert_dir, &litertlm_dir] {
            if dir.is_dir() {
                println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
            }
        }

        // Re-run when the cache dirs first appear (populated on first build)
        println!("cargo:rerun-if-changed={}", litert_dir.display());
        println!("cargo:rerun-if-changed={}", litertlm_dir.display());

        // ── CouchbaseLite prebuilt .so files ─────────────────────────────
        // couchbase-lite-rust bundles libcblite.so.3 in its git checkout
        // under $CARGO_HOME/git/checkouts. Same propagation problem applies.
        let cargo_home = std::env::var("CARGO_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").expect("HOME not set");
                std::path::PathBuf::from(home).join(".cargo")
            });

        let cblite_git = cargo_home.join("git").join("checkouts");
        if cblite_git.is_dir() {
            // Walk one level of checkouts to find any couchbase-lite-rust dir
            if let Ok(entries) = std::fs::read_dir(&cblite_git) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("couchbase-lite-rust") {
                        // Each checkout may have multiple commit subdirs; add all
                        if let Ok(commits) = std::fs::read_dir(entry.path()) {
                            for commit in commits.flatten() {
                                let lib_dir = commit.path()
                                    .join("libcblite_community")
                                    .join("lib")
                                    .join(&target);
                                if lib_dir.is_dir() {
                                    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
