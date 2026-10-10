"""Verify the shipped patch against an isolated pinned source archive, without fetch/reset."""
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

FIRMWARE = Path(__file__).resolve().parents[1]
SOURCE = FIRMWARE / "xiaozhi-esp32"
PATCH = FIRMWARE / "patches/xiaozhi-esp32.patch"
EXTRA_FILES = ("main/runtime_safety.h", "main/websocket_endpoint.h", "main/websocket_endpoint_policy.h")


class XiaozhiPatchTest(unittest.TestCase):
    def test_clean_apply_reverse_and_matches_generated_source(self):
        env = os.environ.copy()
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_INDEX_FILE"):
            env.pop(key, None)

        def git(root, *args, check=True):
            result = subprocess.run(["git", "-C", str(root), *args], env=env, capture_output=True)
            if check:
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            return result

        self.assertEqual(git(SOURCE, "rev-parse", "HEAD").stdout, git(SOURCE, "rev-parse", "v2.2.4^{commit}").stdout)
        data = git(SOURCE, "archive", "v2.2.4").stdout
        changed = git(SOURCE, "diff", "--name-only", "v2.2.4", "--").stdout.decode().splitlines()
        with tempfile.TemporaryDirectory(prefix="stackchan-xiaozhi-patch-test-") as directory:
            root = Path(directory).resolve()
            # Verify the private fixture before cleanup or patch operations.
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith("stackchan-xiaozhi-patch-test-"))
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                for member in archive.getmembers():
                    self.assertTrue((root / member.name).resolve().is_relative_to(root))
                    self.assertFalse(member.issym() or member.islnk())
                if hasattr(tarfile, "data_filter"):
                    archive.extractall(root, filter="data")
                else:
                    archive.extractall(root)
            git(root, "init", "--quiet")
            git(root, "apply", "--check", str(PATCH))
            git(root, "apply", str(PATCH))
            git(root, "apply", "--reverse", "--check", str(PATCH))
            self.assertNotEqual(git(root, "apply", "--check", str(PATCH), check=False).returncode, 0)
            for name in (*changed, *EXTRA_FILES):
                self.assertEqual((root / name).read_bytes(), (SOURCE / name).read_bytes(), name)
            git(root, "apply", "--reverse", str(PATCH))
            git(root, "apply", "--check", str(PATCH))
            for name in EXTRA_FILES:
                self.assertFalse((root / name).exists())
            git(root, "apply", str(PATCH))
            for name in EXTRA_FILES:
                self.assertEqual((root / name).read_bytes(), (SOURCE / name).read_bytes(), name)
            print(f"Pinned v2.2.4 patch round-trip matches {len(changed) + len(EXTRA_FILES)} generated files")


if __name__ == "__main__":
    unittest.main()
