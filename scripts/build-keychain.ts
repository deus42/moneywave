import { buildKeychainHelper } from "../src/server/secrets/build-keychain-helper";
import { resolveMoneyWavePaths } from "../src/server/runtime/paths";

await buildKeychainHelper(resolveMoneyWavePaths().keychainHelperPath);
process.stdout.write("KEYCHAIN_HELPER_BUILD_PASS\n");
