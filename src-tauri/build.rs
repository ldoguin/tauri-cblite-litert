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
        let cache_root = std::env::var("XDG_CACHE_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").expect("HOME not set");
                std::path::PathBuf::from(home).join(".cache")
            });

        let litert_dir = cache_root
            .join("litert-sys")
            .join("v0.10.2")
            .join(&target);
        let litertlm_dir = cache_root
            .join("litert-lm-sys")
            .join("v0.10.2")
            .join(&target);

        for dir in &[&litert_dir, &litertlm_dir] {
            if dir.is_dir() {
                println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
            }
        }

        // Re-run if the cache dirs appear (first build downloads them)
        println!("cargo:rerun-if-changed={}", litert_dir.display());
        println!("cargo:rerun-if-changed={}", litertlm_dir.display());
    }
}
