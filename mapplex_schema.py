import sqlite3
from datetime import datetime, timezone


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def coded_values_from_domain(domain):
    coded = domain.get("codedValues") or domain.get("coded_values") or domain.get("values") or {}
    if isinstance(coded, dict):
        return [
            {
                "code": str(code),
                "description": str(description if description is not None else code),
                "sort_order": index + 1,
            }
            for index, (code, description) in enumerate(coded.items())
        ]
    if isinstance(coded, list):
        values = []
        for index, item in enumerate(coded):
            if isinstance(item, dict):
                code = item.get("code", item.get("value", item.get("id", index + 1)))
                label = item.get("description", item.get("label", item.get("name", code)))
            else:
                code = item
                label = item
            values.append({"code": str(code), "description": str(label), "sort_order": index + 1})
        return values
    return []


def extract_domain_metadata(ogr_json):
    raw_domains = ogr_json.get("domains") or ogr_json.get("fieldDomains") or {}
    domains = []

    if isinstance(raw_domains, dict):
        iterator = raw_domains.items()
    elif isinstance(raw_domains, list):
        iterator = ((item.get("name") or item.get("domainName"), item) for item in raw_domains if isinstance(item, dict))
    else:
        iterator = []

    for name, domain in iterator:
        if not name or not isinstance(domain, dict):
            continue
        if str(domain.get("type", "coded")).lower() not in {"coded", "enum", "codedvalue"}:
            continue
        values = coded_values_from_domain(domain)
        if not values:
            continue
        domains.append({
            "lexicon_id": None,
            "domain_name": str(name),
            "lexicon_name": str(domain.get("description") or name),
            "description": str(domain.get("description") or ""),
            "industry_standard": "Imported Esri File Geodatabase domain",
            "allow_other": False,
            "default_value": None,
            "version": 1,
            "values": values,
        })

    domain_names = {domain["domain_name"] for domain in domains}
    field_domains = []
    for layer in ogr_json.get("layers", []) or []:
        if not isinstance(layer, dict):
            continue
        layer_name = str(layer.get("name") or "")
        for field in layer.get("fields", []) or []:
            if not isinstance(field, dict):
                continue
            domain_name = (
                field.get("domainName")
                or field.get("domain_name")
                or field.get("domain")
                or field.get("fieldDomain")
            )
            if isinstance(domain_name, dict):
                domain_name = domain_name.get("name") or domain_name.get("domainName")
            if not domain_name or str(domain_name) not in domain_names:
                continue
            field_name = str(field.get("name") or field.get("fieldName") or "")
            if not field_name:
                continue
            field_domains.append({
                "layer_name": layer_name,
                "field_name": field_name,
                "field_id": field_name,
                "field_type": "select",
                "domain_name": str(domain_name),
                "lexicon_id": None,
                "gpkg_table_name": layer_name,
                "gpkg_column_name": field_name,
            })

    if not domains or not field_domains:
        return None

    return {
        "format": "mapplex_schema",
        "schema_version": 1,
        "imported_at": utc_now(),
        "domains": domains,
        "field_domains": field_domains,
    }


def write_mapplex_schema_tables(gpkg_path, metadata):
    if not metadata:
        return

    conn = sqlite3.connect(gpkg_path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS mapplex_domains (
                domain_name TEXT PRIMARY KEY,
                lexicon_id TEXT,
                lexicon_name TEXT,
                description TEXT,
                industry_standard TEXT,
                allow_other INTEGER DEFAULT 0,
                default_value TEXT,
                version INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS mapplex_domain_values (
                domain_name TEXT,
                code TEXT,
                description TEXT,
                mapplex_code TEXT,
                value_id TEXT,
                sort_order INTEGER,
                color TEXT,
                parent_group TEXT,
                PRIMARY KEY (domain_name, code)
            );
            CREATE TABLE IF NOT EXISTS mapplex_field_domains (
                layer_name TEXT,
                field_name TEXT,
                field_id TEXT,
                field_type TEXT,
                domain_name TEXT,
                lexicon_id TEXT,
                gpkg_table_name TEXT,
                gpkg_column_name TEXT,
                PRIMARY KEY (layer_name, field_id, domain_name)
            );
            """
        )

        for domain in metadata.get("domains", []):
            conn.execute(
                """
                INSERT OR REPLACE INTO mapplex_domains
                (domain_name, lexicon_id, lexicon_name, description, industry_standard, allow_other, default_value, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    domain.get("domain_name"),
                    domain.get("lexicon_id"),
                    domain.get("lexicon_name"),
                    domain.get("description"),
                    domain.get("industry_standard"),
                    1 if domain.get("allow_other") else 0,
                    domain.get("default_value"),
                    int(domain.get("version") or 1),
                ),
            )
            for value in domain.get("values", []):
                conn.execute(
                    """
                    INSERT OR REPLACE INTO mapplex_domain_values
                    (domain_name, code, description, mapplex_code, value_id, sort_order, color, parent_group)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        domain.get("domain_name"),
                        value.get("code"),
                        value.get("description"),
                        value.get("mapplex_code"),
                        value.get("value_id"),
                        int(value.get("sort_order") or 0),
                        value.get("color"),
                        value.get("parent_group"),
                    ),
                )

        for binding in metadata.get("field_domains", []):
            conn.execute(
                """
                INSERT OR REPLACE INTO mapplex_field_domains
                (layer_name, field_name, field_id, field_type, domain_name, lexicon_id, gpkg_table_name, gpkg_column_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    binding.get("layer_name"),
                    binding.get("field_name"),
                    binding.get("field_id"),
                    binding.get("field_type") or "select",
                    binding.get("domain_name"),
                    binding.get("lexicon_id"),
                    binding.get("gpkg_table_name"),
                    binding.get("gpkg_column_name"),
                ),
            )

        conn.commit()
    finally:
        conn.close()
