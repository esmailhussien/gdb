"""Pre-extraction limits for untrusted FileGDB ZIP uploads."""


class ArchiveLimitError(ValueError):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def validate_archive_infos(infos, max_members, max_uncompressed_bytes):
    entries = list(infos)
    if len(entries) > max_members:
        raise ArchiveLimitError(413, f"ZIP archive contains more than {max_members} entries.")

    total_uncompressed = 0
    for info in entries:
        if getattr(info, "flag_bits", 0) & 0x1:
            raise ArchiveLimitError(400, "Encrypted ZIP entries are not supported.")

        if not getattr(info, "is_dir", lambda: False)():
            size = max(0, int(getattr(info, "file_size", 0) or 0))
            total_uncompressed += size
            if total_uncompressed > max_uncompressed_bytes:
                limit_mb = max_uncompressed_bytes // (1024 * 1024)
                raise ArchiveLimitError(413, f"Expanded FileGDB exceeds the {limit_mb} MB limit.")

    return total_uncompressed

