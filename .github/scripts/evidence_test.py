import copy
import io
import os
from unittest import TestCase, mock
import zipfile

import evidence


class PublishingGuards(TestCase):
    def setUp(self):
        self.pr = {"state": "open", "base": {"repo": {"full_name": evidence.REPOSITORY}},
                   "head": {"repo": {"full_name": "contributor/vi"}, "ref": "feature",
                            "sha": "a" * 40}}
        self.run = {"id": 42, "repository": {"full_name": evidence.REPOSITORY},
                    "head_repository": {"full_name": "contributor/vi"}, "head_branch": "feature",
                    "head_sha": "a" * 40, "event": "pull_request", "workflow_id": 7,
                    "path": ".github/workflows/ci.yml", "status": "completed", "conclusion": "success"}
        self.jobs = [{"name": f"{check} ({platform}, {arch})", "status": "completed",
                      "conclusion": "success", "started_at": "2026-01-01T00:00:00Z",
                      "completed_at": "2026-01-01T00:03:00Z"}
                     for platform, (_, arch) in evidence.PLATFORMS.items()
                     for check in ("unit", "smoke", "ui")]

    def validate(self):
        return evidence.validate_source(self.pr, self.run, self.jobs, 7)

    def test_successful_fork_source(self):
        self.assertEqual(len(self.validate()), 9)

    def test_rejects_wrong_source(self):
        for key, value in {"head_sha": "b" * 40, "workflow_id": 8, "event": "push",
                           "path": ".github/workflows/other.yml", "head_branch": "wrong",
                           "status": "in_progress", "conclusion": "failure"}.items():
            with self.subTest(key=key):
                original = self.run[key]
                self.run[key] = value
                with self.assertRaises(ValueError):
                    self.validate()
                self.run[key] = original
        self.pr["state"] = "closed"
        with self.assertRaises(ValueError):
            self.validate()

    def test_rejects_wrong_repository(self):
        for item in (self.run["repository"], self.run["head_repository"], self.pr["base"]["repo"]):
            original = item["full_name"]
            item["full_name"] = "other/repository"
            with self.assertRaises(ValueError):
                self.validate()
            item["full_name"] = original

    def test_requires_every_successful_job(self):
        for mutation in ("missing", "duplicate", "failure", "active"):
            jobs = copy.deepcopy(self.jobs)
            if mutation == "missing":
                jobs.pop()
            elif mutation == "duplicate":
                jobs.append(jobs[0])
            elif mutation == "failure":
                jobs[0]["conclusion"] = "failure"
            else:
                jobs[0]["status"] = "in_progress"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                evidence.validate_source(self.pr, self.run, jobs, 7)

    def test_exact_whole_job_thresholds(self):
        for check, boundary in (("unit", "00:03:00"), ("smoke", "00:03:00"), ("ui", "00:10:00")):
            job = next(job for job in self.jobs if job["name"].startswith(check + " "))
            job["completed_at"] = f"2026-01-01T{boundary}Z"
            self.validate()
            job["completed_at"] = f"2026-01-01T{boundary[:-2]}01Z"
            with self.assertRaises(ValueError):
                self.validate()
            job["completed_at"] = "2026-01-01T00:03:00Z"

    def test_active_preview_only_for_own_run(self):
        self.run.update(status="in_progress", conclusion=None)
        with mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "42"}):
            evidence.validate_source(self.pr, self.run, self.jobs, 7, allow_active=True)
            with self.assertRaises(ValueError):
                self.validate()
        with mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "43"}), self.assertRaises(ValueError):
            evidence.validate_source(self.pr, self.run, self.jobs, 7, allow_active=True)

    def test_preserves_pr_body_and_closing_links(self):
        original = "Closes #123\n\nOriginal description.\n"
        block = evidence.START + "\nNew evidence\n" + evidence.END
        updated = evidence.replace_evidence(original, block)
        self.assertTrue(updated.startswith(original))
        second = evidence.START + "\nReplacement\n" + evidence.END
        self.assertEqual(evidence.replace_evidence(updated + "\nReviewer notes", second),
                         original + "\n\n" + second + "\nReviewer notes")

    def test_rejects_ambiguous_markers(self):
        for body in (evidence.START, evidence.END, evidence.END + evidence.START,
                     (evidence.START + evidence.END) * 2):
            with self.subTest(body=body), self.assertRaises(ValueError):
                evidence.replace_evidence(body, evidence.START + evidence.END)

    def test_ids_are_not_shell_or_path_inputs(self):
        self.assertEqual(evidence.positive_id("42"), 42)
        for value in ("", "0", "-1", "01", "42; echo bad", "../42", "1.2", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                evidence.positive_id(value)

    def archive(self, extra=None, omit=None):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for suite in evidence.SUITES:
                for name in ("desktop.webm", "desktop.png", "report.json"):
                    full = f"{suite}/{name}"
                    if full != omit:
                        archive.writestr(full, b"fixture")
            if extra:
                archive.writestr(*extra)
        return buffer.getvalue()

    def test_allowlisted_archive_only(self):
        self.assertEqual(len(evidence.unpack_media(self.archive())), 6)
        for name in ("../escape.py", "/absolute", "ui\\desktop.webm", "ui/helper.py",
                     "ui/desktop.webm"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                evidence.unpack_media(self.archive((name, b"untrusted")))

    def test_rejects_missing_empty_and_symlink_media(self):
        with self.assertRaises(ValueError):
            evidence.unpack_media(self.archive(omit="framework-ui/desktop.webm"))
        with self.assertRaises(ValueError):
            evidence.unpack_media(self.archive(("ui/desktop.webm", b""), omit="ui/desktop.webm"))
        link = zipfile.ZipInfo("ui/desktop.webm")
        link.external_attr = 0o120777 << 16
        with self.assertRaises(ValueError):
            evidence.unpack_media(self.archive((link, b"target"), omit="ui/desktop.webm"))

    def test_markdown_contains_all_real_media_links(self):
        manifest = {"head": "a" * 40, "run": 42, "attempt": 1}
        names = [f"{platform}-{suite}.{extension}" for platform in evidence.PLATFORMS
                 for suite in evidence.SUITES for extension in ("gif", "png", "webm")]
        urls = {name: f"https://github.com/{evidence.REPOSITORY}/releases/download/evidence/{name}"
                for name in names + ["report.json"]}
        body = evidence.evidence_body(manifest, urls)
        self.assertEqual(body.count("![CI preview]("), 6)
        for url in urls.values():
            self.assertIn(url, body)
