#!/usr/bin/env node
// The installed `prag` command. Points at executable JavaScript (never a .ts
// file) and hands the TypeScript sources to tsx's ESM loader, which is what
// the tests and `npx tsx` path already use — the same code runs either way.
//
// A compiled/packaged artifact is task:toolchain-spike-native-addons.md's
// decision; this is only the "one documented route that works today".
import { register } from "tsx/esm/api";

register();
const { run } = await import(new URL("../src/main.ts", import.meta.url).href);
await run();
