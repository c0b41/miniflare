#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { Options } from "@miniflare/shared";
import { red } from "kleur/colors";
import type { MiniflareOptions } from "miniflare";
import { updateCheck } from "./updater";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function suppressWarnings() {
  // Suppress experimental warnings
  const originalEmitWarning = process.emitWarning;
  // @ts-expect-error this works, but overloads are funky in typescript
  process.emitWarning = (warning, ctorTypeOptions, ctorCode, ctor) => {
    if (ctorTypeOptions === "ExperimentalWarning") {
      const warningString = warning.toString();
      if (
        warningString.startsWith("VM Modules") ||
        warningString.startsWith("stream/web") ||
        warningString.startsWith("buffer.Blob")
      ) {
        return;
      }
    }
    originalEmitWarning(warning, ctorTypeOptions, ctorCode, ctor);
  };
}

async function main() {
  // Need to import these after warnings have been suppressed
  const [
    { ParseError, buildHelp, parseArgv },
    { Log, LogLevel },
    { Miniflare, PLUGINS },
  ] = await Promise.all([
    import("@miniflare/cli-parser"),
    import("@miniflare/shared"),
    import("miniflare"),
  ]);

  // Parse command line options
  let options: Options<typeof PLUGINS>;
  try {
    options = parseArgv(PLUGINS, process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    if (e.code === "ERR_VERSION") {
      console.error(e.message);
      return;
    }
    // MINIFLARE_EXEC_NAME will be set when calling from Wrangler
    const execName = process.env.MINIFLARE_EXEC_NAME ?? "miniflare";
    console.error(buildHelp(PLUGINS, execName));
    if (e.code === "ERR_HELP") return;
    console.error(`\n${red(e.message)}`);
    process.exitCode = 1;
    return;
  }

  // Autoload configuration files from default locations if none set
  options.wranglerConfigPath ??= true;
  options.packagePath ??= true;
  options.envPath ??= true;
  // Assume --watch if --build-watch-path or --live-reload set
  if (options.buildWatchPaths?.length || options.liveReload) {
    options.watch = true;
  }

  // TODO: warn if script path is src/... but dist/... exists, or build command set, or type webpack/rust

  const logLevel = options?.verbose
    ? LogLevel.VERBOSE
    : options?.debug
    ? LogLevel.DEBUG
    : LogLevel.INFO;
  const mfOptions: MiniflareOptions = options;
  mfOptions.log = new Log(logLevel);
  mfOptions.sourceMap = true;
  const mf = new Miniflare(mfOptions);
  try {
    // Start Miniflare development server
    await mf.startServer();
    await mf.startScheduler();
  } catch (e: any) {
    mf.log.error(e);
    process.exitCode = 1;
    return;
  }

  // TODO: check how this works with next tag
  const plugins = await mf.getPlugins();
  // Check for updates, ignoring errors (it's not that important)
  // Explicitly checking === false as undefined (default) should be true
  if (plugins.CorePlugin.updateCheck === false) return;
  try {
    // Get currently installed package metadata
    const pkgFile = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgFile, "utf8"));
    const mfDir = path.resolve(".mf");
    await fs.mkdir(mfDir, { recursive: true });
    const lastCheckFile = path.join(mfDir, "update-check");
    await updateCheck({ pkg, lastCheckFile, log: mf.log });
  } catch (e: any) {
    mf.log.debug("Unable to check for updates: " + e.stack);
  }
}

suppressWarnings();
void main();
