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
docker run --rm -p 8080:8080 mapplex-filegdb-import-worker
```

Or with Compose:

```bash
docker compose up --build
```

Point Mapplex at it:

```env
VITE_GDB_IMPORT_WORKER_URL=http://localhost:8080/convert-filegdb
VITE_GDB_IMPORT_WORKER_TOKEN=
```

In Vite dev mode, Mapplex defaults to
`http://localhost:8080/convert-filegdb` when `VITE_GDB_IMPORT_WORKER_URL` is not
set. Production builds still require an explicit worker URL.

## Smoke Test

The schema/domain bridge can be tested without Docker or a real FileGDB:

```bash
python -m unittest test_mapplex_schema.py
```

This verifies that `ogrinfo -json`-style coded domains are converted into
Mapplex metadata and written into the SQLite/GPKG tables consumed by the app.

## Optional Worker Environment

```env
GDB_IMPORT_WORKER_TOKEN=
CORS_ORIGINS=*
MAX_UPLOAD_MB=512
CONVERT_TIMEOUT_SECONDS=1800
KEEP_WORKER_TEMP=false
```

`GDB_IMPORT_WORKER_TOKEN` is only a lightweight gate if the frontend also sets
`VITE_GDB_IMPORT_WORKER_TOKEN`. Because Vite exposes frontend env values to the
browser, production deployments should still protect this service with platform
auth, private networking, signed upload URLs, or rate limits.

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
