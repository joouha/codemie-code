#!/usr/bin/env node

/**
 * CodeMie Proxy Entry Point
 *
 * Runs the CodeMie local gateway proxy in the foreground, prints the address
 * it is listening on, and stays up until interrupted. Does NOT launch any agent.
 *
 * Usage:
 *   codemie-proxy [--port <port>] [--profile <name>] [--target-url <url>]
 *
 * On startup it validates the CodeMie SSO session and, when it is missing or
 * expired, offers to re-authenticate — opening the browser sign-in page, the
 * same flow the other codemie-* agent entry points use.
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeMieProxy } from '../dist/providers/plugins/sso/index.js';
import '../dist/providers/plugins/sso/proxy/plugins/index.js'; // Auto-register core plugins
import { ConfigLoader } from '../dist/utils/config.js';
import { ProviderRegistry } from '../dist/providers/core/registry.js';
import { handleAuthValidationFailure } from '../dist/providers/core/auth-validation.js';
import { installSystemProxyDispatcher } from '../dist/utils/system-proxy-dispatcher.js';

const DEFAULT_PORT = 4001;

/** Report the CLI version to the upstream gateway (it rejects unknown versions). */
function readCliVersion() {
  try {
    const pkgPath = join(fileURLToPath(import.meta.url), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const { values: opts } = parseArgs({
  options: {
    'port': { type: 'string' },
    'profile': { type: 'string' },
    'target-url': { type: 'string' },
    'help': { type: 'boolean', short: 'h' },
  },
  strict: false,
});

if (opts.help) {
  process.stdout.write(
    'Usage: codemie-proxy [--port <port>] [--profile <name>] [--target-url <url>]\n',
  );
  process.exit(0);
}

let port;
if (opts.port !== undefined) {
  port = Number.parseInt(opts.port, 10);
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`[codemie-proxy] Invalid --port value: ${opts.port}\n`);
    process.exit(1);
  }
} else {
  port = DEFAULT_PORT;
}

// Resolve the target API URL / profile from config, letting CLI args win.
const config = await ConfigLoader.load(
  process.cwd(),
  opts.profile ? { name: opts.profile } : undefined,
);
const targetUrl = opts['target-url'] ?? config.baseUrl;
const profile = opts.profile ?? config.name ?? 'default';
const provider = config.provider ?? 'ai-run-sso';

if (!targetUrl) {
  process.stderr.write(
    '[codemie-proxy] No API URL configured for this profile.\n' +
      'Run: codemie setup   (or pass --target-url <url>)\n',
  );
  process.exit(1);
}

// Validate the SSO session and, when it is missing or expired, open the browser
// sign-in page — the same interactive re-auth flow the codemie-* agent entry
// points use. Importing the SSO plugin above registers its provider and setup
// steps with the registry.
const authConfig = { ...config, provider, baseUrl: targetUrl };
const setupSteps = ProviderRegistry.getSetupSteps(provider);
if (setupSteps?.validateAuth) {
  const validation = await setupSteps.validateAuth(authConfig);
  if (!validation.valid) {
    const reauthenticated = await handleAuthValidationFailure(validation, setupSteps, authConfig);
    if (!reauthenticated) {
      process.stderr.write('[codemie-proxy] Authentication required — cannot start the proxy.\n');
      process.exit(1);
    }
  }
}

// Resolve proxy/PAC routing lazily per request (same as the daemon).
installSystemProxyDispatcher();

const proxy = new CodeMieProxy({
  targetApiUrl: targetUrl,
  port,
  // Bind to 127.0.0.1 explicitly; the default 'localhost' bind on macOS can
  // land on IPv6 ::1 only, which some clients reject.
  host: '127.0.0.1',
  provider,
  profile,
  project: config.codeMieProject,
  version: readCliVersion(),
  gatewayKey: 'codemie-proxy',
  authMethod: 'sso',
  clientType: 'codemie-daemon',
  telemetryMode: 'none',
  syncApiUrl: config.ssoConfig?.apiUrl,
  syncCodeMieUrl: config.codeMieUrl,
});

const shutdown = async () => {
  try {
    await proxy.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  const { url } = await proxy.start();
  process.stdout.write(`✓ CodeMie proxy listening at ${url}  (profile: ${profile})\n`);
} catch (error) {
  process.stderr.write(`[codemie-proxy] Failed to start: ${error.message}\n`);
  process.exit(1);
}
