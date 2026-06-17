# Mongo Test Backend

This backend is for the Test Convex to MongoDB migration. It moves data and workflow APIs to MongoDB while keeping file storage on Test Convex for this phase.

## Required Environment

- `MONGODB_URI`: MongoDB connection string.
- `MONGODB_DB_NAME`: optional, defaults to `expenseclaim_test`.
- `FIREBASE_PROJECT_ID`: optional, defaults to `expense-bktcorp`.
- `TEST_CONVEX_URL`: Test Convex deployment URL used only by the storage bridge.
- `FIREBASE_SERVICE_ACCOUNT_JSON` or application default credentials for Firebase Admin token verification.
- `MONGO_BACKEND_ALLOW_UNVERIFIED_AUTH=true`: local/test-only escape hatch for requests with `Authorization: Bearer test:<email>` or `x-user-email`.

## Commands

```sh
npm run backend:build-migration-export -- exports/convex-prod-full-export-2026-06-06 exports/mongo-migration-2026-06-06
npm run backend:ensure-indexes
npm run backend:import-convex-export -- exports/mongo-migration-2026-06-06
npm run backend:validate-migration -- exports/mongo-migration-2026-06-06
npm run backend:dev
```

## API Shape

The compatibility route is:

```txt
POST /api/functions/:namespace/:name
```

Request body:

```json
{ "args": { "demoUserId": "..." } }
```

Response body:

```json
{ "result": {} }
```

The backend also exposes a small REST surface for direct callers:

- `GET /api/health`
- `GET /api/app/release-info`
- `GET /api/auth/me`
- `GET /api/users`
- `POST /api/users`
- `GET /api/claims`
- `POST /api/claims`
- `GET /api/claims/:id`
- `GET /api/vendors`
- `POST /api/vendors`
- `GET /api/analytics/claims-overview`

## Storage Bridge

These calls are intentionally forwarded to Test Convex:

- `claims.generateAttachmentUploadUrl`
- `claims.getAttachmentUrl`
- `claims.getClaimAssetUrls`
- `vendors.generateVendorDocumentUploadUrl`
- `vendors.listVendorDocuments`

Mongo records keep Convex storage ids. R2 migration is out of scope for this phase.
