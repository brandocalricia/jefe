// Test-only preload (NODE_OPTIONS=--import=<this file>): Date.now() becomes a step clock that moves forward 1 ms on every call and
// never reads the real clock again. Time measured with Date.now() then depends only on how much work was done, never on how loaded the
// machine is, so a test of the secrets scan's per-file time budget gives the same result on every run.
let t = Date.now();
Date.now = () => ++t;
