// Cross-check the management UI against the Fastify routes it calls.
//
// The UI side used to be a hand-maintained list of paths, which drifted every
// time a route changed and reported live routes as dead. Now both sides are
// read from source: routes from server.ts, calls from app.js.
import { readFileSync } from 'node:fs';

const server = readFileSync('apps/api/src/server.ts', 'utf8');
const appJs = readFileSync('apps/api/public/app.js', 'utf8');

const VERBS = '(get|post|put|delete)';

/** Routes: inline `app.get('/x', ...)` plus the split form where the path wraps. */
function serverRoutes() {
  const routes = new Set();
  let pendingVerb = null;
  for (const line of server.split('\n')) {
    const inline = line.match(new RegExp(`app\\.${VERBS}\\s*(<[\\s\\S]*?>)?\\s*\\(\\s*'([^']+)'`));
    if (inline) {
      routes.add(inline[1].toUpperCase() + ' ' + inline[3]);
      pendingVerb = null;
      continue;
    }
    const open = line.match(new RegExp(`app\\.${VERBS}\\s*(<[\\s\\S]*?>)?\\s*\\(\\s*$`));
    if (open) {
      pendingVerb = open[1];
      continue;
    }
    const p = line.match(/^\s*'((?:\/api|\/healthz)[^']*)'/);
    if (p && pendingVerb) {
      routes.add(pendingVerb.toUpperCase() + ' ' + p[1]);
      pendingVerb = null;
    }
  }
  return routes;
}

/** Split an argument list at top-level commas, respecting nesting and strings. */
function splitArgs(src, start) {
  const args = [];
  let depth = 0;
  let inString = null;
  let argStart = start;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { args.push(src.slice(argStart, i)); return args; }
      depth--;
    } else if (ch === ',' && depth === 0) {
      args.push(src.slice(argStart, i));
      argStart = i + 1;
    }
  }
  return args;
}

/**
 * Expand the branches of a ternary so a call like
 *   `'/x/' + enc(id) + (off ? '/enable' : '')`
 * yields both `/x/:p/enable` (POST) and `/x/:p` (DELETE).
 * Returns every reachable reading, capped so a pathological expression cannot
 * blow up the search.
 */
function expandTernaries(expr, limit = 8) {
  const results = [];
  const queue = [expr];
  while (queue.length && results.length < limit) {
    const current = queue.shift();
    const m = current.match(/\(?\s*([^()?:]*)\?\s*((?:'[^']*'|[^()?:])*?)\s*:\s*((?:'[^']*'|[^()?:])*?)\s*\)?$/);
    const simple = current.match(/([^()?:]*)\?\s*('[^']*'|[^()?:]*?)\s*:\s*('[^']*'|[^()?:]*)/);
    const hit = m ?? simple;
    if (!hit) {
      if (!results.includes(current)) results.push(current);
      continue;
    }
    const at = current.indexOf(hit[0]);
    const before = current.slice(0, at);
    const after = current.slice(at + hit[0].length);
    const cleaned = (s) => s.replace(/^\(?\s*/, '').replace(/\s*\)?$/, '');
    queue.push(before + cleaned(hit[2]) + after, before + cleaned(hit[3]) + after);
  }
  return results;
}

/** Every `api(...)` call in the UI, as [method, path]. */
function uiCalls() {
  const calls = [];
  const re = /\bapi\(/g;
  let m;
  while ((m = re.exec(appJs))) {
    // Skip the `async function api(path, method, body)` declaration itself.
    if (/function\s+$/.test(appJs.slice(Math.max(0, m.index - 20), m.index))) continue;

    const args = splitArgs(appJs, m.index + m[0].length);
    if (!args[0]) continue;

    // A path is built from string literals and `enc(id)` calls. Substituting a
    // quoted sentinel first keeps the placeholders in the right order; pulling
    // only the quoted literals afterwards would silently drop every `enc()`.
    const pathBranches = [];
    for (const rawArg of expandTernaries(args[0])) {
      const raw = rawArg.replace(/\benc\([^)]*\)/g, "'__ID__'");
      const path = raw
        .match(/'[^']*'|"[^"]*"|`[^`]*`/g)
        ?.map((s) => s.slice(1, -1).replaceAll('__ID__', ':p'))
        .join('');
      if (path?.startsWith('/api') && !pathBranches.includes(path)) pathBranches.push(path);
    }
    if (!pathBranches.length) continue;

    const verbSource = args[1]?.trim() ?? '';
    const verbBranches = expandTernaries(verbSource)
      .map((v) => v.trim().match(/^(['"])([A-Z]+)\1$/)?.[2])
      .filter((v) => v);
    // Path and method branches come from the same condition, so pair them by
    // index instead of forming a cross product — `x ? '/enable' : ''` with
    // `x ? 'POST' : 'DELETE'` must not yield POST-with-no-enable.
    const paired = verbBranches.length > 1 && pathBranches.length === verbBranches.length;
    const verbs = verbBranches.length ? verbBranches : ['GET'];
    for (let i = 0; i < pathBranches.length; i++) {
      const path = pathBranches[i];
      if (paired) calls.push(verbs[i] + ' ' + path);
      else for (const verb of verbs) calls.push(verb + ' ' + path);
    }
  }
  return [...new Set(calls)];
}

/** `:param` matches exactly one non-empty segment. */
function segments(path) {
  return path.split('/');
}
function matches(routePath, callPath) {
  const r = segments(routePath);
  const c = segments(callPath.split('?')[0]);
  if (r.length !== c.length) return false;
  return r.every((seg, i) => seg.startsWith(':') ? c[i].length > 0 : seg === c[i]);
}

const routes = [...serverRoutes()];
const calls = uiCalls();

let bad = 0;
for (const call of calls) {
  const at = call.indexOf(' ');
  const method = call.slice(0, at);
  const path = call.slice(at + 1);
  const ok = routes.some((route) => {
    const rat = route.indexOf(' ');
    return route.slice(0, rat) === method && matches(route.slice(rat + 1), path);
  });
  if (!ok) {
    console.log('UNMATCHED UI CALL:', method, path);
    bad++;
  }
}

// A route with no UI caller is either dead or a documented API for scripts.
const API_ONLY = new Set([
  'GET /healthz',
  'GET /',
  'GET /app.js',
  'GET /app.css',
]);
for (const route of routes) {
  if (API_ONLY.has(route)) continue;
  const at = route.indexOf(' ');
  const method = route.slice(0, at);
  const path = route.slice(at + 1);
  const used = calls.some((call) => {
    const cat = call.indexOf(' ');
    return call.slice(0, cat) === method && matches(path, call.slice(cat + 1));
  });
  if (!used) console.log('backend route unused by UI:', route);
}

console.log(`routes: ${routes.length}, ui calls: ${calls.length}`);
console.log(
  bad === 0
    ? `OK: all ${calls.length} UI calls have a backend route`
    : `${bad} UI call(s) have no backend route`,
);
process.exit(bad === 0 ? 0 : 1);
