# Expense Claim Backend

Standalone MongoDB backend for the Expense Claim app.

## Run locally

```sh
npm install
npm run backend:dev
```

## Required environment

- `MONGODB_URI`
- `MONGODB_DB_NAME` optional, defaults to `expenseclaim_test`
- `FIREBASE_PROJECT_ID` optional, defaults to `expense-bktcorp`
- `TEST_CONVEX_URL` used by the storage bridge
- `FIREBASE_SERVICE_ACCOUNT_JSON` or application default credentials
- `MONGO_BACKEND_ALLOW_UNVERIFIED_AUTH=true` for local test-only auth

## Render

Use the included `render.yaml` or point Render at the `Dockerfile`. The service listens on `PORT=8081` by default and exposes `/api/health` for health checks.

## Render env vars

- `MONGODB_URI`
- `TEST_CONVEX_URL`
- `FIREBASE_SERVICE_ACCOUNT_JSON` if you need Firebase token verification
- `BACKEND_CORS_ORIGIN` set to your Vercel frontend URL
- `APP_RELEASE_VERSION` optional, useful for release tracking

`MONGODB_DB_NAME` defaults to `expenseclaim_test`.
`FIREBASE_PROJECT_ID` defaults to `expense-bktcorp`.
