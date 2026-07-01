/**
 * Ambient globals injected by WebdriverIO's test runner.
 * Mirrors the declarations in @wdio/globals/types.d.ts without requiring
 * that package to be a direct devDependency.
 */
declare function $(...args: Parameters<WebdriverIO.Browser["$"]>): ReturnType<WebdriverIO.Browser["$"]>;
declare function $$(...args: Parameters<WebdriverIO.Browser["$$"]>): ReturnType<WebdriverIO.Browser["$$"]>;
declare var browser: WebdriverIO.Browser;

// expect is provided by expect-webdriverio at runtime; typed loosely here
// to avoid depending on the package being a direct dep.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function expect(actual: unknown): any;
