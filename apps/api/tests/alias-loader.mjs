import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();

export async function resolve(specifier, context, defaultResolve) {
  if (specifier === "next/server") {
    return defaultResolve("next/server.js", context, defaultResolve);
  }

  if (specifier.startsWith("@/")) {
    const resolvedPath = path.join(projectRoot, "src", specifier.slice(2));
    return {
      url: pathToFileURL(resolvedPath).href,
      shortCircuit: true,
    };
  }

  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    // TypeScript sources (the dashboard's api/* handlers, loaded under
    // --experimental-strip-types) import siblings WITHOUT an extension, as the
    // bundler allows. Only on a failed resolve, only for a relative,
    // extensionless specifier imported from a .ts file: retry as `.ts`. Every
    // other resolution is untouched.
    const fromTs = String(context?.parentURL || "").endsWith(".ts");
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (error?.code === "ERR_MODULE_NOT_FOUND" && fromTs && relative && !path.extname(specifier)) {
      return defaultResolve(`${specifier}.ts`, context, defaultResolve);
    }
    throw error;
  }
}
