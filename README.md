# Courier Ledger

A full-stack courier finance tracker based on `Courier_Finance_Tracker.xlsx`. It includes account registration and sign-in, a dashboard, daily work logging, shift planning, fuel tracking, monthly and yearly reports, CSV report export, and import from the supplied Excel workbook.

## Local development

1. Create a PostgreSQL database and copy `server/.env.example` to `server/.env`.
2. Set `DATABASE_URL`, a long random `JWT_SECRET`, and `CLIENT_ORIGIN=http://localhost:5173`.
3. From the project root run `npm install`, then `npm run dev`.
4. Open `http://localhost:5173`. Register an account and use the up-arrow button to import the workbook.

The API creates its tables automatically on startup. Passwords are stored as bcrypt hashes. User-owned records are isolated by account.

## Deploy the API to Railway

Create a Railway project, add a PostgreSQL service, and deploy this repository with the **Root Directory** set to `/` (repository root). The root `railway.json` configures the service start command and health check. Add these variables to the API service:

- `DATABASE_URL`: Railway PostgreSQL connection URL (use the internal URL when the API and database are in one Railway project)
- `JWT_SECRET`: a long, random secret
- `CLIENT_ORIGIN`: your Vercel app URL, such as `https://courier-ledger.vercel.app`
- `NODE_ENV`: `production`

Railway health check path is `/api/health`.

## Deploy the frontend to Vercel

Import the repository in Vercel. Set **Root Directory** to `web`, framework preset to Vite, and add `VITE_API_URL=https://YOUR-RAILWAY-DOMAIN.up.railway.app/api`. The API must allow the exact deployed Vercel origin in `CLIENT_ORIGIN`. Deploy again after setting environment variables.

For local development the Vite app defaults to `http://localhost:4000/api`; set `VITE_API_URL` only when you need a different API URL.

## Workbook import

Sign in, press the up-arrow import button in the top bar, and select the workbook. Daily Log rows and Fuel fill-ups are imported into the active account. Re-importing inserts another copy of those rows; there is no automatic de-duplication.
