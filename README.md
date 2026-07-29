# Mapplex FileGDB Import Worker

External GDAL/OpenFileGDB worker for importing Esri File Geodatabase archives
into Mapplex.

The frontend sends `.gdb.zip` files here. The worker converts them to a
GeoPackage and injects Mapplex domain metadata tables so the existing app import
path can create lexicons and field bindings.

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

In Vite dev mode, Mapplex defaults to
`http://localhost:8080/convert-filegdb` when `VITE_GDB_IMPORT_WORKER_URL` is not
set. Production builds still require an explicit worker URL.

## Smoke Test

The schema/domain bridge can be tested without Docker or a real FileGDB:

```bash
python -m unittest test_archive_limits.py test_worker_auth.py test_mapplex_schema.py
```

This verifies that `ogrinfo -json`-style coded domains are converted into
Mapplex metadata and written into the SQLite/GPKG tables consumed by the app.

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

## Current Scope

This worker is import-only:

`.gdb.zip` -> `.gpkg` + Mapplex domain tables

FileGDB export should be a separate endpoint later:

Mapplex GPKG/schema bundle -> `.gdb.zip`

GDAL/OpenFileGDB supports FileGDB vector write/create in modern GDAL, so export
is technically viable, but it should be implemented after import is validated
with real customer geodatabases.
