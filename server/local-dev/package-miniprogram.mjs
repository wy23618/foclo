// Creates a separate, data-free WeChat project; never edits user storage or DBs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination) throw new Error('Specify a new output directory.');
const relativeDestination = path.relative(root, destination);
if (!relativeDestination || (!relativeDestination.startsWith('..' + path.sep) && !path.isAbsolute(relativeDestination)))
  throw new Error('Output must be outside the source project.');
if (fs.existsSync(destination) || fs.existsSync(destination + '.manifest.json'))
  throw new Error('Output already exists; choose a new directory.');

const folders = ['components', 'core', 'pages', 'storage', 'sync', 'themes', 'utils'];
const rootFiles = ['app.js', 'app.json', 'app.wxss', 'project.config.json', 'sitemap.json'];
const allowedExtensions = new Set(['.js', '.json', '.wxml', '.wxss', '.wxs', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.mp3', '.wav']);
const files = new Map();
function collect(relative) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error('Symlink is not allowed: ' + relative);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) collect(path.join(relative, name));
    return;
  }
  if (!stat.isFile() || !allowedExtensions.has(path.extname(relative)))
    throw new Error('Unexpected runtime file: ' + relative);
  const data = fs.readFileSync(absolute);
  if (/\.(?:js|json|wxml|wxss|wxs)$/.test(relative)) {
    const text = data.toString('utf8');
    // Never print a matching value; the error identifies only its file.
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@|\b(?:WX_APP_SECRET|WECHAT_APP_SECRET|JWT_SECRET|DATABASE_URL)\s*[:=]\s*["'][^"']{8,}/i.test(text))
      throw new Error('Possible embedded credential in: ' + relative);
  }
  files.set(relative.split(path.sep).join('/'), data);
}
for (const relative of [...rootFiles, ...folders]) collect(relative);

function resolveLocal(owner, ref, extensions = ['']) {
  const resolved = path.posix.normalize(ref.startsWith('/') ? ref.slice(1) : path.posix.join(path.posix.dirname(owner), ref));
  if (resolved.startsWith('../')) throw new Error('Reference leaves package: ' + owner);
  const match = extensions.map(ext => resolved + ext).find(candidate => files.has(candidate));
  if (!match) throw new Error('Missing runtime dependency: ' + owner + ' -> ' + ref);
  return match;
}
let references = 0;
for (const [name, contents] of files) {
  const text = contents.toString('utf8');
  if (name.endsWith('.js')) {
    for (const match of text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      resolveLocal(name, match[1], ['', '.js', '.json', '/index.js']); references++;
    }
  } else if (name.endsWith('.wxss')) {
    for (const match of text.matchAll(/@import\s*["']([^"']+)["']/g)) {
      resolveLocal(name, match[1]); references++;
    }
  } else if (name.endsWith('.wxml')) {
    for (const match of text.matchAll(/<(?:import|include|wxs)\b[^>]*\bsrc=["']([^"']+)["']/g)) {
      resolveLocal(name, match[1]); references++;
    }
  } else if (name.endsWith('.json')) {
    const json = JSON.parse(text);
    for (const ref of Object.values(json.usingComponents || {})) {
      if (ref.startsWith('plugin://')) continue;
      for (const ext of ['.js', '.json', '.wxml', '.wxss']) resolveLocal(name, ref, [ext]);
      references++;
    }
  }
}
const app = JSON.parse(files.get('app.json').toString('utf8'));
for (const page of app.pages) {
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) resolveLocal('app.json', '/' + page, [ext]);
}
resolveLocal('app.json', app.sitemapLocation);
const config = JSON.parse(files.get('project.config.json').toString('utf8'));
if (config.setting.uploadWithSourceMap !== false) throw new Error('Source-map upload must be disabled.');
config.projectname = 'Foclo';
files.set('project.config.json', Buffer.from(JSON.stringify(config, null, 2) + '\n'));

fs.mkdirSync(destination, { recursive: true });
const manifest = [];
for (const [relative, data] of files) {
  const target = path.join(destination, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data, { flag: 'wx' });
  const copied = fs.readFileSync(target);
  if (!copied.equals(data)) throw new Error('Copy verification failed: ' + relative);
  manifest.push({ path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
const evidence = {
  createdAt: new Date().toISOString(), source: root, output: destination,
  files: manifest.length, bytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
  pages: app.pages.length, validatedReferences: references,
  excluded: ['server', 'tests', 'docs', '.git', 'project.private.config.json', '.env', 'node_modules', 'backups', 'database contents'],
  scope: 'Runtime source only; no local storage or server DB was read or deleted. Development, trial and release builds use the configured Foclo Cloudflare API. Keep the Foclo upload project and Git source synchronized with the Foclo sync helper.',
  manifest,
};
fs.writeFileSync(destination + '.manifest.json', JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...evidence, manifest: undefined }, null, 2));
