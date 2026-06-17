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

Use the included `Dockerfile` as the render build. The service listens on `PORT=8081` by default and exposes `/api/health` for health checks.

## Notes

The backend includes the export snapshot under `exports/convex-prod-full-export-2026-06-06/` so file lookup fallback continues to work after deployment.
