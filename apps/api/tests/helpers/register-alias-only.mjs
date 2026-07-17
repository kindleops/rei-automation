/**
 * Test/proof bootstrap only — registers the @/ path alias without installing
 * the critical-test network fetch guard. Never imported by production routes.
 *
 *   cd apps/api && node --import ./tests/helpers/register-alias-only.mjs scripts/proof/….mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(apiRoot);
register("./tests/alias-loader.mjs", pathToFileURL(apiRoot + "/"));
