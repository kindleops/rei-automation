import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(apiRoot);
register("./tests/alias-loader.mjs", pathToFileURL(apiRoot + "/"));
