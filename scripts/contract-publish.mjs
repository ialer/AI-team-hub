#!/usr/bin/env node
/**
 * Publish the team contract.
 *
 *   node scripts/contract-publish.mjs <new-version> [note]
 *
 * Refuses a version that is already published, prints the resulting sha256 so
 * the operator can eyeball the change. The hub picks the new version up on
 * restart; nothing here touches the agents.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'contracts', 'team-contract.md');
const version = process.argv[2];
const note = process.argv[3] || '';

if (!version) {
  console.error('usage: node scripts/contract-publish.mjs <new-version> [note]');
  console.error('   e.g. node scripts/contract-publish.mjs 2026.11.25-2 "worktop limit"');
  process.exit(1);
}

if (!fs.existsSync(FILE)) {
  console.error('no contract file at ' + FILE);
  process.exit(1);
}

const raw = fs.readFileSync(FILE, 'utf8');
const m = /^---\s*\nversion:\s*(.+?)\s*\n---\s*\n?/.exec(raw);
const current = m ? m[1].trim() : null;
const body = m ? raw.slice(m[0].length) : raw;

if (current === version) {
  console.error('version ' + version + ' is already published - bump the version');
  process.exit(1);
}
if (!/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9]+$/.test(version)) {
  console.error('version must look like 2026.11.25-2 (date-sequence)');
  process.exit(1);
}

const sha = crypto.createHash('sha256').update(body.trim()).digest('hex');
const out = '---\nversion: ' + version + '\n---\n' + body.trim() + '\n' + (note ? '\n> published ' + version + ' - ' + note + '\n' : '');
const tmp = FILE + '.' + process.pid + '.tmp';
fs.writeFileSync(tmp, out, 'utf8');
fs.renameSync(tmp, FILE);

console.log('published v' + version + ' (was ' + (current || 'none') + ')');
console.log('sha256 ' + sha.slice(0, 12) + '...');
console.log('restart the hub for the new version to reach agents.');

