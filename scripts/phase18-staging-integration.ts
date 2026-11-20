import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
if (process.env.STAGING_DB_CONFIRM !== 'YES_ISOLATED_STAGING' || process.env.RAILWAY_ENVIRONMENT_NAME !== 'staging') throw new Error('staging-only runner');
const port = Number(process.env.PORT || 8080);
let status = 'running';
const results: Record<string,unknown>[] = [];
const base = 'http://celebrationsisterseventdecor-sta.railway.internal:8080';
async function check(name:string,path:string,expected:number[],headers:Record<string,string>={}) {
 try {
  const response = await fetch(base+path,{headers,signal:AbortSignal.timeout(10000)});
  const passed = expected.includes(response.status);
  results.push({name,passed,httpStatus:response.status});
  console.log('PHASE18_CHECK '+JSON.stringify(results.at(-1)));
  return passed;
 } catch(e) { results.push({name,passed:false,error:e instanceof Error?e.message:'request failed'}); console.log('PHASE18_CHECK '+JSON.stringify(results.at(-1)));return false; }
}
async function runDb() {
 return await new Promise<boolean>((resolve)=>{
  const child=spawn('./node_modules/.bin/tsx',['scripts/verify-staging-postgres.ts'],{env:process.env,stdio:['ignore','pipe','pipe']});
  let output='';
  child.stdout.on('data',(b:Buffer)=>{output+=b.toString();process.stdout.write(b)});
  child.stderr.on('data',(b:Buffer)=>process.stderr.write(b));
  child.on('error',()=>resolve(false));
  child.on('close',(code)=>resolve(code===0&&output.includes('"ok": true')));
 });
}
async function run(){
 const db=await runDb();
 results.push({name:'postgres-rls-booking',passed:db});
 await check('health','/health',[200]);
 await check('readiness','/ready',[200]);
 await check('auth-config','/api/auth/config',[200]);
 await check('anonymous-session','/api/auth/session',[200]);
 await check('invalid-bearer-session','/api/auth/session',[200],{Authorization:'Bearer invalid.staging.jwt'});
 await check('anonymous-bookings','/api/bookings',[401,403]);
 await check('forged-role-bookings','/api/bookings',[401,403],{'x-user-role':'admin','x-user-id':'fake-staging-user'});
 status=results.every(r=>r.passed===true)?'passed':'failed';
 console.log('PHASE18_SUMMARY '+JSON.stringify({status,results}));
}
createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
 if(req.url==='/health'){res.statusCode=status==='failed'?503:200;res.end(JSON.stringify({ok:status==='passed',status}));return}
 if(req.url==='/report'){res.statusCode=status==='failed'?503:status==='running'?202:200;res.end(JSON.stringify({status,results}));return}
 res.statusCode=404;res.end(JSON.stringify({error:'not found'}));
}).listen(port,'0.0.0.0',()=>console.log('Phase 18 staging runner listening'));
run().catch(e=>{status='failed';console.error(e)});
