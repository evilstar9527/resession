#!/usr/bin/env node
'use strict';
// Tiny CommonJS launcher. Its only job is to run on ANY Node (including old
// versions that can't even parse the modern ESM entry) and give a clear message
// when the runtime is too old, instead of crashing with a SyntaxError.

var major = parseInt(process.versions.node.split('.')[0], 10);

if (major < 18) {
  process.stderr.write(
    'resession requires Node.js >= 18 (you have ' + process.versions.node + ').\n' +
      'Upgrade Node, e.g. with nvm:\n' +
      '  nvm install --lts && nvm use --lts\n' +
      'or see https://nodejs.org/en/download\n'
  );
  process.exit(1);
}

// Node >=18: hand off to the real ESM entry. We build the dynamic import()
// through `new Function` so this file contains no `import()` token of its own —
// otherwise old Node would SyntaxError while *parsing* (before the check runs).
var entry = require('url').pathToFileURL(require('path').join(__dirname, 'cli.js')).href;
var dynamicImport = new Function('u', 'return import(u)');
dynamicImport(entry).catch(function (err) {
  process.stderr.write('resession: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
