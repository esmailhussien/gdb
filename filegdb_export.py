import sqlite3
import zipfile
from pathlib import Path


SQLITE_MAGIC = b"SQLite format 3\x00"


class GeoPackageExportError(ValueError):
    pass


def inspect_export_geopackage(gpkg_path: Path):
    path = Path(gpkg_path)
    try:
        with path.open("rb") as handle:
            if handle.read(len(SQLITE_MAGIC)) != SQLITE_MAGIC:
                raise GeoPackageExportError("Upload is not a SQLite GeoPackage file.")
    except OSError as exc:
        raise GeoPackageExportError("Uploaded GeoPackage could not be read.") from exc

    try:
        conn = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
        try:
            rows = conn.execute(
                "SELECT table_name FROM gpkg_contents WHERE data_type = 'features' ORDER BY table_name"
            ).fetchall()
            if not rows:
                raise GeoPackageExportError("GeoPackage does not contain any feature layers.")

            summary = []
            for (table_name,) in rows:
                name = str(table_name or "")
                if not name or len(name) > 512 or any(ord(char) < 32 for char in name):
                    raise GeoPackageExportError("GeoPackage contains an invalid feature table name.")
                quoted = name.replace('"', '""')
                count = int(conn.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0] or 0)
                summary.append({"table": name, "rows": count})
        finally:
            conn.close()
    except GeoPackageExportError:
        raise
    except sqlite3.Error as exc:
        raise GeoPackageExportError("Upload is not a readable GeoPackage database.") from exc

    if sum(item["rows"] for item in summary) == 0:
        raise GeoPackageExportError("GeoPackage feature layers contain no rows.")
    return summary


def create_filegdb_zip(gdb_path: Path, output_zip: Path):
    source = Path(gdb_path)
    target = Path(output_zip)
    if not source.is_dir() or not source.name.lower().endswith(".gdb"):
        raise GeoPackageExportError("GDAL did not create a FileGDB directory.")

    files = sorted(
        (path for path in source.rglob("*") if path.is_file() and not path.is_symlink()),
        key=lambda path: str(path).lower(),
    )
    if not files or not any(path.suffix.lower() in (".gdbtable", ".gdbtablx") for path in files):
        raise GeoPackageExportError("GDAL FileGDB output is incomplete.")

    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        archive.writestr(f"{source.name}/", b"")
        for path in files:
            archive.write(path, arcname=(Path(source.name) / path.relative_to(source)).as_posix())
    return target
