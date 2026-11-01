#!/usr/bin/env bash
set -euo pipefail
cd prototypes/android-keyboard
mkdir -p evidence
package=org.example.vikeyboard.synthetic
ime=$package/org.example.vikeyboard.VoiceIme
recorder=
cleanup() {
  result=$?
  trap - EXIT
  if [[ -n "$recorder" ]]; then
    device_recorder=$(adb shell cat /sdcard/keyboard-recorder.pid | tr -d '\r')
    if [[ "$device_recorder" =~ ^[0-9]+$ ]]; then
      adb shell kill -INT "$device_recorder" || result=1
    else
      echo "Missing owned recorder PID" >&2
      result=1
    fi
    wait "$recorder" || result=1
  fi
  adb pull "/sdcard/Android/data/$package/files/evidence/." evidence/ >> evidence/pull.log 2>&1 || result=1
  adb pull /sdcard/keyboard.mp4 evidence/keyboard.mp4 >> evidence/pull.log 2>&1 || result=1
  adb logcat -d -v threadtime > evidence/logcat.txt || result=1
  adb shell ime reset > evidence/cleanup.txt || result=1
  adb shell am force-stop "$package" || result=1
  exit "$result"
}
trap cleanup EXIT
adb install -r app/build/outputs/apk/synthetic/debug/app-synthetic-debug.apk
adb install -r app/build/outputs/apk/androidTest/synthetic/debug/app-synthetic-debug-androidTest.apk
adb shell ime enable "$ime"
adb shell ime set "$ime"
adb shell 'screenrecord --time-limit 150 /sdcard/keyboard.mp4 & recorder=$!; echo "$recorder" > /sdcard/keyboard-recorder.pid; wait "$recorder"' &
recorder=$!
for attempt in {1..20}; do
  device_recorder=$(adb shell cat /sdcard/keyboard-recorder.pid 2>/dev/null | tr -d '\r' || true)
  if [[ "$device_recorder" =~ ^[0-9]+$ ]]; then
    adb shell kill -0 "$device_recorder"
    printf '{"hostPid":%s,"emulatorPid":%s}\n' "$recorder" "$device_recorder" > evidence/recorder.json
    break
  fi
  sleep 0.2
done
test -s evidence/recorder.json
adb shell am instrument -w -r "$package.test/androidx.test.runner.AndroidJUnitRunner" \
  | tee evidence/instrumentation.txt
grep -Eq '^OK \(1 test\)' evidence/instrumentation.txt
