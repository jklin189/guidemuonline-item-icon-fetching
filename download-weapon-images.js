#!/usr/bin/env node
/**
 * CommonJS wrapper for `download-weapon-images.mjs`.
 * Lets running: `node download-weapon-images.js ...`
 */

"use strict";

// Node CJS can still use dynamic import for ESM.
import("./download-weapon-images.mjs").catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

