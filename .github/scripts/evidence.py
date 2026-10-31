"""CI-only media preparation; trusted, separately permissioned publication."""

import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from datetime import datetime
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "jiec-msft/vi"
PLATFORMS = {"windows-2025": ("win32", "x64"),
             "windows-11-arm": ("win32", "arm64"), "macos-15": ("darwin", "arm64")}
SUITES = ("ui", "framework-ui")
START = "<!-- vi-evidence:start -->"
END = "<!-- vi-evidence:end -->"
MAX_BYTES = 50 * 1024 * 1024
OUTPUT = Path("evidence-public")


def require(condition, message):
    if not condition:
        raise ValueError(f"BLOCKED: {message}")


def positive_id(value):
    require(isinstance(value, str) and re.fullmatch(r"[1-9][0-9]*", value),
            "PR and run IDs must be positive decimal integers.")
    return int(value)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        return None


class GitHub:
    def __init__(self):
        require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY,
                "Publisher only supports the public VI repository.")
        self.token = os.environ["GH_TOKEN"]

    def request(self, route, method="GET", data=None, content_type="application/json"):
        require(route.startswith(f"/repos/{REPOSITORY}/"), "Unexpected API repository.")
        url = f"https://api.github.com{route}"
        payload = json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(url, data=payload, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "Content-Type": content_type,
        })
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def pages(self, route, key=None):
        result = []
        for page in range(1, 11):
            separator = "&" if "?" in route else "?"
            data = self.request(f"{route}{separator}per_page=100&page={page}")
            items = data[key] if key else data
            result.extend(items)
            if len(items) < 100:
                return result
        raise ValueError("BLOCKED: API pagination exceeded the bounded limit.")

    def archive(self, artifact_id):
        request = urllib.request.Request(
            f"https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip",
            headers={"Authorization": f"Bearer {self.token}",
                     "Accept": "application/vnd.github+json"})
        try:
            urllib.request.build_opener(NoRedirect).open(request, timeout=30)
        except urllib.error.HTTPError as error:
            require(error.code == 302, "Artifact archive did not return a download redirect.")
            location = error.headers["Location"]
        else:
            raise ValueError("BLOCKED: Unexpected artifact download response.")
        target = urllib.parse.urlparse(location)
        require(target.scheme == "https" and target.hostname and not target.username,
                "Artifact download must use HTTPS.")
        # The signed storage URL is fetched without forwarding the API token.
        with urllib.request.urlopen(location, timeout=30) as response:
            data = response.read(MAX_BYTES + 1)
        require(len(data) <= MAX_BYTES, "Artifact exceeds the media size limit.")
        return data

    def upload(self, release_id, name, data, content_type):
        require(len(data) <= MAX_BYTES, "Release asset exceeds the media size limit.")
        url = (f"https://uploads.github.com/repos/{REPOSITORY}/releases/{release_id}/assets"
               f"?name={urllib.parse.quote(name)}")
        request = urllib.request.Request(url, data=data, method="POST", headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": content_type,
            "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)


def validate_association(pr, run):
    associations = run.get("pull_requests")
    require(isinstance(associations, list) and len(associations) == 1,
            "Run must have exactly one authoritative PR association; missing/fork associations cannot be inferred.")
    associated = associations[0]
    require(isinstance(associated, dict) and
            all(associated.get(key) == pr[key] for key in ("number", "id", "url")),
            "Run is associated with a different PR.")
    for side in ("base", "head"):
        snapshot = associated.get(side)
        require(isinstance(snapshot, dict) and isinstance(snapshot.get("repo"), dict) and
                snapshot.get("ref") == pr[side]["ref"] and
                all(snapshot["repo"].get(key) == pr[side]["repo"][key] for key in ("id", "url")),
                f"Run association does not match the PR {side} ref/repository.")
    require(associated["head"].get("sha") == pr["head"]["sha"],
            "Run association does not match the exact PR head.")


def validate_pr_identity(latest, expected):
    require(latest["state"] == "open" and
            all(latest[key] == expected[key] for key in ("number", "id", "url")),
            "PR closed or changed before publication.")
    for side in ("base", "head"):
        require(latest[side]["ref"] == expected[side]["ref"] and
                all(latest[side]["repo"][key] == expected[side]["repo"][key]
                    for key in ("id", "url", "full_name")),
                f"PR {side} ref/repository changed before publication.")
    require(latest["head"]["sha"] == expected["head"]["sha"],
            "PR head changed before publication.")


def validate_manifest_source(manifest, pr, run, timings):
    require(manifest["repository"] == REPOSITORY and manifest["pr"] == pr["number"] and
            manifest["run"] == run["id"] and manifest["head"] == pr["head"]["sha"] and
            manifest["attempt"] == run["run_attempt"] and manifest["jobs"] == timings,
            "Prepared evidence does not match the successful current source run/attempt/jobs.")


def validate_source(pr, run, jobs, workflow_id, allow_active=False):
    require(pr["state"] == "open" and pr["base"]["repo"]["full_name"] == REPOSITORY,
            "PR must be open in the public VI repository.")
    require(run["repository"]["full_name"] == REPOSITORY and
            run["head_repository"]["full_name"] == pr["head"]["repo"]["full_name"],
            "Run repository does not match the PR.")
    require(run["event"] == "pull_request" and run["workflow_id"] == workflow_id and
            run["path"] == ".github/workflows/ci.yml", "Run must belong to Platform checks.")
    require(run["head_sha"] == pr["head"]["sha"], "Run does not match the exact current PR head.")
    require(run["head_branch"] == pr["head"]["ref"], "Run branch does not match the PR.")
    validate_association(pr, run)
    active = allow_active and str(run["id"]) == os.environ.get("GITHUB_RUN_ID")
    require((run["status"] == "completed" and run["conclusion"] == "success") or
            (active and run["status"] == "in_progress"),
            "Source run must be successful and complete (only its own preview may run early).")
    timings = []
    for platform, (_, arch) in PLATFORMS.items():
        for check in ("unit", "smoke", "ui"):
            name = f"{check} ({platform}, {arch})"
            matched = [job for job in jobs if job["name"] == name]
            require(len(matched) == 1 and matched[0]["status"] == "completed" and
                    matched[0]["conclusion"] == "success", f"Required job is not successful: {name}")
            job = matched[0]
            started = datetime.fromisoformat(job["started_at"].replace("Z", "+00:00"))
            ended = datetime.fromisoformat(job["completed_at"].replace("Z", "+00:00"))
            seconds = (ended - started).total_seconds()
            limit = 600 if check == "ui" else 180
            require(0 <= seconds <= limit, f"Entire-job budget exceeded: {name}")
            timings.append({"name": name, "seconds": seconds, "limitSeconds": limit,
                            "startedAt": job["started_at"], "completedAt": job["completed_at"]})
    return timings


def source(api, pr_number, run_id, allow_active=False):
    route = f"/repos/{REPOSITORY}"
    pr = api.request(f"{route}/pulls/{pr_number}")
    run = api.request(f"{route}/actions/runs/{run_id}")
    require(pr["number"] == pr_number and run["id"] == run_id, "API returned a different PR/run.")
    workflow = api.request(f"{route}/actions/workflows/ci.yml")
    jobs = api.pages(f"{route}/actions/runs/{run_id}/attempts/{run['run_attempt']}/jobs", "jobs")
    timings = validate_source(pr, run, jobs, workflow["id"], allow_active)
    return pr, run, timings


def unpack_media(data):
    media = {}
    allowed = {f"{suite}/{name}" for suite in SUITES
               for name in ("desktop.webm", "desktop.png", "report.json")}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(sum(item.file_size for item in archive.infolist()) <= MAX_BYTES,
                "Expanded artifact exceeds the media size limit.")
        for item in archive.infolist():
            name = item.filename
            require("\\" not in name and not name.startswith("/") and
                    ".." not in name.split("/") and (item.external_attr >> 16) & 0o170000 != 0o120000,
                    "Unsafe archive entry.")
            if item.is_dir():
                require(name.rstrip("/") in (*SUITES, "artifacts-ci",
                        *(f"artifacts-ci/{suite}" for suite in SUITES)), "Unexpected archive directory.")
                continue
            if name.startswith("artifacts-ci/"):
                name = name[len("artifacts-ci/"):]
            require(name in allowed and name not in media, "Unexpected or duplicate archive file.")
            require(0 < item.file_size <= MAX_BYTES, "Missing or empty media file.")
            media[name] = archive.read(item)
    require(set(media) == allowed, "Both UI suites must provide video, screenshot and report.")
    return media


def tool(*arguments):
    try:
        completed = subprocess.run(arguments, check=True, capture_output=True, timeout=45)
    except subprocess.CalledProcessError as error:
        sys.stderr.write(error.stderr.decode("utf-8", errors="replace"))
        raise
    return completed.stdout


def prepare(api, pr_number, run_id):
    require(os.environ.get("GITHUB_ACTIONS") == "true", "Media conversion is CI-only.")
    pr, run, timings = source(api, pr_number, run_id, allow_active=True)
    artifacts = api.pages(f"/repos/{REPOSITORY}/actions/runs/{run_id}/artifacts", "artifacts")
    OUTPUT.mkdir(exist_ok=False)
    files = []
    for platform, (os_name, arch) in PLATFORMS.items():
        matched = [artifact for artifact in artifacts if artifact["name"] == f"evidence-{platform}-ui"]
        require(len(matched) == 1 and not matched[0]["expired"] and
                0 < matched[0]["size_in_bytes"] <= MAX_BYTES, f"UI artifact missing/expired: {platform}")
        media = unpack_media(api.archive(matched[0]["id"]))
        for suite in SUITES:
            report = json.loads(media[f"{suite}/report.json"])
            require(report.get("status") == "passed" and report.get("platform") == os_name and
                    report.get("arch") == arch and report.get("videoScope") == "desktop",
                    f"Desktop report failed or mismatched: {platform}/{suite}")
            require(isinstance(report.get("checks"), list) and len(report["checks"]) > 0,
                    "Desktop report contains no checks.")
            prefix = f"{platform}-{suite}"
            with tempfile.TemporaryDirectory() as temporary:
                raw = Path(temporary) / "desktop.webm"
                raw.write_bytes(media[f"{suite}/desktop.webm"])
                metadata = json.loads(tool("ffprobe", "-v", "error", "-show_format",
                                           "-show_streams", "-of", "json", str(raw)))
                videos = [stream for stream in metadata["streams"] if stream["codec_type"] == "video"]
                require(len(videos) == 1 and 0 < videos[0]["width"] <= 4096 and
                        0 < videos[0]["height"] <= 4096, "Video dimensions are invalid.")
                tool("ffmpeg", "-v", "error", "-i", str(raw), "-map", "0:v:0", "-an",
                     "-t", "181", "-map_metadata", "-1", "-fflags", "+bitexact",
                     "-flags:v", "+bitexact", "-c:v", "libvpx-vp9", "-deadline", "realtime",
                     "-cpu-used", "8", "-crf", "36", "-b:v", "0",
                     str(OUTPUT / f"{prefix}.webm"))
                finalized = json.loads(tool("ffprobe", "-v", "error", "-show_format",
                                            "-of", "json", str(OUTPUT / f"{prefix}.webm")))
                require(0 < float(finalized["format"]["duration"]) <= 180, "Video duration is invalid.")
                tool("ffmpeg", "-v", "error", "-i", str(raw), "-t", "12", "-an",
                     "-filter_complex",
                     "fps=3,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
                     "-map_metadata", "-1", "-loop", "0", str(OUTPUT / f"{prefix}.gif"))
                tool("ffmpeg", "-v", "error", "-i", str(raw), "-frames:v", "1",
                     "-map_metadata", "-1", str(OUTPUT / f"{prefix}.png"))
            for extension in ("webm", "gif", "png"):
                asset = OUTPUT / f"{prefix}.{extension}"
                size = asset.stat().st_size
                require(0 < size <= MAX_BYTES, "Converted media is empty or oversized.")
                files.append({"name": asset.name, "bytes": size,
                              "sha256": hashlib.sha256(asset.read_bytes()).hexdigest()})
    # Copy only known-safe metrics, never raw logs, fixture paths or report strings.
    manifest = {"repository": REPOSITORY, "pr": pr_number, "head": pr["head"]["sha"],
                "run": run_id, "attempt": run["run_attempt"], "jobs": timings, "files": files}
    (OUTPUT / "report.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared 18 public media assets for PR #{pr_number}, head {manifest['head']}.")


def replace_evidence(body, block):
    body = body or ""
    require(body.count(START) == body.count(END) and body.count(START) <= 1,
            "PR evidence markers are ambiguous; repair them manually.")
    if START in body:
        first, last = body.index(START), body.index(END)
        require(first < last, "PR evidence markers are reversed.")
        return body[:first] + block + body[last + len(END):]
    return body + ("\n\n" if body else "") + block


def evidence_body(manifest, urls):
    lines = [START, "### CI visual evidence", "",
             f"Exact head: `{manifest['head']}`; [Platform checks]"
             f"(https://github.com/{REPOSITORY}/actions/runs/{manifest['run']}"
             f"/attempts/{manifest['attempt']}).",
             "CI-owned fake provider / synthetic audio only; no application packages.", "",
             "| Platform / suite | Preview (first 12 seconds) | Full recording |",
             "| --- | --- | --- |"]
    for platform in PLATFORMS:
        for suite in SUITES:
            prefix = f"{platform}-{suite}"
            lines.append(f"| {platform} / {suite} | ![CI preview]({urls[prefix + '.gif']}) | "
                         f"[Video]({urls[prefix + '.webm']}) / [Screenshot]({urls[prefix + '.png']}) |")
    lines.extend(["", f"[Sanitized report and entire-job timings]({urls['report.json']}).",
                  "Job times include setup, execution, cleanup and upload; queue time is excluded.",
                  "Media preparation/publication are additional jobs, not an end-to-end speedup.", END])
    return "\n".join(lines)


def publish(api, pr_number, run_id):
    pr, run, timings = source(api, pr_number, run_id)
    report_path = OUTPUT / "report.json"
    require(report_path.is_file() and not report_path.is_symlink() and
            0 < report_path.stat().st_size <= MAX_BYTES, "Prepared report is missing or unsafe.")
    manifest = json.loads(report_path.read_text(encoding="utf-8"))
    require(set(manifest) == {"repository", "pr", "head", "run", "attempt", "jobs", "files"},
            "Prepared report contains unexpected fields.")
    validate_manifest_source(manifest, pr, run, timings)
    expected = {f"{platform}-{suite}.{extension}" for platform in PLATFORMS
                for suite in SUITES for extension in ("webm", "gif", "png")}
    require(len(manifest["files"]) == len(expected) and
            {item["name"] for item in manifest["files"]} == expected,
            "Prepared asset manifest is incomplete or unsafe.")
    require({item.name for item in OUTPUT.iterdir()} == expected | {"report.json"},
            "Only allowlisted media/report files may be published.")
    for item in manifest["files"]:
        require(set(item) == {"name", "bytes", "sha256"} and
                isinstance(item["bytes"], int) and 0 < item["bytes"] <= MAX_BYTES,
                "Prepared asset metadata is unsafe.")
        asset = OUTPUT / item["name"]
        require(asset.is_file() and not asset.is_symlink() and asset.stat().st_size == item["bytes"] and
                hashlib.sha256(asset.read_bytes()).hexdigest() == item["sha256"],
                "Prepared asset integrity check failed.")
    replace_evidence(pr["body"], START + END)
    tag = f"evidence-pr-{pr_number}-run-{run_id}-attempt-{run['run_attempt']}"
    route = f"/repos/{REPOSITORY}"
    try:
        release = api.request(f"{route}/releases/tags/{tag}")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        release = api.request(f"{route}/releases", "POST", {
            "tag_name": tag, "target_commitish": run["head_sha"], "name": f"PR #{pr_number} CI evidence",
            "body": f"Public CI media only. Head: {run['head_sha']}. Source run: "
                    f"https://github.com/{REPOSITORY}/actions/runs/{run_id}. No application packages.",
            "draft": False, "prerelease": True, "make_latest": "false"})
    assets = api.pages(f"{route}/releases/{release['id']}/assets")
    urls = {}
    types = {"gif": "image/gif", "png": "image/png", "webm": "video/webm", "json": "application/json"}
    for name in sorted(expected | {"report.json"}):
        data = (OUTPUT / name).read_bytes()
        matched = [asset for asset in assets if asset["name"] == name]
        require(len(matched) <= 1, "Duplicate release assets require manual cleanup.")
        if matched:
            asset = matched[0]
            require(asset.get("digest") == f"sha256:{hashlib.sha256(data).hexdigest()}" and
                    asset["size"] == len(data), "Existing evidence differs; never overwrite it silently.")
        else:
            asset = api.upload(release["id"], name, data, types[name.rsplit(".", 1)[1]])
        require(asset["state"] == "uploaded" and asset["size"] == len(data), "Asset upload did not finish.")
        require(asset["browser_download_url"].startswith(
                    f"https://github.com/{REPOSITORY}/releases/download/{tag}/"),
                "Asset URL does not belong to the expected public evidence release.")
        urls[name] = asset["browser_download_url"]
    block = evidence_body(manifest, urls)
    latest, latest_run, latest_timings = source(api, pr_number, run_id)
    validate_manifest_source(manifest, latest, latest_run, latest_timings)
    # PR PATCH has no verified CAS: a final read narrows, but cannot close, the race window.
    fresh = api.request(f"{route}/pulls/{pr_number}")
    validate_pr_identity(fresh, latest)
    body = replace_evidence(fresh["body"], block)
    result = api.request(f"{route}/pulls/{pr_number}", "PATCH", {"body": body})
    require(result["body"] == body, "PR body update was not accepted.")
    validate_pr_identity(result, fresh)
    print(f"Published {release['html_url']} and updated PR #{pr_number}.")


if __name__ == "__main__":
    require(len(sys.argv) == 2 and sys.argv[1] in ("prepare", "publish"), "Use prepare or publish.")
    if sys.argv[1] == "publish":
        require(os.environ.get("GITHUB_ACTIONS") == "true" and
                os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch",
                "Publication requires a trusted CI dispatch.")
    pr_number = positive_id(os.environ.get("VI_EVIDENCE_PR", ""))
    run_id = positive_id(os.environ.get("VI_EVIDENCE_RUN", ""))
    api = GitHub()
    {"prepare": prepare, "publish": publish}[sys.argv[1]](api, pr_number, run_id)
