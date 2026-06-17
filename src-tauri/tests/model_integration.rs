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

// ── Gemma 4 E2B LM (gemma-4-E2B-it.litertlm) ────────────────────────────────
//
// Large model (~1.5 GB). Marked #[ignore] so `cargo test` skips them by
// default. Run explicitly with: cargo test ... -- --ignored

mod gemma {
    use super::models_dir;
    use litertlm::{Backend, Engine, EngineSettings, SamplerParams};

    fn engine() -> Engine {
        let path = models_dir().join("gemma-4-E2B-it.litertlm");
        assert!(path.exists(), "gemma-4-E2B-it.litertlm not found at {}", path.display());
        let settings = EngineSettings::new(&path)
            .backend(Backend::Cpu)
            .max_num_tokens(512);
        Engine::new(settings).expect("Engine::new")
    }

    #[test]
    #[ignore = "loads ~1.5 GB model — run with: cargo test ... -- --include-ignored"]
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
    #[ignore = "loads ~1.5 GB model — run with: cargo test ... -- --include-ignored"]
    fn gpu_backend_diagnostic() {
        let path = models_dir().join("gemma-4-E2B-it.litertlm");
        let settings = EngineSettings::new(&path).backend(Backend::Gpu).max_num_tokens(512);
        match Engine::new(settings) {
            Err(e) => {
                // Expected on systems where libLiteRtVulkanAccelerator.so /
                // libLiteRtWebGpuAccelerator.so cannot be loaded.
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
        Engine::new(EngineSettings::new(&path).backend(Backend::Cpu).max_num_tokens(512))
            .expect("Engine::new (cpu)")
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
    #[ignore = "requires LITERT_WEBGPU=1 build — cargo test ... -- --include-ignored"]
    fn gpu_generates_nonempty_response() {
        let path = models_dir().join("gemma3-1b-it-int4.litertlm");
        assert!(path.exists(), "gemma3-1b-it-int4.litertlm not found at {}", path.display());
        let settings = EngineSettings::new(&path).backend(Backend::Gpu).max_num_tokens(512);
        let eng = match Engine::new(settings) {
            Ok(e) => e,
            Err(e) => {
                println!("GPU engine unavailable (skipping generation test): {e}");
                return;
            }
        };
        let mut conv = eng.create_conversation(SamplerParams::default())
            .expect("create_conversation");
        let mut response = String::new();
        conv.send_message_stream("Reply with one word: hello", |chunk| {
            response.push_str(chunk);
        }).expect("send_message_stream");
        assert!(!response.trim().is_empty(), "expected non-empty response, got empty");
        println!("Response: {response}");
    }
}
