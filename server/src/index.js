require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 8),
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000
});
const jwtSecret = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production' && (!jwtSecret || jwtSecret.length < 32)) {
  throw new Error('Set JWT_SECRET to a random value of at least 32 characters in production.');
}
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    const normalized = String(origin || '').replace(/\/$/, '');
    callback(null, !origin || allowedOrigins.includes(normalized));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '15mb' }));

const defaults = {
  monthly_goal: 1500,
  avg_consumption: 0,
  fuel_method: 'split',
  platforms: ['Bolt', 'Wolt', 'Uber', 'Bolt/Wolt', 'Other'],
  morning_start: '07:00', morning_end: '15:00', morning_rate: null,
  night_start: '18:00', night_end: '02:00', night_rate: null
};

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS daily_logs (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
      work_date DATE NOT NULL, platform TEXT DEFAULT '', hours NUMERIC DEFAULT 0,
      orders_count INTEGER DEFAULT 0, odo_start NUMERIC, odo_end NUMERIC,
      manual_km NUMERIC DEFAULT 0, earnings NUMERIC DEFAULT 0, tips NUMERIC DEFAULT 0,
      fuel_override NUMERIC, maintenance NUMERIC DEFAULT 0, other_cost NUMERIC DEFAULT 0,
      personal_expense NUMERIC DEFAULT 0, notes TEXT DEFAULT '', source_key TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS source_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS daily_logs_user_source_key ON daily_logs(user_id,source_key);
    CREATE INDEX IF NOT EXISTS daily_logs_user_date ON daily_logs(user_id,work_date);
    CREATE TABLE IF NOT EXISTS fuel_fillups (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
      fill_date DATE NOT NULL, odometer NUMERIC, litres NUMERIC DEFAULT 0,
      total_paid NUMERIC DEFAULT 0, source_key TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE fuel_fillups ADD COLUMN IF NOT EXISTS source_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS fuel_user_source_key ON fuel_fillups(user_id,source_key);
    CREATE INDEX IF NOT EXISTS fuel_user_date ON fuel_fillups(user_id,fill_date);
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
      work_date DATE NOT NULL, shift1 TEXT DEFAULT '', hours1 NUMERIC, shift2 TEXT DEFAULT '',
      hours2 NUMERIC, notes TEXT DEFAULT '', UNIQUE(user_id,work_date)
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY REFERENCES users ON DELETE CASCADE,
      monthly_goal NUMERIC DEFAULT 1500, avg_consumption NUMERIC DEFAULT 0,
      fuel_method TEXT DEFAULT 'split', platforms JSONB DEFAULT '["Bolt","Wolt","Uber","Bolt/Wolt","Other"]'::jsonb,
      morning_start TEXT DEFAULT '07:00', morning_end TEXT DEFAULT '15:00', morning_rate NUMERIC,
      night_start TEXT DEFAULT '18:00', night_end TEXT DEFAULT '02:00', night_rate NUMERIC
    );
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS morning_rate NUMERIC;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS night_rate NUMERIC;
  `);
}

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email }, jwtSecret || 'dev-only-change-this-secret', { expiresIn: '30d' });
}
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.cookies?.session;
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    req.user = jwt.verify(token, jwtSecret || 'dev-only-change-this-secret');
    next();
  } catch {
    return res.status(401).json({ error: 'Your session expired. Sign in again.' });
  }
}
const numberOrNull = (v) => v === '' || v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v);
const numberOrZero = (v) => numberOrNull(v) ?? 0;
const validDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const settingsForSave = (d = {}) => ({
  monthly_goal: numberOrZero(d.monthly_goal),
  avg_consumption: numberOrZero(d.avg_consumption),
  fuel_method: d.fuel_method === 'average' ? 'average' : 'split',
  platforms: Array.isArray(d.platforms) ? d.platforms.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 50) : defaults.platforms,
  morning_start: d.morning_start || defaults.morning_start,
  morning_end: d.morning_end || defaults.morning_end,
  morning_rate: numberOrNull(d.morning_rate),
  night_start: d.night_start || defaults.night_start,
  night_end: d.night_end || defaults.night_end,
  night_rate: numberOrNull(d.night_rate)
});
async function saveSettings(client, userId, d) {
  const s = settingsForSave(d);
  await client.query(`INSERT INTO settings(user_id,monthly_goal,avg_consumption,fuel_method,platforms,morning_start,morning_end,morning_rate,night_start,night_end,night_rate)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(user_id) DO UPDATE SET monthly_goal=EXCLUDED.monthly_goal,avg_consumption=EXCLUDED.avg_consumption,
    fuel_method=EXCLUDED.fuel_method,platforms=EXCLUDED.platforms,morning_start=EXCLUDED.morning_start,
    morning_end=EXCLUDED.morning_end,morning_rate=EXCLUDED.morning_rate,night_start=EXCLUDED.night_start,
    night_end=EXCLUDED.night_end,night_rate=EXCLUDED.night_rate`,
  [userId,s.monthly_goal,s.avg_consumption,s.fuel_method,JSON.stringify(s.platforms),s.morning_start,s.morning_end,s.morning_rate,s.night_start,s.night_end,s.night_rate]);
}
function logValues(d) {
  return [d.work_date,d.platform || '',numberOrZero(d.hours),numberOrZero(d.orders_count),numberOrNull(d.odo_start),numberOrNull(d.odo_end),numberOrZero(d.manual_km),numberOrZero(d.earnings),numberOrZero(d.tips),numberOrNull(d.fuel_override),numberOrZero(d.maintenance),numberOrZero(d.other_cost),numberOrZero(d.personal_expense),d.notes || ''];
}
async function insertLog(client, userId, d, sourceKey = null) {
  if (!validDate(d.work_date)) throw new Error('A valid work date is required.');
  const v = logValues(d);
  await client.query(`INSERT INTO daily_logs(user_id,work_date,platform,hours,orders_count,odo_start,odo_end,manual_km,earnings,tips,fuel_override,maintenance,other_cost,personal_expense,notes,source_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT(user_id,source_key) DO UPDATE SET work_date=EXCLUDED.work_date,platform=EXCLUDED.platform,hours=EXCLUDED.hours,
    orders_count=EXCLUDED.orders_count,odo_start=EXCLUDED.odo_start,odo_end=EXCLUDED.odo_end,manual_km=EXCLUDED.manual_km,
    earnings=EXCLUDED.earnings,tips=EXCLUDED.tips,fuel_override=EXCLUDED.fuel_override,maintenance=EXCLUDED.maintenance,
    other_cost=EXCLUDED.other_cost,personal_expense=EXCLUDED.personal_expense,notes=EXCLUDED.notes`, [userId,...v,sourceKey]);
}
async function insertFuel(client, userId, d, sourceKey = null) {
  if (!validDate(d.fill_date)) throw new Error('A valid fill-up date is required.');
  await client.query(`INSERT INTO fuel_fillups(user_id,fill_date,odometer,litres,total_paid,source_key) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(user_id,source_key) DO UPDATE SET fill_date=EXCLUDED.fill_date,odometer=EXCLUDED.odometer,litres=EXCLUDED.litres,total_paid=EXCLUDED.total_paid`,
  [userId,d.fill_date,numberOrNull(d.odometer),numberOrZero(d.litres),numberOrZero(d.total_paid),sourceKey]);
}

app.get('/api/health', async (_req,res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: true }); }
  catch { res.status(503).json({ ok: false, database: false }); }
});
app.post('/api/auth/register', async (req,res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ error: 'Enter a valid email and a password with at least 8 characters.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = (await client.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email',[email,await bcrypt.hash(password,12)])).rows[0];
    await saveSettings(client,user.id,defaults);
    await client.query('COMMIT');
    res.status(201).json({ user, token: tokenFor(user) });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'An account with this email already exists.' : 'Could not create account.' });
  } finally { client.release(); }
});
app.post('/api/auth/login', async (req,res) => {
  try {
    const email=String(req.body.email||'').trim().toLowerCase();
    const q=await pool.query('SELECT id,email,password_hash FROM users WHERE email=$1',[email]);
    if(!q.rowCount || !await bcrypt.compare(String(req.body.password||''),q.rows[0].password_hash)) return res.status(401).json({error:'Email or password is incorrect.'});
    const user={id:q.rows[0].id,email:q.rows[0].email};
    return res.json({user,token:tokenFor(user)});
  } catch { return res.status(500).json({error:'Could not sign in. Try again.'}); }
});
app.post('/api/auth/logout',(_req,res)=>res.json({ok:true}));
app.get('/api/auth/me',auth,(req,res)=>res.json({user:{id:req.user.id,email:req.user.email}}));
app.get('/api/data',auth,async(req,res)=>{
  try {
    const id=req.user.id;
    const [logs,fuel,shifts,settingRows]=await Promise.all([
      pool.query('SELECT * FROM daily_logs WHERE user_id=$1 ORDER BY work_date DESC,id DESC',[id]),
      pool.query('SELECT * FROM fuel_fillups WHERE user_id=$1 ORDER BY fill_date DESC,id DESC',[id]),
      pool.query('SELECT * FROM shifts WHERE user_id=$1 ORDER BY work_date',[id]),
      pool.query('SELECT * FROM settings WHERE user_id=$1',[id])
    ]);
    const settings=settingRows.rows[0] || settingsForSave(defaults);
    res.json({logs:logs.rows,fuel:fuel.rows,shifts:shifts.rows,settings});
  } catch(e) { console.error('Load data failed:',e); res.status(500).json({error:'Could not load your saved tracker data.'}); }
});
app.post('/api/logs',auth,async(req,res)=>{
  try { if(!validDate(req.body.work_date)) return res.status(400).json({error:'Choose a valid work date.'}); const v=logValues(req.body); const row=(await pool.query(`INSERT INTO daily_logs(user_id,work_date,platform,hours,orders_count,odo_start,odo_end,manual_km,earnings,tips,fuel_override,maintenance,other_cost,personal_expense,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[req.user.id,...v])).rows[0]; res.status(201).json(row); }
  catch(e){console.error('Create log failed:',e);res.status(400).json({error:'Could not save work entry. Check the date and number fields.'});}
});
app.put('/api/logs/:id',auth,async(req,res)=>{
  try { if(!validDate(req.body.work_date)) return res.status(400).json({error:'Choose a valid work date.'}); const v=logValues(req.body);const q=await pool.query(`UPDATE daily_logs SET work_date=$1,platform=$2,hours=$3,orders_count=$4,odo_start=$5,odo_end=$6,manual_km=$7,earnings=$8,tips=$9,fuel_override=$10,maintenance=$11,other_cost=$12,personal_expense=$13,notes=$14 WHERE id=$15 AND user_id=$16 RETURNING *`,[...v,req.params.id,req.user.id]);if(!q.rowCount)return res.status(404).json({error:'Work entry not found.'});res.json(q.rows[0]); }
  catch(e){console.error('Update log failed:',e);res.status(400).json({error:'Could not update work entry.'});}
});
app.delete('/api/logs/:id',auth,async(req,res)=>{try{const q=await pool.query('DELETE FROM daily_logs WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);res.json({ok:true,deleted:q.rowCount});}catch(e){console.error(e);res.status(500).json({error:'Could not delete work entry.'});}});
app.post('/api/fuel',auth,async(req,res)=>{try{await insertFuel(pool,req.user.id,req.body);const row=(await pool.query('SELECT * FROM fuel_fillups WHERE user_id=$1 AND fill_date=$2 ORDER BY id DESC LIMIT 1',[req.user.id,req.body.fill_date])).rows[0];res.status(201).json(row);}catch(e){console.error('Create fill-up failed:',e);res.status(400).json({error:'Could not save fill-up. Check its date and values.'});}});
app.put('/api/fuel/:id',auth,async(req,res)=>{try{if(!validDate(req.body.fill_date))return res.status(400).json({error:'Choose a valid fill-up date.'});const q=await pool.query('UPDATE fuel_fillups SET fill_date=$1,odometer=$2,litres=$3,total_paid=$4 WHERE id=$5 AND user_id=$6 RETURNING *',[req.body.fill_date,numberOrNull(req.body.odometer),numberOrZero(req.body.litres),numberOrZero(req.body.total_paid),req.params.id,req.user.id]);if(!q.rowCount)return res.status(404).json({error:'Fill-up not found.'});res.json(q.rows[0]);}catch(e){console.error(e);res.status(400).json({error:'Could not update fill-up.'});}});
app.delete('/api/fuel/:id',auth,async(req,res)=>{try{const q=await pool.query('DELETE FROM fuel_fillups WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);res.json({ok:true,deleted:q.rowCount});}catch(e){console.error(e);res.status(500).json({error:'Could not delete fill-up.'});}});
app.put('/api/shifts',auth,async(req,res)=>{
  const client=await pool.connect();
  try { await client.query('BEGIN');for(const d of req.body.days||[]){if(!validDate(d.work_date))throw new Error('Invalid shift date.');await client.query(`INSERT INTO shifts(user_id,work_date,shift1,hours1,shift2,hours2,notes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,work_date) DO UPDATE SET shift1=EXCLUDED.shift1,hours1=EXCLUDED.hours1,shift2=EXCLUDED.shift2,hours2=EXCLUDED.hours2,notes=EXCLUDED.notes`,[req.user.id,d.work_date,d.shift1||'',numberOrNull(d.hours1),d.shift2||'',numberOrNull(d.hours2),d.notes||'']);}await client.query('COMMIT');res.json({ok:true,saved:(req.body.days||[]).length});}
  catch(e){await client.query('ROLLBACK');console.error('Save shifts failed:',e);res.status(400).json({error:'Could not save this shift plan.'});}finally{client.release();}
});
app.put('/api/settings',auth,async(req,res)=>{try{await saveSettings(pool,req.user.id,req.body);const q=await pool.query('SELECT * FROM settings WHERE user_id=$1',[req.user.id]);res.json(q.rows[0]);}catch(e){console.error('Save settings failed:',e);res.status(400).json({error:'Could not save settings.'});}});
app.post('/api/import',auth,async(req,res)=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    for(const d of req.body.logs||[])await insertLog(client,req.user.id,d,d.source_key||null);
    for(const d of req.body.fuel||[])await insertFuel(client,req.user.id,d,d.source_key||null);
    for(const d of req.body.shifts||[]){if(!validDate(d.work_date))continue;await client.query(`INSERT INTO shifts(user_id,work_date,shift1,hours1,shift2,hours2,notes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,work_date) DO UPDATE SET shift1=EXCLUDED.shift1,hours1=EXCLUDED.hours1,shift2=EXCLUDED.shift2,hours2=EXCLUDED.hours2,notes=EXCLUDED.notes`,[req.user.id,d.work_date,d.shift1||'',numberOrNull(d.hours1),d.shift2||'',numberOrNull(d.hours2),d.notes||'']);}
    if(req.body.settings)await saveSettings(client,req.user.id,req.body.settings);
    await client.query('COMMIT');res.json({ok:true,logs:(req.body.logs||[]).length,fuel:(req.body.fuel||[]).length,shifts:(req.body.shifts||[]).length});
  } catch(e){await client.query('ROLLBACK');console.error('Workbook import failed:',e);res.status(400).json({error:e.message||'Workbook import failed; check the workbook tabs and column headings.'});}finally{client.release();}
});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Unexpected server error.'});});
const port=process.env.PORT||4000;
init().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`API listening on ${port}`))).catch(e=>{console.error('Database initialization failed:',e);process.exit(1);});
