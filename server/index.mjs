#!/usr/bin/env node
/**
 * AI Team Hub — HTTP entry point.
 *
 * No framework, no build step: `node server/index.mjs` is the whole deployment.
 * The instances live in ./context.mjs; the routes live in ./routes/*. This file
 * only wires them together: static → routes → 404, then starts listening.
 */
import http from 'node:http';
import { sendJson, serveStatic } from './http.mjs';
import { createContext } from './context.mjs';
import { createHumanRoutes } from './routes/human.mjs';
import { createAgentRoutes } from './routes/agent.mjs';
import { createMediaRoutes } from './routes/media.mjs';
import { createAdminRoutes } from './routes/admin.mjs';
import { createDiscussionRoutes } from './routes/discussions.mjs';
import { createWorkspaceRoutes } from './routes/workspace.mjs';
import { attachRealtime } from './realtime.mjs';

const ctx = createContext();
const { config, log } = ctx;

// Order matters only where paths overlap; across these groups they do not.
const routes = [
  createHumanRoutes(ctx),
  createAgentRoutes(ctx),
  createMediaRoutes(ctx),
  createAdminRoutes(ctx),
  createDiscussionRoutes(ctx),
  createWorkspaceRoutes(ctx),
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(config.publicDir, req, res, p);

    // Liveness/readiness probe for external monitors: cheap, no auth, no writes.
    if (p === '/api/health' && req.method === 'GET') {
      const agents = ctx.registry.publicView();
      const online = Object.values(agents).filter((a) => a.online).length;
      return sendJson(res, 200, {
        ok: true,
        version: config.version || '0.5.0',
        agents: Object.keys(agents).length,
        online,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    for (const route of routes) {
      if (await route(req, res, url, p)) return;
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) log.line(`error ${req.method} ${p}: ${e.stack || e.message}`);
    return sendJson(res, status, { error: String(e.message || e) });
  }
});

server.listen(config.port, config.host, () => {
  log.line(`AI Team Hub listening on http://${config.host}:${config.port}`);
  log.line(`agents: ${config.agents.map((a) => `${a.id}(${a.mode})`).join(', ') || 'none configured'}`);
  if (!config.adminToken) log.line('WARNING: no adminToken set — agent tokens cannot be verified');
});

attachRealtime(server, ctx);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.line(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
