import { Pool } from 'pg';
const url=process.env.DATABASE_URL||'';
if(process.env.STAGING_DB_CONFIRM!=='YES_ISOLATED_STAGING'||!url.includes('railway.internal')) throw Error('Staging-only private Railway database required');
const pool=new Pool({connectionString:url,ssl:false});
try {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cs_staging_rls_probe') THEN
      CREATE ROLE cs_staging_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
  END $$;`);
  await client.query('GRANT cs_staging_rls_probe TO postgres');
  await client.query('GRANT USAGE ON SCHEMA public TO cs_staging_rls_probe');
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cs_staging_rls_probe');
  const result=await client.query("SELECT rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='cs_staging_rls_probe'");
  await client.query('COMMIT');
  console.log(JSON.stringify({ok:true,role:result.rows[0]}));
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}finally{await pool.end()}