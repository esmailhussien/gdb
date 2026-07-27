import sqlite3
import tempfile
import unittest
from pathlib import Path

from mapplex_schema import extract_domain_metadata, write_mapplex_schema_tables


class MapplexSchemaTests(unittest.TestCase):
    def test_extracts_coded_domains_and_field_bindings(self):
        ogr_json = {
            "domains": {
                "PavedDomain": {
                    "description": "Pavement surface",
                    "type": "coded",
                    "fieldType": "String",
                    "codedValues": {
                        "ASP": "Asphalt",
                        "CON": "Concrete",
                    },
                }
            },
            "layers": [
                {
                    "name": "Roads",
                    "fields": [
                        {"name": "PAVED", "type": "String", "domainName": "PavedDomain"},
                        {"name": "NAME", "type": "String"},
                    ],
                }
            ],
        }

        metadata = extract_domain_metadata(ogr_json)

        self.assertIsNotNone(metadata)
        self.assertEqual(metadata["format"], "mapplex_schema")
        self.assertEqual(len(metadata["domains"]), 1)
        self.assertEqual(metadata["domains"][0]["domain_name"], "PavedDomain")
        self.assertEqual(metadata["domains"][0]["values"][1]["code"], "CON")
        self.assertEqual(metadata["domains"][0]["values"][1]["description"], "Concrete")
        self.assertEqual(len(metadata["field_domains"]), 1)
        self.assertEqual(metadata["field_domains"][0]["layer_name"], "Roads")
        self.assertEqual(metadata["field_domains"][0]["field_name"], "PAVED")
        self.assertEqual(metadata["field_domains"][0]["gpkg_column_name"], "PAVED")

    def test_accepts_list_domain_shape_and_nested_field_domain_reference(self):
        ogr_json = {
            "fieldDomains": [
                {
                    "name": "ConditionDomain",
                    "description": "Condition",
                    "type": "coded",
                    "values": [
                        {"code": 1, "label": "Good"},
                        {"code": 2, "label": "Needs repair"},
                    ],
                }
            ],
            "layers": [
                {
                    "name": "Assets",
                    "fields": [
                        {"fieldName": "CONDITION", "fieldDomain": {"name": "ConditionDomain"}},
                    ],
                }
            ],
        }

        metadata = extract_domain_metadata(ogr_json)

        self.assertIsNotNone(metadata)
        self.assertEqual(metadata["domains"][0]["values"][0]["code"], "1")
        self.assertEqual(metadata["domains"][0]["values"][0]["description"], "Good")
        self.assertEqual(metadata["field_domains"][0]["domain_name"], "ConditionDomain")

    def test_returns_none_without_field_bindings(self):
        metadata = extract_domain_metadata({
            "domains": {
                "LonelyDomain": {
                    "type": "coded",
                    "codedValues": {"A": "Alpha"},
                }
            },
            "layers": [{"name": "NoBindings", "fields": [{"name": "NAME"}]}],
        })

        self.assertIsNone(metadata)

    def test_writes_mapplex_schema_tables(self):
        metadata = extract_domain_metadata({
            "domains": {
                "PavedDomain": {
                    "description": "Pavement surface",
                    "type": "coded",
                    "codedValues": {"ASP": "Asphalt", "CON": "Concrete"},
                }
            },
            "layers": [
                {"name": "Roads", "fields": [{"name": "PAVED", "domainName": "PavedDomain"}]},
            ],
        })

        with tempfile.TemporaryDirectory() as temp_dir:
            gpkg_path = Path(temp_dir) / "test.gpkg"
            sqlite3.connect(gpkg_path).close()

            write_mapplex_schema_tables(gpkg_path, metadata)

            conn = sqlite3.connect(gpkg_path)
            try:
                domain_count = conn.execute("SELECT COUNT(*) FROM mapplex_domains").fetchone()[0]
                value_count = conn.execute("SELECT COUNT(*) FROM mapplex_domain_values").fetchone()[0]
                binding = conn.execute(
                    "SELECT layer_name, field_name, domain_name FROM mapplex_field_domains"
                ).fetchone()
            finally:
                conn.close()

            self.assertEqual(domain_count, 1)
            self.assertEqual(value_count, 2)
            self.assertEqual(binding, ("Roads", "PAVED", "PavedDomain"))


if __name__ == "__main__":
    unittest.main()
