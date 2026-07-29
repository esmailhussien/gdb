import unittest
from types import SimpleNamespace

from archive_limits import ArchiveLimitError, validate_archive_infos


def entry(size=0, *, directory=False, encrypted=False):
    return SimpleNamespace(
        file_size=size,
        flag_bits=0x1 if encrypted else 0,
        is_dir=lambda: directory,
    )


class ArchiveLimitsTests(unittest.TestCase):
    def test_accepts_bounded_archive(self):
        total = validate_archive_infos([entry(directory=True), entry(100), entry(250)], 10, 1000)
        self.assertEqual(total, 350)

    def test_rejects_excess_members(self):
        with self.assertRaisesRegex(ArchiveLimitError, "more than 2 entries"):
            validate_archive_infos([entry(), entry(), entry()], 2, 1000)

    def test_rejects_excess_expanded_bytes(self):
        with self.assertRaisesRegex(ArchiveLimitError, "Expanded FileGDB exceeds"):
            validate_archive_infos([entry(700), entry(400)], 10, 1000)

    def test_rejects_encrypted_entries(self):
        with self.assertRaisesRegex(ArchiveLimitError, "Encrypted ZIP entries"):
            validate_archive_infos([entry(10, encrypted=True)], 10, 1000)


if __name__ == "__main__":
    unittest.main()

