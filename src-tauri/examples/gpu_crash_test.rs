fn main() {
    let path = format!("{}/.local/share/com.ldoguin.rag-chatbot/models/gemma-4-E2B-it.litertlm",
        std::env::var("HOME").unwrap());
    eprintln!("Trying GPU backend on: {path}");
    let _ = litertlm::Engine::new(
        litertlm::EngineSettings::new(&path)
            .backend(litertlm::Backend::Gpu)
            .max_num_tokens(64),
    );
    eprintln!("Done (no crash)");
}
