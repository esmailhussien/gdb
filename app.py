import asyncio
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

from archive_limits import ArchiveLimitError, validate_archive_infos
from mapplex_attachments import promote_esri_attachment_tables
from mapplex_schema import extract_domain_metadata, write_mapplex_schema_tables
from worker_auth import AuthenticationError, authentication_status, require_token


MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "512"))
MAX_EXTRACTED_MB = int(os.getenv("MAX_EXTRACTED_MB", "2048"))
MAX_ZIP_MEMBERS = int(os.getenv("MAX_ZIP_MEMBERS", "100000"))
CONVERT_TIMEOUT_SECONDS = int(os.getenv("CONVERT_TIMEOUT_SECONDS", "1800"))
CORS_ORIGINS = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "*").split(",") if origin.strip()]
MAX_CONCURRENT_CONVERSIONS = max(1, int(os.getenv("MAX_CONCURRENT_CONVERSIONS", "1")))
CONVERSION_SLOTS = asyncio.Semaphore(MAX_CONCURRENT_CONVERSIONS)

app = FastAPI(title="Mapplex FileGDB Import Worker", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS or ["*"],
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def authenticate_conversion_before_upload(request: Request, call_next):
    if request.method == "POST" and request.url.path == "/convert-filegdb":
        # Authenticate before FastAPI parses or writes the multipart upload.
        try:
            request.state.worker_identity = await asyncio.to_thread(require_token, request.headers)
        except AuthenticationError as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

        # Bound upload parsing, temporary disk expansion, and GDAL subprocesses
        # together. A direct-upload worker should reject overload rather than
        # queue multiple large multipart bodies in memory or ephemeral storage.
        try:
            await asyncio.wait_for(CONVERSION_SLOTS.acquire(), timeout=0.1)
        except TimeoutError:
            return JSONResponse(
                status_code=503,
                content={"detail": "FileGDB worker is busy. Retry shortly."},
                headers={"Retry-After": "5"},
            )
        try:
            return await call_next(request)
        finally:
            CONVERSION_SLOTS.release()

    return await call_next(request)


def safe_name(value, fallback="filegdb"):
    name = Path(str(value or fallback)).name
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return name or fallback


def ensure_filegdb_zip(path):
    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            validate_archive_infos(
                infos,
                max_members=MAX_ZIP_MEMBERS,
                max_uncompressed_bytes=MAX_EXTRACTED_MB * 1024 * 1024,
            )
            names = [info.filename.replace("\\", "/") for info in infos]
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Upload is not a valid ZIP archive.") from exc
    except ArchiveLimitError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    has_gdb_folder = any(
        len(parts := name.split("/")) > 1 and parts[0].lower().endswith(".gdb")
        for name in names
    )
    has_gdb_files = any(name.lower().endswith((".gdbtable", ".gdbtablx")) for name in names)
    if not has_gdb_folder and not has_gdb_files:
        raise HTTPException(status_code=400, detail="ZIP archive does not contain an Esri .gdb folder.")
    return names


def _safe_zip_member_path(root: Path, member_name: str):
    posix = PurePosixPath(member_name.replace("\\", "/"))
    if posix.is_absolute() or any(part in ("", ".", "..") for part in posix.parts):
        raise HTTPException(status_code=400, detail="ZIP archive contains an unsafe path.")

    target = (root / Path(*posix.parts)).resolve()
    root_resolved = root.resolve()
    if target != root_resolved and root_resolved not in target.parents:
        raise HTTPException(status_code=400, detail="ZIP archive contains an unsafe path.")
    return target


def extract_filegdb_zip(path: Path, extract_root: Path):
    ensure_filegdb_zip(path)
    extract_root.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            member_name = info.filename.replace("\\", "/")
            if not member_name or member_name.endswith("/"):
                target_dir = _safe_zip_member_path(extract_root, member_name.rstrip("/"))
                target_dir.mkdir(parents=True, exist_ok=True)
                continue

            target = _safe_zip_member_path(extract_root, member_name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out)

    gdb_dirs = sorted(
        [p for p in extract_root.rglob("*") if p.is_dir() and p.name.lower().endswith(".gdb")],
        key=lambda p: (len(p.parts), str(p).lower()),
    )
    if gdb_dirs:
        return gdb_dirs[0]

    loose_gdb_files = sorted(extract_root.rglob("*.gdbtable"), key=lambda p: str(p).lower())
    if loose_gdb_files:
        return loose_gdb_files[0].parent

    raise HTTPException(status_code=400, detail="ZIP archive does not contain a readable FileGDB directory.")


async def save_upload(upload: UploadFile, target_path: Path):
    total = 0
    with target_path.open("wb") as out:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_MB * 1024 * 1024:
                raise HTTPException(status_code=413, detail=f"FileGDB ZIP exceeds {MAX_UPLOAD_MB} MB limit.")
            out.write(chunk)
    return total


def run_command(args, cwd=None):
    try:
        completed = subprocess.run(
            args,
            cwd=cwd,
            text=True,
            capture_output=True,
            timeout=CONVERT_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="FileGDB conversion timed out.") from exc

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "GDAL command failed.").strip()
        raise HTTPException(status_code=422, detail=detail[-2000:])
    return completed.stdout


def read_ogrinfo_json(source_path):
    stdout = run_command(["ogrinfo", "-json", "-so", str(source_path)])
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail="GDAL did not return readable FileGDB metadata.") from exc


def convert_filegdb_to_gpkg(source_path, output_path):
    run_command([
        "ogr2ogr",
        "-f", "GPKG",
        str(output_path),
        str(source_path),
        "-nlt", "PROMOTE_TO_MULTI",
        "-lco", "SPATIAL_INDEX=YES",
        "-skipfailures",
    ])


def layer_names_from_ogrinfo(ogr_json):
    layers = ogr_json.get("layers") if isinstance(ogr_json, dict) else None
    if not isinstance(layers, list):
        return []
    names = []
    for layer in layers:
        if isinstance(layer, dict):
            name = layer.get("name") or layer.get("layerName")
            if name:
                names.append(str(name))
    return names


def gpkg_feature_summary(gpkg_path: Path):
    conn = sqlite3.connect(gpkg_path)
    try:
        table_rows = conn.execute(
            "SELECT table_name FROM gpkg_contents WHERE data_type = 'features'"
        ).fetchall()
        counts = []
        for (table_name,) in table_rows:
            safe_name = str(table_name).replace('"', '""')
            row_count = conn.execute(f'SELECT COUNT(*) FROM "{safe_name}"').fetchone()[0]
            counts.append({"table": str(table_name), "rows": int(row_count or 0)})
        return counts
    finally:
        conn.close()


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "filegdb-import-worker",
        "authentication": authentication_status(),
    }


@app.post("/convert-filegdb")
async def convert_filegdb(
    request: Request,
    file: UploadFile = File(...),
    project_id: str = Form(""),
    target_layer_id: str = Form(""),
    return_format: str = Form("gpkg"),
    include_domains: str = Form("true"),
):
    if return_format.lower() != "gpkg":
        raise HTTPException(status_code=400, detail="Only return_format=gpkg is supported.")

    temp_root = Path(tempfile.mkdtemp(prefix="mapplex-filegdb-"))
    success_response = False
    try:
        upload_name = safe_name(file.filename, "import.gdb.zip")
        source_path = temp_root / upload_name
        output_path = temp_root / f"mapplex_filegdb_{uuid.uuid4().hex}.gpkg"

        await save_upload(file, source_path)
        ensure_filegdb_zip(source_path)

        source_gdb_path = extract_filegdb_zip(source_path, temp_root / "extract")

        ogr_json = read_ogrinfo_json(source_gdb_path)
        metadata = extract_domain_metadata(ogr_json) if include_domains.lower() == "true" else None

        convert_filegdb_to_gpkg(source_gdb_path, output_path)
        write_mapplex_schema_tables(output_path, metadata)
        attachment_count = promote_esri_attachment_tables(output_path)
        feature_summary = gpkg_feature_summary(output_path)
        feature_count = sum(item["rows"] for item in feature_summary)
        if feature_count == 0:
            layer_names = ", ".join(layer_names_from_ogrinfo(ogr_json)[:12])
            detail = "GDAL converted the FileGDB, but the output GeoPackage contains no feature rows."
            if layer_names:
                detail += f" Layers seen by GDAL: {layer_names}."
            raise HTTPException(status_code=422, detail=detail)

        response_name = Path(upload_name).name
        response_name = re.sub(r"\.gdb\.zip$", "", response_name, flags=re.IGNORECASE) or "filegdb_import"
        response_name = f"{safe_name(response_name, 'filegdb_import')}.gpkg"

        headers = {
            "X-Mapplex-Domain-Count": str(len(metadata.get("domains", [])) if metadata else 0),
            "X-Mapplex-Field-Domain-Count": str(len(metadata.get("field_domains", [])) if metadata else 0),
            "X-Mapplex-Attachment-Count": str(attachment_count),
            "X-Mapplex-Feature-Count": str(feature_count),
            "X-Mapplex-Project-Id": project_id,
            "X-Mapplex-Target-Layer-Id": target_layer_id,
        }
        background = None
        if os.getenv("KEEP_WORKER_TEMP", "").lower() != "true":
            background = BackgroundTask(shutil.rmtree, temp_root, ignore_errors=True)
        success_response = True
        return FileResponse(
            output_path,
            media_type="application/geopackage+sqlite3",
            filename=response_name,
            headers=headers,
            background=background,
        )
    except HTTPException:
        raise
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})
    finally:
        if file:
            await file.close()
        if not success_response and os.getenv("KEEP_WORKER_TEMP", "").lower() != "true":
            shutil.rmtree(temp_root, ignore_errors=True)
