// Use the compiler already installed by this project; do not download an implicit test runner.
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
require(path.resolve(process.argv[2]));
