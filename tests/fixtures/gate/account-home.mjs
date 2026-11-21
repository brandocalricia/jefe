// Test preload (not shipped behaviour): `node --import <this file> bin/jefe-gate ...` makes the account's home folder, which the
// registry falls back to (hooks/root-node.mjs accountHome: os.userInfo(), never the HOME variable), the folder named by
// JEFE_TEST_ACCOUNT_HOME, so a test of that fallback never writes into the real ~/.claude/jefe. Only a test can load it:
// the plugin's scripts are never started with --import.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const home = process.env.JEFE_TEST_ACCOUNT_HOME;
if (!home) throw new Error('account-home.mjs: JEFE_TEST_ACCOUNT_HOME is not set');
const os = createRequire(import.meta.url)('node:os');
const real = os.userInfo;
os.userInfo = (...a) => ({ ...real(...a), homedir: home });
os.homedir = () => home;
syncBuiltinESMExports(); // the named exports (`import { userInfo } from 'node:os'`) follow the change
