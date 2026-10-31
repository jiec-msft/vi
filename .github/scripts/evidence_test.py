import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import urllib.error
from unittest import TestCase, mock
import zipfile

import evidence


class PublishingGuards(TestCase):
    def setUp(self):
        self.pr = {"number": 6, "id": 606,
                   "url": f"https://api.github.com/repos/{evidence.REPOSITORY}/pulls/6",
                   "state": "open", "base": {"ref": "main", "sha": "b" * 40,
                     "repo": {"full_name": evidence.REPOSITORY, "id": 1,
                              "url": f"https://api.github.com/repos/{evidence.REPOSITORY}"}},
                   "head": {"repo": {"full_name": "contributor/vi", "id": 2,
                                    "url": "https://api.github.com/repos/contributor/vi"},
                            "ref": "feature", "sha": "a" * 40}}
        self.run = {"id": 42, "repository": {"full_name": evidence.REPOSITORY},
                    "head_repository": {"full_name": "contributor/vi"}, "head_branch": "feature",
                    "head_sha": "a" * 40, "event": "pull_request", "workflow_id": 7,
                    "path": ".github/workflows/ci.yml", "status": "completed", "conclusion": "success"}
        association = {key: self.pr[key] for key in ("number", "id", "url")}
        for side in ("base", "head"):
            association[side] = {"ref": self.pr[side]["ref"], "sha": self.pr[side]["sha"],
                                 "repo": {key: self.pr[side]["repo"][key] for key in ("id", "url")}}
        self.run["pull_requests"] = [association]
        self.jobs = [{"name": f"{check} ({platform}, {arch})", "status": "completed",
                      "conclusion": "success", "started_at": "2026-01-01T00:00:00Z",
                      "completed_at": "2026-01-01T00:03:00Z"}
                     for platform, (_, arch) in evidence.PLATFORMS.items()
                     for check in ("unit", "smoke", "ui")]

    def validate(self):
        return evidence.validate_source(self.pr, self.run, self.jobs, 7)

    def test_verifiable_fork_with_real_rest_association_shape(self):
        self.assertEqual(len(self.validate()), 9)
        self.assertNotEqual(self.run["head_repository"]["full_name"], evidence.REPOSITORY)
        self.assertNotIn("full_name", self.run["pull_requests"][0]["head"]["repo"])

    def test_missing_empty_ambiguous_and_malformed_fork_associations_block(self):
        association = copy.deepcopy(self.run["pull_requests"][0])
        for associations in (None, [], [association, association], [{}], [None]):
            with self.subTest(associations=associations):
                self.run["pull_requests"] = associations
                with self.assertRaisesRegex(ValueError, "BLOCKED"):
                    self.validate()
        del self.run["pull_requests"]
        with self.assertRaisesRegex(ValueError, "BLOCKED"):
            self.validate()

    def test_same_head_ref_cannot_substitute_for_pr_identity(self):
        for key, value in (("number", 8), ("id", 808),
                           ("url", f"https://api.github.com/repos/{evidence.REPOSITORY}/pulls/8")):
            original = self.pr[key]
            with self.subTest(key=key):
                self.pr[key] = value
                with self.assertRaises(ValueError):
                    self.validate()
                self.pr[key] = original

    def test_same_head_pr_on_different_base_is_rejected(self):
        self.pr["base"]["ref"] = "release"
        with self.assertRaises(ValueError):
            self.validate()

    def test_closed_then_new_pr_on_same_branch_cannot_reuse_run(self):
        self.pr["state"] = "closed"
        with self.assertRaises(ValueError):
            self.validate()
        self.pr.update(state="open", number=8, id=808,
                       url=f"https://api.github.com/repos/{evidence.REPOSITORY}/pulls/8")
        with self.assertRaises(ValueError):
            self.validate()

    def test_association_checks_each_repository_ref_and_head_sha(self):
        original = copy.deepcopy(self.run["pull_requests"][0])
        for side, key, value in (("base", "ref", "release"), ("head", "ref", "other"),
                                 ("head", "sha", "c" * 40)):
            with self.subTest(side=side, key=key):
                self.run["pull_requests"][0][side][key] = value
                with self.assertRaises(ValueError):
                    self.validate()
                self.run["pull_requests"][0] = copy.deepcopy(original)
        for side in ("base", "head"):
            for key, value in (("id", 99), ("url", "https://api.github.com/repos/other/vi")):
                with self.subTest(side=side, key=key):
                    self.run["pull_requests"][0][side]["repo"][key] = value
                    with self.assertRaises(ValueError):
                        self.validate()
                    self.run["pull_requests"][0] = copy.deepcopy(original)

    def test_base_sha_advancement_does_not_replace_strict_integration_checks(self):
        self.pr["base"]["sha"] = "c" * 40
        self.assertEqual(len(self.validate()), 9)

    def test_source_requires_api_to_return_requested_pr_and_run(self):
        for mutation in ("pr", "run"):
            pr, run = copy.deepcopy(self.pr), copy.deepcopy(self.run)
            if mutation == "pr":
                pr["number"] = 8
            else:
                run["id"] = 43
            api = mock.Mock()
            api.request.side_effect = [pr, run]
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                evidence.source(api, 6, 42)
            api.pages.assert_not_called()

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

    def prepared_output(self, directory):
        output = Path(directory)
        files = []
        for platform in evidence.PLATFORMS:
            for suite in evidence.SUITES:
                for extension in ("webm", "png", "gif"):
                    name = f"{platform}-{suite}.{extension}"
                    data = b"processed-public-fixture"
                    (output / name).write_bytes(data)
                    files.append({"name": name, "bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest()})
        manifest = {"repository": evidence.REPOSITORY, "pr": 6, "run": 42,
                    "head": self.pr["head"]["sha"], "attempt": 1,
                    "jobs": self.validate(), "files": files}
        (output / "report.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.pr["body"] = "Closes #123\nOriginal text."
        self.run["run_attempt"] = 1
        return manifest

    def test_publisher_rejects_bad_manifest_before_writes(self):
        for mutation in ("unexpected-report-field", "wrong-head", "missing-file", "corrupt-file",
                         "extra-executable", "missing-manifest-entry", "unsafe-name"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                manifest = self.prepared_output(directory)
                if mutation == "unexpected-report-field":
                    manifest["rawLog"] = "not-public"
                elif mutation == "wrong-head":
                    manifest["head"] = "b" * 40
                elif mutation == "missing-file":
                    (Path(directory) / manifest["files"][0]["name"]).unlink()
                elif mutation == "corrupt-file":
                    (Path(directory) / manifest["files"][0]["name"]).write_bytes(b"corrupted")
                elif mutation == "extra-executable":
                    (Path(directory) / "helper.py").write_text("must not execute", encoding="utf-8")
                elif mutation == "missing-manifest-entry":
                    manifest["files"].pop()
                else:
                    manifest["files"][0]["name"] = "../escape"
                (Path(directory) / "report.json").write_text(json.dumps(manifest), encoding="utf-8")
                api = mock.Mock()
                with mock.patch.object(evidence, "OUTPUT", Path(directory)), \
                        mock.patch.object(evidence, "source",
                                          return_value=(self.pr, self.run, self.validate())), \
                        self.assertRaises(ValueError):
                    evidence.publish(api, 6, 42)
                api.request.assert_not_called()
                api.upload.assert_not_called()

    def test_publication_preserves_latest_body_and_verifies_every_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            self.prepared_output(directory)
            latest = copy.deepcopy(self.pr)
            latest["body"] += "\nIntervening reviewer edit."
            fresh = copy.deepcopy(latest)
            fresh["body"] += "\nEdited during metadata validation."
            preserved_prefix = fresh["body"] + "\n"
            preserved_suffix = "\nFixes #124\nFinal reviewer notes."
            fresh["body"] = (preserved_prefix + evidence.START + "\nOld evidence\n" +
                             evidence.END + preserved_suffix)
            tag = "evidence-pr-6-run-42-attempt-1"
            base = f"https://github.com/{evidence.REPOSITORY}/releases"
            api = mock.Mock()
            api.pages.return_value = []

            def request(route, method="GET", data=None):
                if route.endswith(f"/releases/tags/{tag}"):
                    raise urllib.error.HTTPError("", 404, "Not found", {}, None)
                if route.endswith("/releases"):
                    self.assertEqual(method, "POST")
                    self.assertTrue(data["prerelease"])
                    self.assertEqual(data["make_latest"], "false")
                    return {"id": 99, "html_url": base + "/tag/" + tag}
                if method == "GET":
                    self.assertTrue(route.endswith("/pulls/6"))
                    return fresh
                self.assertEqual(method, "PATCH")
                self.assertTrue(data["body"].startswith(preserved_prefix))
                self.assertTrue(data["body"].endswith(preserved_suffix))
                self.assertNotIn("Old evidence", data["body"])
                return {**fresh, "body": data["body"]}

            api.request.side_effect = request
            api.upload.side_effect = lambda release_id, name, data, content_type: {
                "state": "uploaded", "size": len(data),
                "browser_download_url": f"{base}/download/{tag}/{name}"}
            with mock.patch.object(evidence, "OUTPUT", Path(directory)), \
                    mock.patch.object(evidence, "source", side_effect=[
                        (self.pr, self.run, self.validate()), (latest, self.run, self.validate())]):
                evidence.publish(api, 6, 42)
            self.assertEqual(api.upload.call_count, 19)
            self.assertEqual(api.request.call_args.args[1], "PATCH")
            self.assertEqual(api.request.call_args_list[-2].args, (
                f"/repos/{evidence.REPOSITORY}/pulls/6",))

    def test_changed_head_stops_pr_update_after_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            self.prepared_output(directory)
            api = mock.Mock()
            api.request.return_value = {"id": 99, "html_url": "public-release"}
            api.pages.return_value = []
            api.upload.side_effect = lambda release_id, name, data, content_type: {
                "state": "uploaded", "size": len(data),
                "browser_download_url": f"https://github.com/{evidence.REPOSITORY}/releases/"
                                        f"download/evidence-pr-6-run-42-attempt-1/{name}"}
            with mock.patch.object(evidence, "OUTPUT", Path(directory)), \
                    mock.patch.object(evidence, "source", side_effect=[
                        (self.pr, self.run, self.validate()), ValueError("BLOCKED: changed head")]), \
                    self.assertRaises(ValueError):
                evidence.publish(api, 6, 42)
            self.assertEqual(api.request.call_count, 1)

    def test_successful_new_run_attempt_or_timings_blocks_patch(self):
        for mutation in ("run-id", "attempt", "timings", "attempt-and-timings"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                self.prepared_output(directory)
                latest_run = copy.deepcopy(self.run)
                latest_timings = self.validate()
                if mutation == "run-id":
                    latest_run["id"] = 43
                if mutation in ("attempt", "attempt-and-timings"):
                    latest_run["run_attempt"] = 2
                if mutation in ("timings", "attempt-and-timings"):
                    latest_timings[0].update(seconds=179.0, completedAt="2026-01-01T00:02:59Z")
                api = mock.Mock()
                api.request.return_value = {"id": 99, "html_url": "public-release"}
                api.pages.return_value = []
                api.upload.side_effect = lambda release_id, name, data, content_type: {
                    "state": "uploaded", "size": len(data),
                    "browser_download_url": f"https://github.com/{evidence.REPOSITORY}/releases/"
                                            f"download/evidence-pr-6-run-42-attempt-1/{name}"}
                with mock.patch.object(evidence, "OUTPUT", Path(directory)), \
                        mock.patch.object(evidence, "source", side_effect=[
                            (self.pr, self.run, self.validate()), (self.pr, latest_run, latest_timings)]), \
                        self.assertRaisesRegex(ValueError, "source run/attempt/jobs"):
                    evidence.publish(api, 6, 42)
                self.assertEqual(api.upload.call_count, 19)
                self.assertEqual(api.request.call_count, 1)

    def test_fresh_pr_changes_block_patch_after_metadata_validation(self):
        for mutation in ("closed", "number", "id", "url", "head-sha", "base-ref",
                         "head-ref", "base-id", "base-url", "head-id", "head-url",
                         "base-full_name", "head-full_name"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                self.prepared_output(directory)
                fresh = copy.deepcopy(self.pr)
                if mutation == "closed":
                    fresh["state"] = "closed"
                elif mutation in ("number", "id", "url"):
                    fresh[mutation] = 8 if mutation != "url" else "different-pr-url"
                elif mutation == "head-sha":
                    fresh["head"]["sha"] = "c" * 40
                else:
                    side, key = mutation.split("-")
                    if key == "ref":
                        fresh[side]["ref"] = "changed"
                    else:
                        fresh[side]["repo"][key] = 99 if key == "id" else "different-repo-url"
                api = mock.Mock()
                api.request.side_effect = [{"id": 99, "html_url": "public-release"}, fresh]
                api.pages.return_value = []
                api.upload.side_effect = lambda release_id, name, data, content_type: {
                    "state": "uploaded", "size": len(data),
                    "browser_download_url": f"https://github.com/{evidence.REPOSITORY}/releases/"
                                            f"download/evidence-pr-6-run-42-attempt-1/{name}"}
                with mock.patch.object(evidence, "OUTPUT", Path(directory)), \
                        mock.patch.object(evidence, "source",
                                          return_value=(self.pr, self.run, self.validate())), \
                        self.assertRaises(ValueError):
                    evidence.publish(api, 6, 42)
                self.assertEqual(api.request.call_count, 2)
                self.assertTrue(all(len(call.args) == 1 for call in api.request.call_args_list))
