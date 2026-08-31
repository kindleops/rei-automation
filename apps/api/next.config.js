const path = require("path");

const { withSentryConfig } = require("@sentry/nextjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit .next/standalone: a self-contained Node server with only the traced
  // runtime dependencies. This is what the Cloudflare Container runs; it is
  // inert on any other host, so it is safe to enable now.
  output: "standalone",
  experimental: {
    // REQUIRED in this monorepo. apps/api/node_modules is a symlink to the repo
    // root, so without an explicit tracing root Next emits a standalone bundle
    // with NO node_modules. That still boots here -- Node walks up and finds the
    // parent node_modules -- but the container copies the standalone directory
    // alone, where the same bundle would fail with MODULE_NOT_FOUND.
    outputFileTracingRoot: path.join(__dirname, "../../"),
  },
  // CORS is handled by src/middleware.js which supports per-origin allowlisting,
  // proper OPTIONS preflight (204), and Authorization header.
  // The previous headers() block used * + credentials:true which is spec-invalid
  // and blocked by all browsers.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "luxer-international",
  project: "real-estate-sms-system",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
