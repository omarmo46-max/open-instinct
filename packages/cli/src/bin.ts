#!/usr/bin/env node
/** The `orion` binary. Everything testable lives in cli.ts. */
import { applyLegacyEnv } from "@orion-ai/core";
import { keepsRunning, runCli } from "./cli.js";

applyLegacyEnv(process.env);
const argv = process.argv.slice(2);
const code = await runCli(argv, process.env, {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  color: process.stdout.isTTY === true && !process.env.NO_COLOR,
});

// `orion dev` keeps the server alive; every other command ends here.
if (!keepsRunning(argv) || code !== 0) process.exit(code);
