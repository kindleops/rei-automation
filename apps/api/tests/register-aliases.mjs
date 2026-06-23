import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tests/alias-loader.mjs", pathToFileURL("./"));
await import("./helpers/critical-test-environment.mjs");
