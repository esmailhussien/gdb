import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

from filegdb_export import GeoPackageExportError, create_filegdb_zip, inspect_export_geopackage


def create_gpkg(path: Path, rows=1):
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT)")
        conn.execute("CREATE TABLE assets (fid INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("INSERT INTO gpkg_contents VALUES ('assets', 'features')")
        for index in range(rows):
            conn.execute("INSERT INTO assets (name) VALUES (?)", (f"asset-{index}",))
        conn.commit()
    finally:
        conn.close()


class FileGdbExportTests(unittest.TestCase):
    def test_inspects_feature_tables_and_rows(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "project.gpkg"
            create_gpkg(path, rows=2)
            self.assertEqual(inspect_export_geopackage(path), [{"table": "assets", "rows": 2}])

    def test_rejects_non_sqlite_and_empty_feature_packages(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            invalid = root / "invalid.gpkg"
            invalid.write_bytes(b"not sqlite")
            with self.assertRaisesRegex(GeoPackageExportError, "not a SQLite"):
                inspect_export_geopackage(invalid)

            empty = root / "empty.gpkg"
            create_gpkg(empty, rows=0)
            with self.assertRaisesRegex(GeoPackageExportError, "contain no rows"):
                inspect_export_geopackage(empty)

    def test_zips_filegdb_with_the_gdb_directory_as_archive_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            gdb = root / "field_project.gdb"
            gdb.mkdir()
            (gdb / "a00000001.gdbtable").write_bytes(b"table")
            (gdb / "a00000001.gdbtablx").write_bytes(b"index")
            output = create_filegdb_zip(gdb, root / "field_project.gdb.zip")

            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), [
                    "field_project.gdb/",
                    "field_project.gdb/a00000001.gdbtable",
                    "field_project.gdb/a00000001.gdbtablx",
                ])


if __name__ == "__main__":
    unittest.main()
