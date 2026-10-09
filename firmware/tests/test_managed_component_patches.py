"""Host-only regression: python3 firmware/tests/test_managed_component_patches.py."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HELPER = Path(__file__).resolve().parents[1] / "cmake/apply_managed_component_patch.cmake"
PATCH = """diff --git a/source.txt b/source.txt
--- a/source.txt
+++ b/source.txt
@@ -1 +1 @@
-before
+after
"""


class ManagedComponentPatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="stackchan-managed-patch-test-")
        self.root = Path(self.temp.name).resolve()
        # Spaces exercise CMake argv quoting as well as the ignored nested repo.
        self.repo = self.root / "outer repository"
        self.component = self.repo / "managed_components" / "example component"
        self.component.mkdir(parents=True)
        self.env = os.environ.copy()
        self.env["LC_ALL"] = "C"
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES"):
            self.env.pop(key, None)
        subprocess.run(["git", "init", "--quiet", str(self.repo)], check=True, env=self.env)
        (self.repo / ".gitignore").write_text("managed_components/\n", encoding="utf-8")
        (self.component / "CMakeLists.txt").write_text("# fixture\n", encoding="utf-8")
        self.source = self.component / "source.txt"
        self.source.write_text("before\n", encoding="utf-8")
        self.patch = self.root / "example.patch"
        self.patch.write_text(PATCH, encoding="utf-8")
        self.script = self.root / "apply.cmake"
        self.script.write_text(
            f'cmake_minimum_required(VERSION 3.16)\ninclude("{HELPER.as_posix()}")\n'
            f'stackchan_apply_managed_component_patch("{self.component.as_posix()}" '
            f'"{self.patch.as_posix()}" "fixture")\n',
            encoding="utf-8",
        )

    def tearDown(self):
        # Only remove our verified private test fixture, never a repository path.
        assert self.root == Path(self.temp.name).resolve()
        assert self.root.parent == Path(tempfile.gettempdir()).resolve()
        assert self.root.name.startswith("stackchan-managed-patch-test-")
        self.temp.cleanup()

    def run_helper(self, env=None):
        return subprocess.run(
            ["cmake", "-P", str(self.script)], cwd=self.component,
            env=env or self.env, capture_output=True, text=True,
        )

    def test_reproduces_old_false_success_and_really_applies(self):
        old_check = subprocess.run(
            ["git", "apply", "--verbose", "--check", str(self.patch)],
            cwd=self.component, env=self.env, capture_output=True, text=True,
        )
        self.assertEqual(old_check.returncode, 0)
        self.assertIn("Skipped patch", old_check.stderr)
        self.assertEqual(self.source.read_text(), "before\n")
        fixed = self.run_helper()
        self.assertEqual(fixed.returncode, 0, fixed.stdout + fixed.stderr)
        self.assertIn("Applied fixture patch", fixed.stdout)
        self.assertEqual(self.source.read_text(), "after\n")
        repeated = self.run_helper()
        self.assertEqual(repeated.returncode, 0, repeated.stdout + repeated.stderr)
        self.assertIn("already applied", repeated.stdout)
        self.assertEqual(self.source.read_text(), "after\n")
        isolated = self.env | {"GIT_CEILING_DIRECTORIES": str(self.component.parent)}
        forward = subprocess.run(
            ["git", "apply", "--check", str(self.patch)], cwd=self.component,
            env=isolated, capture_output=True,
        )
        reverse = subprocess.run(
            ["git", "apply", "--reverse", "--check", str(self.patch)],
            cwd=self.component, env=isolated, capture_output=True,
        )
        self.assertNotEqual(forward.returncode, 0)
        self.assertEqual(reverse.returncode, 0)

    def test_divergent_local_source_fails_without_overwrite(self):
        self.source.write_text("local enhancement\n", encoding="utf-8")
        result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("patch cannot be applied or verified", result.stderr)
        self.assertEqual(self.source.read_text(), "local enhancement\n")

    def test_inherited_git_directory_cannot_restore_outer_repo_skip(self):
        env = self.env | {"GIT_DIR": str(self.repo / ".git"), "GIT_WORK_TREE": str(self.repo)}
        result = self.run_helper(env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.source.read_text(), "after\n")


if __name__ == "__main__":
    unittest.main()
