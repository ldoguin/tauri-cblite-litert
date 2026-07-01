//! Integration tests that exercise the on-device ML models in `../models/`.
//!
//! Run the fast tests (BERT only):
//!   cargo test -p tauri-cblite-litert --test model_integration
//!
//! Run everything including the large Gemma model (~60 s on first load):
//!   cargo test -p tauri-cblite-litert --test model_integration -- --include-ignored

use std::path::PathBuf;

fn models_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../models")
}

// ── BERT text embedder (bert_embedder.tflite) ─────────────────────────────────
//
// MediaPipe BERT text embedder: 3 × [1,128] int32 inputs → 1 × [1,512] f32 output.
// Runs in ~10 ms on CPU and doesn't require a GPU.

mod bert {
    use super::models_dir;
    use litert::{
        Accelerators, CompiledModel, CompilationOptions, ElementType, Environment, Model,
        TensorBuffer, TensorShape,
    };

    fn load() -> (CompiledModel, Environment, Vec<TensorShape>, Vec<TensorShape>) {
        let path = models_dir().join("bert_embedder.tflite");
        assert!(path.exists(), "bert_embedder.tflite not found at {}", path.display());

        let model = Model::from_file(&path).expect("Model::from_file");

        // Collect shapes before moving model into CompiledModel.
        // Model is Arc-backed, so signature() clones it cheaply.
        let sig = model.signature(0).expect("signature(0)");
        let input_count = sig.input_count().expect("input_count");
        let output_count = sig.output_count().expect("output_count");
        let input_shapes: Vec<TensorShape> = (0..input_count)
            .map(|i| sig.input_shape(i).unwrap_or_else(|e| panic!("input_shape({i}): {e}")))
            .collect();
        let output_shapes: Vec<TensorShape> = (0..output_count)
            .map(|i| sig.output_shape(i).unwrap_or_else(|e| panic!("output_shape({i}): {e}")))
            .collect();

        let env = Environment::new().expect("Environment::new");
        let buf_env = Environment::new().expect("Environment::new (buf)");
        let opts = CompilationOptions::new()
            .expect("CompilationOptions::new")
            .with_accelerators(Accelerators::CPU)
            .expect("with_accelerators");
        let compiled = CompiledModel::new(env, model, &opts).expect("CompiledModel::new");

        (compiled, buf_env, input_shapes, output_shapes)
    }

    #[test]
    fn loads_successfully() {
        let _ = load();
    }

    #[test]
    fn has_three_int32_inputs_and_one_float32_output() {
        let (_, _, input_shapes, output_shapes) = load();

        assert_eq!(input_shapes.len(), 3, "BERT needs 3 inputs (ids/mask/type_ids)");
        assert_eq!(output_shapes.len(), 1, "BERT produces 1 output (embedding)");

        for (i, shape) in input_shapes.iter().enumerate() {
            assert_eq!(
                shape.element_type,
                ElementType::Int32,
                "input {i} should be Int32, got {:?}",
                shape.element_type,
            );
            assert_eq!(shape.dims.len(), 2, "input {i} should be rank-2 ([1, seq_len])");
        }

        assert_eq!(
            output_shapes[0].element_type,
            ElementType::Float32,
            "output should be Float32",
        );
    }

    #[test]
    fn inference_produces_512d_embedding() {
        let (compiled, buf_env, input_shapes, output_shapes) = load();

        // Build zero-filled i32 input buffers (all-PAD tokens — a valid input).
        let mut input_buffers: Vec<TensorBuffer> = input_shapes
            .iter()
            .map(|shape| {
                let mut buf = TensorBuffer::managed_host(&buf_env, shape)
                    .expect("TensorBuffer::managed_host (input)");
                match shape.element_type {
                    ElementType::Int32 => {
                        let mut g = buf.lock_for_write::<i32>().expect("lock_for_write::<i32>");
                        g.iter_mut().for_each(|v| *v = 0);
                    }
                    _ => {
                        let mut g = buf.lock_for_write::<f32>().expect("lock_for_write::<f32>");
                        g.iter_mut().for_each(|v| *v = 0.0);
                    }
                }
                buf
            })
            .collect();

        let mut output_buffers: Vec<TensorBuffer> = output_shapes
            .iter()
            .map(|shape| {
                TensorBuffer::managed_host(&buf_env, shape)
                    .expect("TensorBuffer::managed_host (output)")
            })
            .collect();

        compiled
            .run(&mut input_buffers, &mut output_buffers)
            .expect("CompiledModel::run");

        let embedding: Vec<f32> = output_buffers[0]
            .lock_for_read::<f32>()
            .expect("lock_for_read::<f32>")
            .to_vec();

        assert_eq!(embedding.len(), 512, "expected 512-dim embedding, got {}", embedding.len());

        // A real (non-degenerate) model should produce a non-trivial output even
        // for an all-padding input because of position encodings and bias terms.
        let all_zero = embedding.iter().all(|&v| v == 0.0);
        assert!(!all_zero, "embedding is unexpectedly all-zeros");
    }
}

// ── Qwen3-0.6B (Qwen3-0.6B.litertlm) ────────────────────────────────────────
//
// CPU-compatible model (~586 MB). Uses standard quantization (not hardware
// INT4), so XNNPACK handles inference without GPU delegates.
// Run with: cargo test --test model_integration qwen3 -- --include-ignored

mod qwen3 {
    use super::models_dir;
    use litertlm::{Backend, Engine, EngineSettings, SamplerParams};

    fn engine_cpu() -> Engine {
        let path = models_dir().join("Qwen3-0.6B.litertlm");
        assert!(path.exists(), "Qwen3-0.6B.litertlm not found at {}", path.display());
        let cache_dir = std::env::temp_dir().join("litert-lm-cache-qwen3");
        std::fs::create_dir_all(&cache_dir).ok();
        Engine::new(
            EngineSettings::new(&path)
                .backend(Backend::Cpu)
                .max_num_tokens(512)
                .cache_dir(&cache_dir),
        )
        .expect("Engine::new (cpu, qwen3)")
    }

    // TopK sampler (the SamplerParams::default()) requires libLiteRtTopKWebGpuSampler.so
    // and a functioning LiteRtRegisterGpuAccelerator — unavailable on many Linux desktops.
    // Use TopP (.top_p()) which is CPU-only and always works.
    fn sampler() -> SamplerParams {
        SamplerParams::default().top_p(0.95).temperature(0.7).seed(42)
    }

    #[test]
    #[ignore = "downloads model on first run — cargo test ... -- --include-ignored"]
    fn session_creates_successfully() {
        let eng = engine_cpu();
        eng.create_session(sampler())
            .expect("create_session (CPU, Qwen3-0.6B)");
    }

    #[test]
    #[ignore = "downloads model on first run — cargo test ... -- --include-ignored"]
    fn conversation_creates_successfully() {
        let eng = engine_cpu();
        eng.create_conversation(sampler())
            .expect("create_conversation (CPU, Qwen3-0.6B)");
    }

    #[test]
    #[ignore = "downloads model on first run — cargo test ... -- --include-ignored"]
    fn generates_nonempty_response_cpu() {
        let eng = engine_cpu();
        let mut conv = eng
            .create_conversation(sampler())
            .expect("create_conversation (CPU, Qwen3-0.6B)");
        let mut response = String::new();
        conv.send_message_stream("Reply with one word: hello", |chunk| {
            response.push_str(chunk);
        })
        .expect("send_message_stream (Qwen3-0.6B)");
        assert!(!response.trim().is_empty(), "expected non-empty response, got empty");
        println!("Qwen3 response: {response}");
    }
}

// ── Gemma 4 LM ───────────────────────────────────────────────────────────────
//
// Defaults to gemma-4-E2B-it.litertlm (~2.5 GB). Override with:
//   GEMMA_MODEL=gemma-4-12B-it.litertlm cargo test --test model_integration gemma -- --include-ignored
//
// GPU tests use Backend::Gpu + audio on CPU, matching the app.

mod gemma {
    use super::models_dir;
    use litertlm::{Backend, Engine, EngineSettings, SamplerParams};

    fn gemma_model() -> std::path::PathBuf {
        let name = std::env::var("GEMMA_MODEL")
            .unwrap_or_else(|_| "gemma-4-E2B-it.litertlm".to_string());
        let path = models_dir().join(&name);
        assert!(path.exists(), "{name} not found at {}", path.display());
        path
    }

    fn engine() -> Engine {
        let path = gemma_model();
        assert!(path.exists(), "{} not found", path.display());
        // Do NOT set max_num_tokens: v0.13.1 requires it to match the model's
        // compiled KV-cache dimension. Passing 512 causes DYNAMIC_UPDATE_SLICE
        // failures because the update tensor exceeds the operand slice size.
        // Force audio encoder to CPU: v0.13.1 defaults audio to GPU, which
        // crashes on RADV GFX1151 (reserved PTE bug) even for CPU-main engines.
        Engine::new(
            EngineSettings::new(&path)
                .backend(Backend::Cpu)
                .audio_backend(Backend::Cpu),
        )
        .expect("Engine::new")
    }

    fn engine_gpu() -> Engine {
        unsafe {
            // Prevent Dawn from requesting Wayland WSI extensions.
            std::env::set_var("WAYLAND_DISPLAY", "");
            // Block OpenCL: libhsa-runtime64.so (ROCm 7.1.0) crashes on GFX1151
            // during HSA init when LiteRT-LM dlopen's libamdocl64.so.
            std::env::set_var("OCL_ICD_VENDORS", "/dev/null");
        }

        let path = gemma_model();
        let cache_dir = models_dir();
        Engine::new(
            EngineSettings::new(&path)
                .backend(Backend::Gpu)
                .audio_backend(Backend::Cpu)
                .cache_dir(&cache_dir),
        )
        .expect("Engine::new (gpu)")
    }

    fn sampler() -> SamplerParams {
        SamplerParams::default().top_p(0.95).temperature(0.7).seed(42)
    }

    #[test]
    #[ignore = "requires GPU — run with: cargo test --test model_integration gemma::gpu_loads -- --include-ignored"]
    fn gpu_loads() {
        let _ = engine_gpu();
    }

    #[test]
    #[ignore = "requires GPU — run with: cargo test --test model_integration gemma::gpu_capital_of_france -- --include-ignored"]
    fn gpu_capital_of_france() {
        let eng = engine_gpu();
        let mut conv = eng.create_conversation(sampler())
            .expect("create_conversation (GPU, gemma-4-E2B)");
        let mut response = String::new();
        conv.send_message_stream("What is the capital of France? Reply in one word.", |chunk| {
            response.push_str(chunk);
            eprint!("{chunk}");
        })
        .expect("send_message_stream");
        eprintln!();
        println!("Response: {response}");
        assert!(
            response.to_lowercase().contains("paris"),
            "expected 'Paris' in response, got: {response:?}",
        );
    }

    #[test]
    #[ignore = "loads ~2.5 GB model — run with: cargo test --test model_integration gemma::cpu_capital_of_france -- --include-ignored"]
    fn cpu_capital_of_france() {
        let eng = engine();
        let mut conv = eng.create_conversation(sampler())
            .expect("create_conversation (CPU, gemma-4-E2B)");
        let mut response = String::new();
        conv.send_message_stream("What is the capital of France? Reply in one word.", |chunk| {
            response.push_str(chunk);
            eprint!("{chunk}");
        })
        .expect("send_message_stream");
        eprintln!();
        println!("Response: {response}");
        assert!(
            response.to_lowercase().contains("paris"),
            "expected 'Paris' in response, got: {response:?}",
        );
    }

    #[test]
    #[ignore = "loads ~2.5 GB model — run with: cargo test --test model_integration gemma::cpu_rag_context -- --include-ignored"]
    fn cpu_rag_context() {
        // Verifies that RAG context injected into the prompt text reaches the model.
        // Mirrors the llm.ts approach: system/RAG context is prepended to the user
        // message so the model sees it regardless of API-level system message support.
        let eng = engine();
        let mut conv = eng
            .create_conversation(sampler())
            .expect("create_conversation (CPU, gemma-4-E2B)");
        let rag_context = "--- Retrieved context ---\nmy cat name is pamplemousse\n--- End of context ---";
        let prompt = format!("{rag_context}\n\nUser: What is my cat's name?\nAssistant:");
        let mut response = String::new();
        conv.send_message_stream(&prompt, |chunk| {
            response.push_str(chunk);
            eprint!("{chunk}");
        })
        .expect("send_message_stream");
        eprintln!();
        println!("Response: {response}");
        assert!(
            response.to_lowercase().contains("pamplemousse"),
            "expected 'pamplemousse' in response — RAG context not reaching the model; got: {response:?}",
        );
    }

    #[test]
    #[ignore = "loads ~2.5 GB model — run with: cargo test ... -- --include-ignored"]
    fn engine_loads_with_cpu_backend() {
        let _ = engine();
    }

    // Tests whether the low-level session API works even when the higher-level
    // conversation API fails.  If this passes but conversation_creates_successfully
    // fails, the issue is specific to litert_lm_conversation_create().
    // Diagnostic: probe GPU path. On Linux without a working Vulkan/OpenGL
    // delegate the GPU engine itself fails to load.  If this ever passes,
    // check whether session creation also passes — that would unblock the app.
    #[test]
    #[ignore = "loads ~2.5 GB model — run with: cargo test ... -- --include-ignored"]
    fn gpu_backend_diagnostic() {
        // NOTE: GPU crashes with SIGSEGV on RADV GFX1151 (AMD Krackan Point) due
        // to reserved PTE bits in Dawn's large GPU buffer allocations (Mesa 25.2.8
        // bug). Use cpu_capital_of_france for a working test on this hardware.
        let path = gemma_model();
        unsafe { std::env::set_var("WAYLAND_DISPLAY", "") };
        let settings = EngineSettings::new(&path)
            .backend(Backend::Gpu)
            .audio_backend(Backend::Cpu);
        match Engine::new(settings) {
            Err(e) => {
                println!("GPU engine unavailable (expected on headless Linux): {e}");
            }
            Ok(eng) => {
                println!("GPU engine OK — testing session creation ...");
                eng.create_session(SamplerParams::default())
                    .expect("GPU session should work when GPU engine loaded");
            }
        }
    }

    // Diagnostic: the low-level session API and the high-level conversation API
    // both wrap litert_lm_engine_create_session / litert_lm_conversation_create.
    // On Linux without GPU delegates both return null even with a CPU engine,
    // because gemma-4-E2B-it.litertlm requires hardware-accelerated ops.
    #[test]
    #[ignore = "loads ~1.5 GB model — run with: cargo test ... -- --include-ignored"]
    fn session_creates_successfully() {
        let eng = engine();
        eng.create_session(SamplerParams::default())
            .expect("create_session — will fail without a working GPU delegate");
    }

    #[test]
    #[ignore = "loads ~1.5 GB model — run with: cargo test ... -- --include-ignored"]
    fn conversation_creates_successfully() {
        let eng = engine();
        eng.create_conversation(SamplerParams::default())
            .expect("create_conversation");
    }

    #[test]
    #[ignore = "loads ~1.5 GB model — run with: cargo test ... -- --include-ignored"]
    fn generates_nonempty_response() {
        let eng = engine();
        let mut conv = eng
            .create_conversation(SamplerParams::default())
            .expect("create_conversation");

        let mut response = String::new();
        conv.send_message_stream("Reply with one word: hello", |chunk| {
            response.push_str(chunk);
        })
        .expect("send_message_stream");

        assert!(
            !response.trim().is_empty(),
            "expected a non-empty response from Gemma, got empty string",
        );
    }

    #[test]
    #[ignore = "loads ~1.5 GB model — run with: cargo test ... -- --include-ignored"]
    fn cosine_similarity_same_prompt_is_high() {
        // Two conversations with identical prompts should produce nearly
        // identical responses (temperature=0 / greedy), confirming
        // deterministic sampling on CPU.
        let eng = engine();

        let params = SamplerParams::default().temperature(0.0);

        let mut r1 = String::new();
        eng.create_conversation(params.clone())
            .expect("conv 1")
            .send_message_stream("What is 2+2?", |c| r1.push_str(c))
            .expect("stream 1");

        let mut r2 = String::new();
        eng.create_conversation(params)
            .expect("conv 2")
            .send_message_stream("What is 2+2?", |c| r2.push_str(c))
            .expect("stream 2");

        assert_eq!(
            r1.trim(),
            r2.trim(),
            "same prompt with temperature=0 should give identical responses",
        );
    }
}

// ── Gemma 3 1B IT (gemma3-1b-it-int4.litertlm) ───────────────────────────────
//
// Smaller Gemma 3 model (~558 MB). Used to probe whether the WebGPU delegate
// crash is Gemma-4-specific or affects all models.
// Run with: LITERT_WEBGPU=1 cargo test --test model_integration -- --include-ignored

mod gemma3_1b {
    use super::models_dir;
    use litertlm::{Backend, Engine, EngineSettings, SamplerParams};

    fn engine_cpu() -> Engine {
        let path = models_dir().join("gemma3-1b-it-int4.litertlm");
        assert!(path.exists(), "gemma3-1b-it-int4.litertlm not found at {}", path.display());
        // Do NOT set max_num_tokens: v0.13.1 requires it to match the model's
        // compiled KV-cache dimension (like the E2B model). Passing 512 causes
        // the generation to silently return zero tokens.
        Engine::new(EngineSettings::new(&path).backend(Backend::Cpu))
            .expect("Engine::new (cpu)")
    }

    // TopK sampler (SamplerParams::default()) calls LiteRtRegisterGpuAccelerator,
    // which is absent from the prebuilt libs on most Linux desktop setups.
    // Use TopP which is CPU-only.
    fn sampler() -> SamplerParams {
        SamplerParams::default().top_p(0.95).temperature(0.7).seed(42)
    }

    #[test]
    #[ignore = "downloads model on first run — cargo test ... -- --include-ignored"]
    fn engine_loads_with_cpu_backend() {
        let _ = engine_cpu();
    }

    #[test]
    #[ignore = "requires LITERT_WEBGPU=1 build — cargo test ... -- --include-ignored"]
    fn gpu_backend_diagnostic() {
        let path = models_dir().join("gemma3-1b-it-int4.litertlm");
        assert!(path.exists(), "gemma3-1b-it-int4.litertlm not found at {}", path.display());
        let settings = EngineSettings::new(&path).backend(Backend::Gpu).max_num_tokens(512);
        match Engine::new(settings) {
            Err(e) => println!("GPU engine unavailable: {e}"),
            Ok(eng) => {
                println!("GPU engine OK — testing session creation ...");
                eng.create_session(SamplerParams::default())
                    .expect("GPU session should work when GPU engine loaded");
                println!("GPU session OK");
            }
        }
    }

    #[test]
    #[ignore = "downloads model on first run — cargo test ... -- --include-ignored"]
    fn session_creates_successfully() {
        let eng = engine_cpu();
        println!("Engine loaded, trying create_session...");
        eng.create_session(sampler())
            .expect("create_session (CPU) — should work even without GPU delegate");
        println!("Session OK");
    }

    #[test]
    #[ignore = "downloads model on first run — cargo test ... -- --include-ignored"]
    fn conversation_creates_successfully() {
        let eng = engine_cpu();
        eng.create_conversation(sampler())
            .expect("create_conversation (CPU)");
    }

    #[test]
    #[ignore = "downloads model on first run — cargo test ... -- --include-ignored"]
    fn multi_prefill_seq_conversation_creates_successfully() {
        let path = models_dir().join("Gemma3-1B-IT_multi-prefill-seq_q4_ekv4096.litertlm");
        assert!(path.exists(), "Gemma3-1B-IT_multi-prefill-seq_q4_ekv4096.litertlm not found");
        let eng = Engine::new(EngineSettings::new(&path).backend(Backend::Cpu).max_num_tokens(512))
            .expect("Engine::new (cpu, multi-prefill-seq)");
        println!("Engine loaded");
        eng.create_conversation(sampler())
            .expect("create_conversation (CPU, multi-prefill-seq)");
        println!("Conversation created");
    }
    // NOTE: gemma3-1b-it-int4.litertlm (and multi-prefill-seq variant) return
    // empty output via both session and conversation APIs under LiteRT-LM 0.13.1
    // on Linux x86_64. Generation tests are omitted until the model or SDK is
    // updated. Structural tests above confirm the engine/session/conversation
    // lifecycle still works correctly.
}
