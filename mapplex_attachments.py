import re
import sqlite3


GPKG_RELATED_TABLES_EXTENSION = "gpkg_related_tables"
GPKG_RELATED_TABLES_DEFINITION = "http://docs.opengeospatial.org/is/18-000/18-000.html"
MEDIA_TABLE_NAME = "mapplex_media"
DEFAULT_FIELD_NAME = "attachments"
DEFAULT_FIELD_LABEL = "Attachments"


def _quote_ident(value):
    return '"' + str(value or "").replace('"', '""') + '"'


def _safe_name_part(value, fallback="features"):
    safe = re.sub(r"[^A-Za-z0-9_]+", "_", str(value or fallback)).strip("_")[:80]
    return safe or fallback


def _table_exists(conn, table_name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (table_name,),
    ).fetchone() is not None


def _columns(conn, table_name):
    rows = conn.execute(f"PRAGMA table_info({_quote_ident(table_name)})").fetchall()
    return [str(row[1]) for row in rows]


def _pick_column(columns, candidates):
    by_lower = {col.lower(): col for col in columns}
    for candidate in candidates:
        found = by_lower.get(candidate.lower())
        if found:
            return found
    return None


def _normalize_name(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _strip_attachment_suffix(table_name):
    return re.sub(r"(__attachrel|_attachrel|__attach|_attach|attachments?)$", "", str(table_name), flags=re.I)


def _feature_tables(conn):
    try:
        rows = conn.execute(
            "SELECT table_name FROM gpkg_contents WHERE data_type='features'"
        ).fetchall()
        return [str(row[0]) for row in rows]
    except sqlite3.Error:
        return []


def _attachment_tables(conn):
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    candidates = []
    for (table_name,) in rows:
        table_name = str(table_name)
        lower = table_name.lower()
        if lower.startswith(("gpkg_", "sqlite_", "rtree_")):
            continue
        columns = _columns(conn, table_name)
        lower_columns = {col.lower() for col in columns}
        if "rel_objectid" in lower_columns and "data" in lower_columns:
            candidates.append(table_name)
    return candidates


def _find_base_table(attachment_table, feature_tables):
    root = _normalize_name(_strip_attachment_suffix(attachment_table))
    if not root:
        return None

    scored = []
    for table_name in feature_tables:
        normalized = _normalize_name(table_name)
        if normalized == root:
            return table_name
        if root.endswith(normalized) or normalized.endswith(root):
            scored.append((abs(len(root) - len(normalized)), table_name))
    if scored:
        return sorted(scored)[0][1]
    return None


def _base_primary_column(conn, base_table):
    columns = _columns(conn, base_table)
    return _pick_column(columns, ["objectid", "object_id", "objectid_1", "fid", "id"]) or "fid"


def _unique_mapping_table(conn, base_table):
    stem = f"mapplex_media_{_safe_name_part(base_table)}"[:110]
    table_name = stem
    suffix = 2
    while _table_exists(conn, table_name):
        table_name = f"{stem}_{suffix}"[:120]
        suffix += 1
    return table_name


def _ensure_related_tables_core(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS gpkg_extensions (
            table_name TEXT,
            column_name TEXT,
            extension_name TEXT NOT NULL,
            definition TEXT NOT NULL,
            scope TEXT NOT NULL,
            CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name)
        )
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO gpkg_extensions
            (table_name, column_name, extension_name, definition, scope)
        VALUES ('gpkgext_relations', NULL, ?, ?, 'read-write')
        """,
        (GPKG_RELATED_TABLES_EXTENSION, GPKG_RELATED_TABLES_DEFINITION),
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS gpkgext_relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            base_table_name TEXT NOT NULL,
            base_primary_column TEXT NOT NULL,
            related_table_name TEXT NOT NULL,
            related_primary_column TEXT NOT NULL,
            relation_name TEXT NOT NULL,
            mapping_table_name TEXT NOT NULL UNIQUE
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {_quote_ident(MEDIA_TABLE_NAME)} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            data BLOB NOT NULL,
            content_type TEXT NOT NULL,
            filename TEXT,
            field_name TEXT,
            field_label TEXT,
            field_type TEXT,
            title TEXT,
            description TEXT
        )
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO gpkg_contents
            (table_name, data_type, identifier, description, srs_id)
        VALUES (?, 'attributes', ?, ?, NULL)
        """,
        (MEDIA_TABLE_NAME, "Mapplex Media", "Media attachments related to feature rows"),
    )


def _select_attachment_rows(conn, attachment_table):
    columns = _columns(conn, attachment_table)
    rel_col = _pick_column(columns, ["rel_objectid"])
    data_col = _pick_column(columns, ["data"])
    content_col = _pick_column(columns, ["content_type", "contenttype", "mime_type", "mimetype"])
    filename_col = _pick_column(columns, ["att_name", "name", "filename", "file_name"])
    attachment_id_col = _pick_column(columns, ["attachmentid", "attach_id", "id", "fid"])

    if not rel_col or not data_col:
        return []

    content_sql = f"{_quote_ident(content_col)}" if content_col else "'application/octet-stream'"
    filename_sql = f"{_quote_ident(filename_col)}" if filename_col else "''"
    attachment_id_sql = f"{_quote_ident(attachment_id_col)}" if attachment_id_col else "NULL"
    return conn.execute(
        f"""
        SELECT
            {_quote_ident(rel_col)} AS rel_objectid,
            {_quote_ident(data_col)} AS data,
            {content_sql} AS content_type,
            {filename_sql} AS filename,
            {attachment_id_sql} AS attachment_id
        FROM {_quote_ident(attachment_table)}
        WHERE {_quote_ident(data_col)} IS NOT NULL
        """
    ).fetchall()


def promote_esri_attachment_tables(gpkg_path):
    """Promote copied Esri FileGDB __ATTACH tables into GPKG related media rows."""
    with sqlite3.connect(gpkg_path) as conn:
        feature_tables = _feature_tables(conn)
        if not feature_tables:
            return 0

        attachment_tables = _attachment_tables(conn)
        if not attachment_tables:
            return 0

        promoted_count = 0
        per_feature_sort = {}

        for attachment_table in attachment_tables:
            base_table = _find_base_table(attachment_table, feature_tables)
            if not base_table:
                continue

            rows = _select_attachment_rows(conn, attachment_table)
            if not rows:
                continue

            _ensure_related_tables_core(conn)
            mapping_table = _unique_mapping_table(conn, base_table)
            base_primary_column = _base_primary_column(conn, base_table)

            conn.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {_quote_ident(mapping_table)} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    base_id INTEGER NOT NULL,
                    related_id INTEGER NOT NULL,
                    field_name TEXT,
                    field_label TEXT,
                    field_type TEXT,
                    sort_order INTEGER DEFAULT 0,
                    filename TEXT
                )
                """
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO gpkg_extensions
                    (table_name, column_name, extension_name, definition, scope)
                VALUES (?, NULL, ?, ?, 'read-write')
                """,
                (mapping_table, GPKG_RELATED_TABLES_EXTENSION, GPKG_RELATED_TABLES_DEFINITION),
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO gpkgext_relations
                    (base_table_name, base_primary_column, related_table_name, related_primary_column, relation_name, mapping_table_name)
                VALUES (?, ?, ?, 'id', 'media', ?)
                """,
                (base_table, base_primary_column, MEDIA_TABLE_NAME, mapping_table),
            )

            for rel_objectid, data, content_type, filename, attachment_id in rows:
                if data is None:
                    continue
                content_type = str(content_type or "application/octet-stream")
                filename = str(filename or f"{_safe_name_part(base_table)}_{rel_objectid}_{attachment_id or promoted_count + 1}")
                field_type = "gallery" if content_type.lower().startswith("image/") else "attachment"

                media_cursor = conn.execute(
                    f"""
                    INSERT INTO {_quote_ident(MEDIA_TABLE_NAME)}
                        (data, content_type, filename, field_name, field_label, field_type, title, description)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        sqlite3.Binary(bytes(data)),
                        content_type,
                        filename,
                        DEFAULT_FIELD_NAME,
                        DEFAULT_FIELD_LABEL,
                        field_type,
                        filename,
                        f"Imported from {attachment_table}",
                    ),
                )
                related_id = media_cursor.lastrowid
                sort_key = (base_table, str(rel_objectid))
                sort_order = per_feature_sort.get(sort_key, 0)
                per_feature_sort[sort_key] = sort_order + 1

                conn.execute(
                    f"""
                    INSERT INTO {_quote_ident(mapping_table)}
                        (base_id, related_id, field_name, field_label, field_type, sort_order, filename)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rel_objectid,
                        related_id,
                        DEFAULT_FIELD_NAME,
                        DEFAULT_FIELD_LABEL,
                        field_type,
                        sort_order,
                        filename,
                    ),
                )
                promoted_count += 1

        return promoted_count
