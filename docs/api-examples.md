# API examples

All API requests use HTTPS in deployed environments. The examples use `https://api.example.invalid` as a placeholder host. Values in angle brackets are placeholders, not credentials or literal values. Never put an access token, refresh token, WeChat secret, or database credential in logs or shared examples.

## Login and session use

The mini program obtains a one-time code with `wx.login` and sends that code to the backend. The backend exchanges it with WeChat over HTTPS; the app secret and WeChat session key stay server-side.

```http
POST /api/v1/auth/wechat-mini
Content-Type: application/json

{"code":"<one-time-wx-login-code>","deviceId":"<device-uuid>"}
```

The response contains an opaque access token and refresh token, plus `account.userId`, `account.spaceId`, and decimal-string `account.generation`. By default the access token lasts 900 seconds and the refresh token lasts 30 days. When supplied, the login `deviceId` is stored on the auth session. Send the access token as `Authorization: Bearer <access-token>`; do not treat `spaceId` as proof of ownership.

```http
GET /api/v1/me
Authorization: Bearer <access-token>
```

```json
{"userId":"<uuid>","spaceId":"<uuid>","generation":"1","protocolVersion":1}
```

Refresh with the refresh token in a JSON body. On a lost refresh response, retry the same token promptly: the default 30-second grace period returns the same successor credentials. Reuse outside that grace period revokes that session family.

```http
POST /api/v1/auth/refresh
Content-Type: application/json

{"refreshToken":"<refresh-token>"}
```

Logout revokes the current session. A missing, expired, or revoked access token returns `401 AUTH_REQUIRED`.

```http
POST /api/v1/auth/logout
Authorization: Bearer <access-token>
```

## Push operations and receipts

Use the account and generation returned by login or `/me`. `deviceId` is a UUID. Keep each operation ID and its canonical request body stable when retrying after a network failure. A successfully applied operation returns a stored receipt on an identical retry; reusing the operation ID with changed content yields `OPERATION_ID_REUSED`.

```http
POST /api/v1/sync/push
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "protocolVersion": 1,
  "spaceId": "<space-uuid>",
  "generation": "1",
  "deviceId": "<device-uuid>",
  "operations": [
    {
      "operationId": "<operation-uuid>",
      "kind": "project.create",
      "entityId": "<project-uuid>",
      "payload": {
        "id": "<project-uuid>",
        "name": "Reading",
        "parentId": null,
        "archived": false,
        "shortName": "Read",
        "color": "#4A90E2",
        "createdAtSec": 1700000000,
        "updatedAtSec": 1700000000
      }
    },
    {
      "operationId": "<another-operation-uuid>",
      "kind": "prefs.patch",
      "entityId": "account",
      "baseServerVersion": "0",
      "payload": {"dailyGoalEnabled": true, "dailyGoalMinutes": 60}
    },
    {
      "operationId": "<session-operation-uuid>",
      "kind": "session.createCompleted",
      "entityId": "<session-uuid>",
      "payload": {
        "id": "<session-uuid>",
        "projectId": "<project-uuid>",
        "status": "COMPLETED",
        "createdAtSec": 1700000100,
        "updatedAtSec": 1700000100,
        "startedAtSec": 1700000000,
        "endedAtSec": 1700000100,
        "durationSeconds": 100,
        "targetSeconds": null,
        "pauses": []
      }
    }
  ]
}
```

An applied result has `status: "applied"`, `committed: true`, and a `changes` receipt. A business conflict has `status: "conflict"`, `committed: false`, and a `code`; resolve it with a new operation ID. A response bounds the combined `results[].changes` to 220 KiB, divided across the operation results. Full receipts remain in PostgreSQL for idempotent retries. If a result has `hasMoreChanges: true`, acknowledge that operation, use the signed pull flow to apply authoritative changes through the push response's `upperSeq`, then upload the next queued operation. Project group changes (`reorder`, `archive`, `restore`, and `deleteSubtree`) carry `payload.expectedVersions`, mapping every affected project UUID to its current decimal-string server version. Completed sessions are immutable after creation; deleting one creates a tombstone.

Projects and completed sessions require integer `createdAtSec` and `updatedAtSec` values. The server validates completed-session start/end times, pause boundaries, project references, and calculated duration. One completed session including its pauses must fit within 220 KiB serialized JSON. `session.createCompleted` carries a `COMPLETED` session and its pauses in one payload. It does not accept client-supplied content changes to an existing completed session.

## Pull changes with a signed cursor

Start with the current generation and omit `cursor`. The first page returns a signed cursor tied to the authenticated account space, generation, protocol version, restore epoch, and fixed upper sequence. Pass that cursor back unchanged to get the next page; retry a page with the same cursor if the response is lost.

```http
GET /api/v1/sync/pull?generation=1&limit=50
Authorization: Bearer <access-token>
```

```http
GET /api/v1/sync/pull?generation=1&limit=50&cursor=<signed-cursor>
Authorization: Bearer <access-token>
```

Each change carries decimal-string `seq` and `serverVersion`, plus `entityType`, `entityId`, `data`, and `deleted`. A page has at most 100 changes and is capped at 240 KiB serialized JSON; one item larger than the cap is rejected. Continue until `hasMore` is false. Cursors cannot be changed to another account or generation; expired or invalid cursor state returns a protocol error.

## Snapshot and export paging

Create either a sync snapshot or an export snapshot with the active generation. The response returns an ID and a fixed upper sequence. At most 10 unexpired sync snapshots and exports may exist per space. Read pages with an `offset`; each page contains up to 50 immutable entries and is capped at 240 KiB serialized JSON. Snapshots expire after one day and are tied to the generation and restore epoch at creation.

```http
POST /api/v1/sync/snapshots
Authorization: Bearer <access-token>
Content-Type: application/json

{"generation":"1"}
```

```http
GET /api/v1/sync/snapshots/<snapshot-uuid>?offset=0
Authorization: Bearer <access-token>
```

Use `POST /api/v1/exports` and `GET /api/v1/exports/{id}` for the same immutable page shape as an export. The final page includes a signed cursor at the snapshot boundary; intermediate pages return `cursor: null`.

## Chunked guest-data import

Create a job with a stable UUID, the active generation, a source ID, and the expected chunk count. At most five unexpired uploading jobs may exist per space. Jobs expire after seven days and accept 1 to 1,000 zero-based chunks. Upload each chunk exactly once by content; identical retries are safe. Each chunk contains `projects` and `sessions` arrays and must fit within 256 KiB; the job has an 8 MiB total limit. The assembled job is limited to 500 projects and 10,000 sessions. Each completed-session entity is limited to 220 KiB.

```http
POST /api/v1/imports
Authorization: Bearer <access-token>
Content-Type: application/json

{"jobId":"<job-uuid>","sourceId":"guest-space","chunkCount":1,"generation":"1"}
```

```http
PUT /api/v1/imports/<job-uuid>/chunks/0
Authorization: Bearer <access-token>
Content-Type: application/json

{"projects":[],"sessions":[]}
```

Call `POST /api/v1/imports/preview` with the job ID after all chunks arrive. Resolve reported collisions and submit the returned `digest` as `sourceDigest` when committing. The optional `mapping` maps source project IDs to existing cloud project IDs.

```http
POST /api/v1/imports/preview
Authorization: Bearer <access-token>
Content-Type: application/json

{"jobId":"<job-uuid>"}
```

```http
POST /api/v1/imports/<job-uuid>/commit
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "confirmation":"MERGE_GUEST_DATA",
  "deviceId":"<device-uuid>",
  "sourceDigest":"<digest-from-preview>",
  "mapping":{},
  "sessionMapping":{}
}
```

`mapping` maps source project UUIDs to existing destination project UUIDs. `sessionMapping` maps a source session UUID to a new destination session UUID, or to the literal `"skip"` to omit it. Re-keyed session pauses receive new pause UUIDs and point to the destination session ID. Commit returns both source counts (`sourceProjectCount`, `sourceSessionCount`) and applied counts (`projectCount`, `sessionCount`, `pauseCount`), as well as both mappings. Skipped sessions are included in source counts and excluded from applied session and pause counts.

`GET /api/v1/imports/{id}` returns status and the digest for each received chunk. Import jobs expire after seven days.

## Clear account data

This operation keeps the account but marks its current facts deleted and advances the generation. Confirm it explicitly. Store the returned generation and stop sending requests from devices with the old generation.

```http
POST /api/v1/data/clear
Authorization: Bearer <access-token>
Content-Type: application/json

{"confirmation":"DELETE_ALL_ACCOUNT_DATA","operationId":"<operation-uuid>","generation":"1"}
```

## Account deletion request

The current endpoint records a request for policy review. It does not immediately delete identity data, revoke sessions, or purge account facts.

```http
POST /api/v1/account/deletion-requests
Authorization: Bearer <access-token>
Content-Type: application/json

{"confirmation":"REQUEST_ACCOUNT_DELETION"}
```

The result includes a request ID, `status: "pending_policy_review"`, and the request timestamp. `GET /api/v1/account/deletion-requests` returns `{request: null}` or the authenticated account's latest request (`id`, `status`, `requestedAt`). Another account's request cannot be queried. Repeated submissions return the same pending request. A retention policy and operational fulfillment remain release requirements; no cancel or public purge endpoint exists.

The isolated administrative fulfillment CLI exists at `npm run fulfill-deletion -- <request-id>`. It connects with `MIGRATION_DATABASE_URL` and requires `ACCOUNT_DELETION_CONFIRM` to equal that exact request ID. Only use it after the formal retention policy, applicant verification, and operational approval are in place; its transaction permanently removes the selected account and its data. This is an operator action, not a client API, and no real account deletion has been performed.

## Health checks and current limits

`GET /health/live` only reports that the process is alive. `GET /health/ready` checks PostgreSQL connectivity and applied migration version at least 5; it returns 503 if either check fails.

The current login and refresh rate limits are in-memory per server process, so they do not coordinate across multiple instances or survive restarts. Account-deletion POST records a pending request; GET reads that account's latest request. An administrative CLI fulfillment path exists, but the formal operator/contact, retention handling and authorization must be configured before production use. There is no client route to cancel a deletion request or purge an account.
