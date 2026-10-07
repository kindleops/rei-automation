// Alias loader without the test network block (read-only audit scripts).
import { register } from "node:module";

register("./tests/alias-loader.mjs", new URL("../../../", import.meta.url));
