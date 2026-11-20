import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

if (process.env.STAGING_DB_CONFIRM !== 'YES_ISOLATED_STAGING' || process.env.RAILWAY_ENVIRONMENT_NAME !== 'staging') {
  throw new Error('Verification runner is staging-only');
}
const port = Number(process.env.PORT || 8080);
let status: 'running' | 'passed' | 'failed' = 'running';
let report = '';
const child = spawn('./node_modules/.bin/tsx', ['scripts/verify-staging-postgres.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
const onData = (data: Buffer) => { const str = data.toString(); report = (report + str).slice(-100000); process.stdout.write(str); };
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('error', e => { status = 'failed'; report += '\n' + e.message; });
child.on('close', code => { status = code === 0 && report.includes('"ok": true') ? 'passed' : 'failed'; console.log('STAGING_VERIFICATION_STATUS=' + status); });
createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') {
    res.statusCode = status === 'failed' ? 503 : 200;
    res.end(JSON.stringify({ ok: status === 'passed', status }));
  } else if (req.url === '/report') {
    res.statusCode = status === 'failed' ? 503 : status === 'running' ? 202 : 200;
    res.end(JSON.stringify({ status, report: report.slice(-30000) }));
  } else { res.statusCode = 404; res.end(JSON.stringify({ error: 'Not found' })); }
}).listen(port, '0.0.0.0', () => console.log('Staging verification runner listening on ' + port));