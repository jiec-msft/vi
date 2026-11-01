import json
import os
import pathlib
import sys
import time

directory = pathlib.Path("prototypes/android-keyboard/evidence")
directory.mkdir(exist_ok=True)
started = int(os.environ["JOB_STARTED"])
elapsed = time.time() - started
budget = int(sys.argv[1])
report = {
    "head": os.environ["PROBE_HEAD"],
    "runId": os.environ["GITHUB_RUN_ID"],
    "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
    "job": os.environ["GITHUB_JOB"],
    "runner": os.environ["RUNNER_OS"],
    "elapsedBeforeUploadSeconds": round(elapsed, 3),
    "wholeJobBudgetSeconds": budget,
    "inputs": "CI-owned synthetic PCM and local fake provider; no credentials or network",
}
(directory / "receipt.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
if elapsed >= budget:
    raise SystemExit("Whole-job budget exceeded before artifact upload")
