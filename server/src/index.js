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
  night_start: '18:00', night_end: '02:00', night_rate: null,
  manual_cost_per_km: 0, currency: 'EUR', distance_unit: 'km', date_format: 'dd/MM/yyyy', theme: 'light', timezone: 'Europe/Vilnius',
  disabled_platforms: [], expense_categories: ['Fuel','Maintenance / Repairs','Other Work Costs','Personal Expenses'],
  shift_types: [{name:'Morning',start:'07:00',end:'15:00',rate:null,color:'#86b99a'},{name:'Night',start:'18:00',end:'02:00',rate:null,color:'#7182a6'}]
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
      total_paid NUMERIC DEFAULT 0, full_tank BOOLEAN DEFAULT TRUE, station TEXT DEFAULT '',
      notes TEXT DEFAULT '', source_key TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE fuel_fillups ADD COLUMN IF NOT EXISTS source_key TEXT;
    ALTER TABLE fuel_fillups ADD COLUMN IF NOT EXISTS full_tank BOOLEAN DEFAULT TRUE;
    ALTER TABLE fuel_fillups ADD COLUMN IF NOT EXISTS station TEXT DEFAULT '';
    ALTER TABLE fuel_fillups ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
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
      night_start TEXT DEFAULT '18:00', night_end TEXT DEFAULT '02:00', night_rate NUMERIC,
      manual_cost_per_km NUMERIC DEFAULT 0, currency TEXT DEFAULT 'EUR', distance_unit TEXT DEFAULT 'km',
      date_format TEXT DEFAULT 'dd/MM/yyyy', theme TEXT DEFAULT 'light', timezone TEXT DEFAULT 'Europe/Vilnius',
      disabled_platforms JSONB DEFAULT '[]'::jsonb,
      expense_categories JSONB DEFAULT '["Fuel","Maintenance / Repairs","Other Work Costs","Personal Expenses"]'::jsonb,
      shift_types JSONB DEFAULT '[{"name":"Morning","start":"07:00","end":"15:00","rate":null,"color":"#86b99a"},{"name":"Night","start":"18:00","end":"02:00","rate":null,"color":"#7182a6"}]'::jsonb
    );
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS morning_rate NUMERIC;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS night_rate NUMERIC;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS manual_cost_per_km NUMERIC DEFAULT 0;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EUR';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS distance_unit TEXT DEFAULT 'km';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS date_format TEXT DEFAULT 'dd/MM/yyyy';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'light';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Europe/Vilnius';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS disabled_platforms JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS expense_categories JSONB DEFAULT '["Fuel","Maintenance / Repairs","Other Work Costs","Personal Expenses"]'::jsonb;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS shift_types JSONB DEFAULT '[{"name":"Morning","start":"07:00","end":"15:00","rate":null,"color":"#86b99a"},{"name":"Night","start":"18:00","end":"02:00","rate":null,"color":"#7182a6"}]'::jsonb;
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
      entity TEXT NOT NULL, entity_id TEXT, action TEXT NOT NULL, snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS audit_user_created ON audit_logs(user_id,created_at DESC);
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
const validDate = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const date = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === v;
};
const logError = (d) => {
  if (!validDate(d.work_date)) return 'Choose a valid work date.';
  for (const key of ['hours','orders_count','odo_start','odo_end','manual_km','earnings','tips','fuel_override','maintenance','other_cost','personal_expense']) {
    if (d[key] !== '' && d[key] != null && (!Number.isFinite(Number(d[key])) || Number(d[key]) < 0)) return `${key.replaceAll('_',' ')} must be a non-negative number.`;
  }
  if (d.odo_start !== '' && d.odo_start != null && d.odo_end !== '' && d.odo_end != null && Number(d.odo_end) < Number(d.odo_start)) return 'Odometer end cannot be lower than odometer start.';
  return '';
};
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
  night_rate: numberOrNull(d.night_rate),
  manual_cost_per_km: numberOrZero(d.manual_cost_per_km),
  currency: ['EUR','USD','GBP'].includes(d.currency) ? d.currency : 'EUR',
  distance_unit: d.distance_unit === 'mi' ? 'mi' : 'km',
  date_format: ['dd/MM/yyyy','MM/dd/yyyy','yyyy-MM-dd'].includes(d.date_format) ? d.date_format : 'dd/MM/yyyy',
  theme: d.theme === 'dark' ? 'dark' : 'light',
  timezone: typeof d.timezone === 'string' && d.timezone.length < 80 ? d.timezone : 'Europe/Vilnius',
  disabled_platforms: Array.isArray(d.disabled_platforms) ? d.disabled_platforms.map(String) : [],
  expense_categories: Array.isArray(d.expense_categories) ? d.expense_categories.map(String).map(x=>x.trim()).filter(Boolean).slice(0,30) : defaults.expense_categories
  ,shift_types: Array.isArray(d.shift_types) ? d.shift_types.filter(x=>x&&String(x.name||'').trim()&&String(x.name).toLowerCase()!=='off').slice(0,10).map((x,i)=>({name:String(x.name).trim().slice(0,30),start:/^\d{2}:\d{2}$/.test(x.start)?x.start:'09:00',end:/^\d{2}:\d{2}$/.test(x.end)?x.end:'17:00',rate:numberOrNull(x.rate),color:/^#[0-9a-f]{6}$/i.test(x.color)?x.color:['#86b99a','#7182a6','#d49b62','#9a7db3'][i%4]})) : defaults.shift_types
});
async function saveSettings(client, userId, d) {
  const s = settingsForSave(d);
  await client.query(`INSERT INTO settings(user_id,monthly_goal,avg_consumption,fuel_method,platforms,morning_start,morning_end,morning_rate,night_start,night_end,night_rate,manual_cost_per_km,currency,distance_unit,date_format,theme,timezone,disabled_platforms,expense_categories,shift_types)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT(user_id) DO UPDATE SET monthly_goal=EXCLUDED.monthly_goal,avg_consumption=EXCLUDED.avg_consumption,
    fuel_method=EXCLUDED.fuel_method,platforms=EXCLUDED.platforms,morning_start=EXCLUDED.morning_start,
    morning_end=EXCLUDED.morning_end,morning_rate=EXCLUDED.morning_rate,night_start=EXCLUDED.night_start,
    night_end=EXCLUDED.night_end,night_rate=EXCLUDED.night_rate,manual_cost_per_km=EXCLUDED.manual_cost_per_km,
    currency=EXCLUDED.currency,distance_unit=EXCLUDED.distance_unit,date_format=EXCLUDED.date_format,theme=EXCLUDED.theme,timezone=EXCLUDED.timezone,
    disabled_platforms=EXCLUDED.disabled_platforms,expense_categories=EXCLUDED.expense_categories,shift_types=EXCLUDED.shift_types`,
  [userId,s.monthly_goal,s.avg_consumption,s.fuel_method,JSON.stringify(s.platforms),s.morning_start,s.morning_end,s.morning_rate,s.night_start,s.night_end,s.night_rate,s.manual_cost_per_km,s.currency,s.distance_unit,s.date_format,s.theme,s.timezone,JSON.stringify(s.disabled_platforms),JSON.stringify(s.expense_categories),JSON.stringify(s.shift_types)]);
}
function logValues(d) {
  return [d.work_date,d.platform || '',numberOrZero(d.hours),numberOrZero(d.orders_count),numberOrNull(d.odo_start),numberOrNull(d.odo_end),numberOrZero(d.manual_km),numberOrZero(d.earnings),numberOrZero(d.tips),numberOrNull(d.fuel_override),numberOrZero(d.maintenance),numberOrZero(d.other_cost),numberOrZero(d.personal_expense),d.notes || ''];
}
async function insertLog(client, userId, d, sourceKey = null) {
  const validationError = logError(d);
  if (validationError) throw new Error(validationError);
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
  for (const key of ['odometer','litres','total_paid']) if (d[key] !== '' && d[key] != null && (!Number.isFinite(Number(d[key])) || Number(d[key]) < 0)) throw new Error(`${key} must be a non-negative number.`);
  const q = await client.query(`INSERT INTO fuel_fillups(user_id,fill_date,odometer,litres,total_paid,full_tank,station,notes,source_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(user_id,source_key) DO UPDATE SET fill_date=EXCLUDED.fill_date,odometer=EXCLUDED.odometer,litres=EXCLUDED.litres,total_paid=EXCLUDED.total_paid,full_tank=EXCLUDED.full_tank,station=EXCLUDED.station,notes=EXCLUDED.notes RETURNING *`,
  [userId,d.fill_date,numberOrNull(d.odometer),numberOrZero(d.litres),numberOrZero(d.total_paid),d.full_tank !== false,d.station || '',d.notes || '',sourceKey]);
  return q.rows[0];
}
async function audit(client,userId,entity,entityId,action,snapshot={}) {
  await client.query('INSERT INTO audit_logs(user_id,entity,entity_id,action,snapshot) VALUES($1,$2,$3,$4,$5)',[userId,entity,String(entityId||''),action,JSON.stringify(snapshot)]);
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
  try { const invalid=logError(req.body);if(invalid)return res.status(400).json({error:invalid});const v=logValues(req.body);const client=await pool.connect();try{await client.query('BEGIN');const row=(await client.query(`INSERT INTO daily_logs(user_id,work_date,platform,hours,orders_count,odo_start,odo_end,manual_km,earnings,tips,fuel_override,maintenance,other_cost,personal_expense,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[req.user.id,...v])).rows[0];await audit(client,req.user.id,'daily_log',row.id,'create',row);await client.query('COMMIT');res.status(201).json(row);}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();} }
  catch(e){console.error('Create log failed:',e);res.status(400).json({error:'Could not save work entry. Check the date and number fields.'});}
});
app.put('/api/logs/:id',auth,async(req,res)=>{
  try { const invalid=logError(req.body);if(invalid)return res.status(400).json({error:invalid});const v=logValues(req.body),client=await pool.connect();try{await client.query('BEGIN');const q=await client.query(`UPDATE daily_logs SET work_date=$1,platform=$2,hours=$3,orders_count=$4,odo_start=$5,odo_end=$6,manual_km=$7,earnings=$8,tips=$9,fuel_override=$10,maintenance=$11,other_cost=$12,personal_expense=$13,notes=$14 WHERE id=$15 AND user_id=$16 RETURNING *`,[...v,req.params.id,req.user.id]);if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Work entry not found.'});}await audit(client,req.user.id,'daily_log',req.params.id,'update',q.rows[0]);await client.query('COMMIT');res.json(q.rows[0]);}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();} }
  catch(e){console.error('Update log failed:',e);res.status(400).json({error:'Could not update work entry.'});}
});
app.post('/api/logs/bulk-delete',auth,async(req,res)=>{const ids=Array.isArray(req.body.ids)?req.body.ids.filter(id=>Number.isInteger(Number(id))).map(Number).slice(0,500):[];if(!ids.length)return res.status(400).json({error:'Select at least one record.'});const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('DELETE FROM daily_logs WHERE user_id=$1 AND id=ANY($2::int[]) RETURNING *',[req.user.id,ids]);for(const row of q.rows)await audit(client,req.user.id,'daily_log',row.id,'bulk_delete',row);await client.query('COMMIT');res.json({ok:true,deleted:q.rowCount});}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Could not delete selected rows.'});}finally{client.release();}});
app.delete('/api/logs/:id',auth,async(req,res)=>{try{const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('DELETE FROM daily_logs WHERE id=$1 AND user_id=$2 RETURNING *',[req.params.id,req.user.id]);if(q.rowCount)await audit(client,req.user.id,'daily_log',req.params.id,'delete',q.rows[0]);await client.query('COMMIT');res.json({ok:true,deleted:q.rowCount});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}catch(e){console.error(e);res.status(500).json({error:'Could not delete work entry.'});}});
app.post('/api/fuel',auth,async(req,res)=>{try{const client=await pool.connect();try{await client.query('BEGIN');const row=await insertFuel(client,req.user.id,req.body);await audit(client,req.user.id,'fuel',row.id,'create',row);await client.query('COMMIT');res.status(201).json(row);}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}catch(e){console.error('Create fill-up failed:',e);res.status(400).json({error:e.message||'Could not save fill-up. Check its date and values.'});}});
app.put('/api/fuel/:id',auth,async(req,res)=>{
  if(!validDate(req.body.fill_date))return res.status(400).json({error:'Choose a valid fill-up date.'});
  for(const key of ['odometer','litres','total_paid'])if(req.body[key]!==''&&req.body[key]!=null&&(!Number.isFinite(Number(req.body[key]))||Number(req.body[key])<0))return res.status(400).json({error:`${key} must be a non-negative number.`});
  const client=await pool.connect();
  try{await client.query('BEGIN');const q=await client.query('UPDATE fuel_fillups SET fill_date=$1,odometer=$2,litres=$3,total_paid=$4,full_tank=$5,station=$6,notes=$7 WHERE id=$8 AND user_id=$9 RETURNING *',[req.body.fill_date,numberOrNull(req.body.odometer),numberOrZero(req.body.litres),numberOrZero(req.body.total_paid),req.body.full_tank!==false,req.body.station||'',req.body.notes||'',req.params.id,req.user.id]);if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Fill-up not found.'});}await audit(client,req.user.id,'fuel',req.params.id,'update',q.rows[0]);await client.query('COMMIT');res.json(q.rows[0]);}catch(e){await client.query('ROLLBACK');console.error(e);res.status(400).json({error:'Could not update fill-up.'});}finally{client.release();}
});
app.delete('/api/fuel/:id',auth,async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('DELETE FROM fuel_fillups WHERE id=$1 AND user_id=$2 RETURNING *',[req.params.id,req.user.id]);if(q.rowCount)await audit(client,req.user.id,'fuel',req.params.id,'delete',q.rows[0]);await client.query('COMMIT');res.json({ok:true,deleted:q.rowCount});}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Could not delete fill-up.'});}finally{client.release();}});
app.put('/api/planner',auth,async(req,res)=>{
  const client=await pool.connect();const days=Array.isArray(req.body.days)?req.body.days:[];
  try{await client.query('BEGIN');for(const d of days){if(!validDate(d.work_date))throw new Error('Invalid shift date.');for(const key of ['hours1','hours2'])if(d[key]!==''&&d[key]!=null&&(!Number.isFinite(Number(d[key]))||Number(d[key])<0))throw new Error('Planned shift hours must be zero or greater.');if(d.shift1&&d.shift1===d.shift2&&d.shift1!=='Off')throw new Error('Choose different shift types for split shifts.');const q=await client.query(`INSERT INTO shifts(user_id,work_date,shift1,hours1,shift2,hours2,notes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,work_date) DO UPDATE SET shift1=EXCLUDED.shift1,hours1=EXCLUDED.hours1,shift2=EXCLUDED.shift2,hours2=EXCLUDED.hours2,notes=EXCLUDED.notes RETURNING *`,[req.user.id,d.work_date,d.shift1||'',numberOrNull(d.hours1),d.shift2||'',numberOrNull(d.hours2),d.notes||'']);await audit(client,req.user.id,'shift',d.work_date,'upsert',q.rows[0]);}if(req.body.settings)await saveSettings(client,req.user.id,req.body.settings);await client.query('COMMIT');res.json({ok:true,saved:days.length});}catch(e){await client.query('ROLLBACK');console.error('Save planner failed:',e);res.status(400).json({error:e.message||'Could not save this shift plan.'});}finally{client.release();}
});
app.put('/api/shifts',auth,async(req,res)=>{
  const client=await pool.connect();
  try { await client.query('BEGIN');for(const d of req.body.days||[]){if(!validDate(d.work_date))throw new Error('Invalid shift date.');for(const key of ['hours1','hours2'])if(d[key]!==''&&d[key]!=null&&(!Number.isFinite(Number(d[key]))||Number(d[key])<0))throw new Error('Planned shift hours must be zero or greater.');if(d.shift1&&d.shift1===d.shift2&&d.shift1!=='Off')throw new Error('Choose different shift types for split shifts.');await client.query(`INSERT INTO shifts(user_id,work_date,shift1,hours1,shift2,hours2,notes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,work_date) DO UPDATE SET shift1=EXCLUDED.shift1,hours1=EXCLUDED.hours1,shift2=EXCLUDED.shift2,hours2=EXCLUDED.hours2,notes=EXCLUDED.notes`,[req.user.id,d.work_date,d.shift1||'',numberOrNull(d.hours1),d.shift2||'',numberOrNull(d.hours2),d.notes||'']);}await client.query('COMMIT');res.json({ok:true,saved:(req.body.days||[]).length});}
  catch(e){await client.query('ROLLBACK');console.error('Save shifts failed:',e);res.status(400).json({error:'Could not save this shift plan.'});}finally{client.release();}
});
app.put('/api/settings',auth,async(req,res)=>{try{await saveSettings(pool,req.user.id,req.body);const q=await pool.query('SELECT * FROM settings WHERE user_id=$1',[req.user.id]);res.json(q.rows[0]);}catch(e){console.error('Save settings failed:',e);res.status(400).json({error:'Could not save settings.'});}});
app.post('/api/import',auth,async(req,res)=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    if (req.body.mode === 'replace') {
      await client.query('DELETE FROM daily_logs WHERE user_id=$1',[req.user.id]);
      await client.query('DELETE FROM fuel_fillups WHERE user_id=$1',[req.user.id]);
      await client.query('DELETE FROM shifts WHERE user_id=$1',[req.user.id]);
    }
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
