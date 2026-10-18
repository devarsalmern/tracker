# Courier Ledger

A private courier finance tracker built from the nine-tab `Courier_Finance_Tracker.xlsx` workbook. It includes account registration, a PostgreSQL API, dashboard, daily log, configurable dated shift planner, fuel management, daily/monthly/yearly reports, editable platform/category settings, and workbook import/export.

The production stack is React + Vite, Express, PostgreSQL, and signed bearer-token authentication. The database stores each user's records separately; the API verifies the account token and scopes every read and write by user ID. Passwords are bcrypt-hashed. This is the Railway/Render equivalent stack, rather than Supabase Auth.

## Local development

1. Install Node.js 18+ and PostgreSQL.
2. Copy `server/.env.example` to `server/.env` and set:
   - `DATABASE_URL` to your PostgreSQL connection string.
   - `JWT_SECRET` to a private random string of at least 32 characters.
   - `CLIENT_ORIGIN=http://localhost:5173`.
3. From the repository root run `npm install` and `npm run dev`.
4. Open `http://localhost:5173`, create an account, then use **Import / Export** to preview and import the workbook.
5. Run `npm run build` for a production frontend build and `npm test` for the calculation unit tests.

The API creates and safely extends its PostgreSQL tables/indexes on startup. Keep `DATABASE_URL` and `JWT_SECRET` private. Existing rows are retained during schema updates.

## Deploy the API to Render

1. Create a PostgreSQL database in Render. Keep it in the same region as the API service.
2. Create a **Web Service** from this repository and select the `main` branch.
3. Set the root directory to `/`, build command to `npm install`, and start command to `npm run start`.
4. Add these environment variables to the Web Service:
   - `DATABASE_URL`: Render's **Internal Database URL** (or the External URL if the API runs outside Render).
   - `JWT_SECRET`: a private random value with at least 32 characters.
   - `CLIENT_ORIGIN`: the exact Vercel origin, for example `https://hisabketaab.vercel.app` (no path; a trailing slash is accepted).
   - `NODE_ENV=production`.
5. Set the health-check path to `/api/health`. The API health check also verifies that PostgreSQL is reachable.
6. Deploy. Database tables and additive schema updates are applied by the API at startup.

## Deploy the frontend to Vercel

1. Import the GitHub repository in Vercel and use the `main` branch.
2. Set the root directory to `web` and framework preset to **Vite**.
3. Add `VITE_API_URL=https://YOUR-RENDER-SERVICE.onrender.com/api` to Production (and Preview if needed).
4. Deploy or redeploy after adding the variable. Add the resulting Vercel origin to Render's `CLIENT_ORIGIN`, then redeploy the API if you changed it.

The client saves the login token in the browser and sends it as a bearer token, so it does not depend on third-party cookies. Users may need to sign in again after the authentication update.

## Deploy the API to Railway instead

Create a Railway project, add PostgreSQL, and deploy this repository from its root. The root `railway.json` contains the start command and health check. Set `DATABASE_URL` to Railway's internal PostgreSQL URL, `JWT_SECRET` to a private 32+ character value, `CLIENT_ORIGIN` to the Vercel origin, and `NODE_ENV=production`. Set Vercel's `VITE_API_URL` to the Railway service URL ending in `/api`.

## Workbook import, backup, and export

In **Import / Export**, choose the original workbook or a Courier Ledger backup. The app previews valid row counts, duplicate Daily Log records, and row-level input errors before import. Confirm either append/update or replacement; replacement requires a separate confirmation and runs transactionally. Derived financial values are recalculated by the app from source inputs.

Download a full Excel backup from the same page. It contains Daily Log, Fuel, dated Shift Data, Lists, and account settings and can be imported again. Daily Log also supports filtered CSV export; fuel and Daily Log have separate Excel exports.

## Calculation rules

- Distance uses a valid odometer end minus start; otherwise it uses manual kilometres. Manual kilometres never add to a valid odometer distance.
- Total income is earnings plus tips. Work costs are fuel plus maintenance plus other work costs. Personal costs affect total expenses and net savings, not net profit.
- A Daily Log fuel override takes precedence. Fill-up split allocates closed-period payments by eligible work kilometres. Average consumption is only calculated from a reliable increasing sequence of full-tank readings; manual average and manual €/km fallbacks are available.
- Shift schedules are stored by actual date. Overnight shifts are attributed to their start date; two different shift types may be assigned to one day.

## Environment variable reference

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Render/Railway API | PostgreSQL connection string |
| `JWT_SECRET` | Render/Railway API | Signs user login tokens; use a random 32+ character secret |
| `CLIENT_ORIGIN` | Render/Railway API | Allowed Vercel origin, such as `https://hisabketaab.vercel.app` |
| `NODE_ENV` | Render/Railway API | Set to `production` |
| `VITE_API_URL` | Vercel | API base URL ending in `/api` |
