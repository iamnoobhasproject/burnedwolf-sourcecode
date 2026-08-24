// BurnedWolf entry point.
// The application code lives in src/main/ split into focused modules
// (see src/main/index.js for the module map). This shim keeps package.json
// "main" and the build/obfuscation pipeline unchanged.
// The pre-refactor monolith is preserved at .backup/main.js.orig.
require('./src/main');
