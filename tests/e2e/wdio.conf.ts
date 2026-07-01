/**
 * WebdriverIO + WebKitWebDriver end-to-end test configuration.
 *
 * Uses WebKitWebDriver directly (not tauri-driver) because tauri-driver 2.0.6
 * forwards an empty browserName ("") which WebKitWebDriver 2.40+ rejects.
 * WebKitWebDriver accepts the session when browserName is omitted entirely.
 *
 * WebKit automation is enabled via TAURI_WEBVIEW_AUTOMATION=true, which
 * tauri-runtime-wry reads to call WebContext::set_allows_automation(true).
 *
 * Two build modes:
 *
 *   Release (self-contained, recommended for CI):
 *     pnpm test:e2e:build             # runs `tauri build` then the suite
 *
 *   Debug (faster rebuilds, requires Vite dev server running):
 *     pnpm dev &                      # keep this running in a separate terminal
 *     pnpm test:e2e:dev               # runs `cargo build` then the suite
 *
 * On headless Linux / CI:
 *   xvfb-run pnpm test:e2e:build
 *
 * Prerequisites:
 *   sudo apt install webkit2gtk-driver   # provides WebKitWebDriver
 *
 * Environment variables:
 *   TAURI_BINARY        explicit path to the app binary (overrides auto-detection)
 *   WEBKIT_WEBDRIVER    path to WebKitWebDriver binary (default: /usr/bin/WebKitWebDriver)
 */
import { spawn, execSync, ChildProcess } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import * as os from "os";
import * as path from "path";
import type { Options } from "@wdio/types";

// ESM-compatible __dirname (not available in "type":"module" projects)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, "../..");
const BIN_NAME = "tauri-cblite-litert";
const releaseBin = path.join(ROOT, `src-tauri/target/release/${BIN_NAME}`);
const debugBin   = path.join(ROOT, `src-tauri/target/debug/${BIN_NAME}`);

// Prefer release (bundled frontend); fall back to debug (needs `pnpm dev` running)
const APP_BIN =
  process.env.TAURI_BINARY ??
  (existsSync(releaseBin) ? releaseBin : debugBin);

function findBin(name: string, envVar?: string): string | undefined {
  if (envVar && process.env[envVar]) return process.env[envVar];
  try {
    return execSync(`which ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch { /* not in PATH */ }
  const cargoBin = path.join(os.homedir(), `.cargo/bin/${name}`);
  if (existsSync(cargoBin)) return cargoBin;
  return undefined;
}

function findWebKitWebDriver(): string {
  const bin =
    findBin("WebKitWebDriver", "WEBKIT_WEBDRIVER") ??
    "/usr/bin/WebKitWebDriver";
  if (!existsSync(bin)) {
    throw new Error(
      `WebKitWebDriver not found at ${bin}.\n` +
      "Install with: sudo apt install webkit2gtk-driver"
    );
  }
  return bin;
}

let wkdProcess: ChildProcess;

export const config: Options.Testrunner = {
  runner: "local",

  // wdio v9 handles TypeScript natively via tsx — no autoCompileOpts needed

  specs: [path.join(__dirname, "specs/**/*.spec.ts")],
  exclude: [],

  maxInstances: 1,

  // WebKitWebDriver listens on port 4444
  hostname: "localhost",
  port: 4444,
  path: "/",

  capabilities: [
    {
      maxInstances: 1,
      // Do NOT set browserName — WebKitWebDriver 2.40+ rejects empty string "".
      // When omitted, it matches any browser and reports "wry" in the session.
      "webkitgtk:browserOptions": {
        binary: APP_BIN,
        args: [],
      },
    } as WebdriverIO.Capabilities,
  ],

  logLevel: "warn",
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  services: [],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },

  // onPrepare runs in the launcher before any WebDriver session is opened.
  onPrepare() {
    const bin = findWebKitWebDriver();
    console.log(`[e2e] WebKitWebDriver: ${bin}`);
    console.log(`[e2e] app binary:      ${APP_BIN}`);

    // TAURI_WEBVIEW_AUTOMATION=true → tauri-runtime-wry calls
    // WebContext::set_allows_automation(true) so the app registers with WebKitWebDriver.
    wkdProcess = spawn(bin, ["--port=4444"], {
      stdio: [null, process.stdout, process.stderr],
      env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: "true" },
    });

    // Poll until WebKitWebDriver is accepting connections (up to 10 s)
    return new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      function poll() {
        import("net").then(({ createConnection }) => {
          const sock = createConnection(4444, "localhost");
          sock.on("connect", () => { sock.destroy(); resolve(); });
          sock.on("error", () => {
            if (Date.now() > deadline) {
              reject(new Error("WebKitWebDriver did not listen on port 4444 within 10 s"));
            } else {
              setTimeout(poll, 200);
            }
          });
        });
      }
      setTimeout(poll, 300);
    });
  },

  onComplete() {
    wkdProcess?.kill();
  },
};
