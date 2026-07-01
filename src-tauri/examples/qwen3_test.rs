fn main() {
    let model_path = std::env::args().nth(1)
        .unwrap_or_else(|| format!("{}/.local/share/com.ldoguin.rag-chatbot/models/Qwen3-0.6B.litertlm",
            std::env::var("HOME").unwrap()));
    let cache_dir = std::env::temp_dir().join("litert-lm-cache");
    std::fs::create_dir_all(&cache_dir).ok();
    let engine = litertlm::Engine::new(
        litertlm::EngineSettings::new(&model_path)
            .backend(litertlm::Backend::Cpu)
            .max_num_tokens(512)
            .cache_dir(&cache_dir),
    ).expect("Engine::new");
    eprintln!("Engine loaded");
    let sampler = litertlm::SamplerParams::default().top_p(0.95).temperature(0.7).seed(42);
    let mut session = engine.create_session(sampler).expect("create_session");
    eprintln!("Session created OK!");
    let response = session.generate("Reply with one word: hello").expect("generate");
    println!("{response}");
}
