# Mapplex FileGDB Conversion Worker

External GDAL/OpenFileGDB worker for importing Esri File Geodatabase archives
into Mapplex and exporting Mapplex GeoPackages as zipped FileGDB directories.

The frontend sends `.gdb.zip` files to the import endpoint or a locally built
`.gpkg` to the export endpoint. Import injects Mapplex domain metadata so the
existing app pipeline can create lexicons and field bindings. Export preserves
typed fields, geometries, CRS, native coded domains, and the bounded Mapplex
round-trip metadata table created by the app.

## Why A Worker?

FileGDB parsing depends on GDAL/OpenFileGDB and can be CPU/memory heavy. Keeping
it outside the browser protects mobile devices and keeps the core app importer
small.

## Run Locally

```bash
docker build -t mapplex-filegdb-import-worker .
docker run --rm -p 8080:8080 -e ALLOW_UNAUTHENTICATED=true mapplex-filegdb-import-worker
```

`ALLOW_UNAUTHENTICATED=true` is a local-development escape hatch. Bind the
container to localhost and never use this setting for a shared or production
worker.

Or with Compose:

```bash
docker compose up --build
```

Point Mapplex at it:

```env
VITE_GDB_IMPORT_WORKER_URL=http://localhost:8080/convert-filegdb
```

Put that override in the frontend's `.env.local` only when the Docker worker is
actually running. Without an override, Vite development calls
`/gdb-worker/convert-filegdb`; the Vite server proxies that route to
`https://gdb.geova.net/convert-filegdb`. Production builds use the canonical
hosted URL directly.

## Smoke Test

The schema/domain bridge can be tested without Docker or a real FileGDB:

```bash
python -m unittest test_archive_limits.py test_worker_auth.py test_mapplex_schema.py test_filegdb_export.py
```

This verifies archive limits, authentication, domain bridging, GeoPackage
validation, and the required `.gdb/` ZIP layout without requiring a live GDAL
conversion.

## Optional Worker Environment

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-public-anon-key
CORS_ORIGINS=https://app.example.com,https://localhost,capacitor://localhost
MAX_UPLOAD_MB=512
MAX_EXTRACTED_MB=2048
MAX_ZIP_MEMBERS=100000
MAX_CONCURRENT_CONVERSIONS=1
CONVERT_TIMEOUT_SECONDS=1800
KEEP_WORKER_TEMP=false
AUTH_TIMEOUT_SECONDS=8
```

For production, the frontend sends the signed-in user's short-lived Supabase
access token. The worker validates it against `SUPABASE_URL/auth/v1/user`
*before* FastAPI parses the multipart upload. `SUPABASE_ANON_KEY` is the public
project key used to call Supabase Auth; do not configure a service-role key.
The CORS middleware intentionally wraps this authentication middleware so 401,
503, and overload responses remain readable by Capacitor WebView instead of
being collapsed into a generic browser network error.

Before uploading a large archive, Mapplex probes `GET /health` for up to two
minutes. This accommodates free-instance cold starts without automatically
replaying a multipart conversion request. The user session is restored or
refreshed after the readiness check and immediately before the upload.

`GDB_IMPORT_WORKER_TOKEN` remains available for private server-to-server
automation, but it must never be placed in a `VITE_*` variable or browser
bundle. When neither Supabase validation nor a private service token is
configured, the worker fails closed with HTTP 503.

The `ALLOW_UNAUTHENTICATED` escape hatch is ignored whenever Render's built-in
`RENDER=true` environment marker is present. This prevents a copied local
Compose setting from making the hosted converter public.

Recommended production controls are an exact `CORS_ORIGINS` allowlist, platform
request/concurrency limits, private networking where possible, and per-user
usage monitoring. CORS is not an authentication control.

## Render Docker deployment

Deploy this directory as a Render Docker web service. The image binds Uvicorn
to Render's injected `PORT` on `0.0.0.0`; no Docker command override is needed.
Configure the production environment in the Render dashboard:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-public-anon-key
CORS_ORIGINS=https://your-mapplex-app.example,https://localhost,capacitor://localhost
ALLOW_UNAUTHENTICATED=false
MAX_UPLOAD_MB=512
MAX_EXTRACTED_MB=2048
MAX_ZIP_MEMBERS=100000
MAX_CONCURRENT_CONVERSIONS=1
CONVERT_TIMEOUT_SECONDS=1800
KEEP_WORKER_TEMP=false
```

Do not set `ALLOW_UNAUTHENTICATED` on Render. Mapplex uploads the `.gdb.zip`
directly to this service; the middleware validates the user's Supabase access
token and reserves the conversion slot before multipart parsing begins. One
conversion slot is the conservative default because an upload can temporarily
occupy space for the ZIP, extracted FileGDB, and output GeoPackage at the same
time. Archive entry and expanded-byte limits are checked before extraction to
contain compressed ZIP expansion. Raise any limit only after measuring the selected Render instance's CPU,
memory, temporary-disk use, and conversion duration with representative files.

Temporary conversion data intentionally uses Render's ephemeral filesystem and
is deleted after the response or any handled failure. A persistent disk is not
needed unless conversion changes into an asynchronous job system; if the
instance restarts mid-conversion, the client receives a failure and can retry.

## API

`GET /health`

Returns service health.

`POST /convert-filegdb`

Multipart fields:

- `file`: `.gdb.zip`
- `project_id`: optional Mapplex project id
- `target_layer_id`: optional selected layer id
- `return_format`: must be `gpkg`
- `include_domains`: `true` by default

Response:

- `200 application/geopackage+sqlite3`
- body is the converted `.gpkg`
- headers include domain counts:
  - `X-Mapplex-Domain-Count`
  - `X-Mapplex-Field-Domain-Count`

`POST /export-filegdb`

Multipart fields:

- `file`: a Mapplex-generated `.gpkg`
- `project_id`: optional Mapplex project id for response diagnostics
- `project_name`: optional safe output basename
- `return_format`: must be `gdb_zip`

Response:

- `200 application/zip`
- body is `<project>.gdb.zip`, containing `<project>.gdb/` at the archive root
- headers include `X-Mapplex-Feature-Count` and `X-Mapplex-Layer-Count`

## Current Scope

- Import: `.gdb.zip` -> `.gpkg` + Mapplex domain/attachment bridges.
- Export Phase A: Mapplex `.gpkg` -> `.gdb.zip`, including feature geometry,
  typed fields, WGS84 CRS, coded domains, forms, Smart Logic, layer styles, and
  semantic aliases.

Mapplex metadata is stored as a non-spatial FileGDB table and is restored only
after the importing user explicitly approves it. Native ArcGIS attachment
relationship-class creation and arbitrary ArcGIS relationship export are not
part of Phase A. Existing attachment summaries and Mapplex tables may travel as
ordinary attribute data, but consumers must not treat them as ArcGIS-native
attachment relationships.
