# Endpoints

## Health

### `GET /healthz`

Liveness probe. **Public** — no authentication. Dependency-free and cheap (used
by the ALB target group and the ECS container health check).

**Responses**

| Status | Body |
| --- | --- |
| `200` | `{ "status": "ok", "uptime": <seconds>, "timestamp": "<ISO-8601>" }` |

```bash
curl https://<host>/healthz
# {"status":"ok","uptime":12.34,"timestamp":"2026-06-30T14:00:00.000Z"}
```

## Identity

### `GET /api/me` 🔒

Returns the authenticated caller's identity, derived from the verified token
claims. **Requires** a bearer token.

**Responses**

| Status | Body |
| --- | --- |
| `200` | identity object (below) |
| `401` | `{ "error": "Invalid or expired token" }` |

| Field | Type | Source claim | Notes |
| --- | --- | --- | --- |
| `id` | string | `oid` | Immutable user object id |
| `name` | string | `name` | Display name |
| `username` | string | `preferred_username` | Usually UPN/email |
| `tenantId` | string | `tid` | Entra tenant id |
| `roles` | string[] | `roles` | App roles (empty if none) |

```bash
curl https://<host>/api/me -H "Authorization: Bearer <token>"
# {"id":"00000000-...","name":"Ada Lovelace","username":"ada@contoso.com","tenantId":"...","roles":[]}
```

## Items

An example REST resource backed by an in-memory store (seeded with
`{id:1,name:"first"}` and `{id:2,name:"second"}`). All routes **require** a bearer
token.

**Item**

| Field | Type | Notes |
| --- | --- | --- |
| `id` | number | Server-assigned |
| `name` | string | 1–100 chars |

### `GET /api/items` 🔒

List all items.

| Status | Body |
| --- | --- |
| `200` | `Item[]` |
| `401` | `{ "error": "Invalid or expired token" }` |

```bash
curl https://<host>/api/items -H "Authorization: Bearer <token>"
# [{"id":1,"name":"first"},{"id":2,"name":"second"}]
```

### `GET /api/items/{id}` 🔒

Fetch one item by id.

**Path parameters**

| Name | Type | Required | Constraints |
| --- | --- | --- | --- |
| `id` | number | yes | integer, positive (coerced from the path string) |

| Status | Body |
| --- | --- |
| `200` | `Item` |
| `400` | `id` not a positive integer (validation error) |
| `401` | `{ "error": "Invalid or expired token" }` |
| `404` | `{ "error": "Item <id> not found" }` |

```bash
curl https://<host>/api/items/1 -H "Authorization: Bearer <token>"
# {"id":1,"name":"first"}
```

### `POST /api/items` 🔒

Create an item.

**Request body**

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | string | yes | trimmed, 1–100 chars |

| Status | Body |
| --- | --- |
| `201` | the created `Item` |
| `400` | validation error (e.g. missing/empty `name`) |
| `401` | `{ "error": "Invalid or expired token" }` |
| `413` | body exceeds `JSON_BODY_LIMIT` |

```bash
curl -X POST https://<host>/api/items \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"third"}'
# {"id":3,"name":"third"}
```
