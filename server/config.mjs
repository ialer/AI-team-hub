/**
 * Configuration loading.
 *
 * Precedence: config.json (if present) -> environment variables -> defaults.
 * No third-party parser: the config file is JSON, which keeps deployment to
 * "drop a file next to the code" and avoids a YAML dependency for users.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8899,
  dataDir: path.join(ROOT, 'data'),
  publicDir: path.join(ROOT, 'public'),
  defaultRoom: 'team',
  // How many trailing messages a woken agent receives as context.
  contextWindow: 10,
  // Seconds an agent may take before the hub marks the turn failed.
  wakeTimeout: 180,
  // Browser EventSource keep-alive.
  sseKeepAliveMs: 20000,
  // Agent long-poll ceiling (seconds). Agents re-issue after each reply.
  pollTimeout: 50,
  agents: [],
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function envOverrides() {
  const out = {};
  const e = process.env;
  const map = {
    HUB_HOST: ['host', String],
    HUB_PORT: ['port', Number],
    HUB_DATA_DIR: ['dataDir', String],
    HUB_DEFAULT_ROOM: ['defaultRoom', String],
    HUB_CONTEXT_WINDOW: ['contextWindow', Number],
    HUB_WAKE_TIMEOUT: ['wakeTimeout', Number],
    HUB_ADMIN_TOKEN: ['adminToken', String],
  };
  for (const [envKey, [key, cast]] of Object.entries(map)) {
    if (e[envKey] !== undefined && e[envKey] !== '') out[key] = cast(e[envKey]);
  }
  return out;
}

/**
 * Load configuration.
 * @param {string} [file] explicit config path (default: <root>/config.json)
 */
export function loadConfig(file) {
  const configPath = file || process.env.HUB_CONFIG || path.join(ROOT, 'config.json');
  const fromFile = readJson(configPath) || {};
  const config = { ...DEFAULTS, ...fromFile, ...envOverrides() };

  config.root = ROOT;
  config.configPath = fs.existsSync(configPath) ? configPath : null;

  // Normalise agents: accept an array or a { id: {...} } map.
  const raw = config.agents || [];
  const list = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([id, v]) => ({ id, ...v }));

  config.agents = list
    .filter((a) => a && a.id)
    .map((a) => ({
      id: String(a.id),
      name: a.name || a.id,
      role: a.role || '',
      color: a.color || '#7f8fa8',
      // "connector" = the agent dials in and long-polls (preferred, NAT-friendly).
      // "push"      = the hub calls out through an adapter (legacy / fire-and-forget).
      mode: a.mode === 'push' ? 'push' : 'connector',
      adapter: a.adapter || null,
      adapterConfig: a.config || {},
      sessionId: a.sessionId || null,
      enabled: a.enabled !== false,
    }));

  config.human = {
    id: 'human',
    name: (fromFile.human && fromFile.human.name) || '我',
    role: (fromFile.human && fromFile.human.role) || '操作者',
    color: (fromFile.human && fromFile.human.color) || '#e2e8f0',
  };

  return config;
}
