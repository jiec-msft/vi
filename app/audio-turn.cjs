const BYTES_PER_SECOND = 16000 * 2;
const SEGMENT_BYTES = BYTES_PER_SECOND * 30;
const MAX_BUFFER_BYTES = BYTES_PER_SECOND * 60;
const MAX_TRANSCRIPT_CHARS = 262144;

function joinTranscript(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  const separator = /\s$/u.test(previous) || /^\s/u.test(next) ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}。！？]$/u.test(previous) &&
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next) ? '' : ' ';
  return previous + separator + next;
}

function quietPcm(data) {
  let sum = 0;
  for (let offset = 0; offset < data.length; offset += 2) sum += (data.readInt16LE(offset) / 32768) ** 2;
  return Math.sqrt(sum / (data.length / 2)) < 0.008;
}

class AudioTurn {
  constructor({ onFailure, onConnected = () => {}, onSegment = async () => {},
    onSegmentState = () => {}, maxBytes = MAX_BUFFER_BYTES, segmentBytes = SEGMENT_BYTES }) {
    if (!Number.isInteger(maxBytes) || maxBytes < 2 || maxBytes % 2 || maxBytes > MAX_BUFFER_BYTES ||
        !Number.isInteger(segmentBytes) || segmentBytes < 2 || segmentBytes % 2 || segmentBytes > SEGMENT_BYTES) {
      throw new Error('Invalid recording buffer or segment limit.');
    }
    this.onFailure = onFailure;
    this.onConnected = onConnected;
    this.onSegment = onSegment;
    this.onSegmentState = onSegmentState;
    this.maxBytes = maxBytes;
    this.segmentBytes = segmentBytes;
    this.chunks = [];
    this.bytes = 0;
    this.queuedBytes = 0;
    this.captureSegmentBytes = 0;
    this.sentSegmentBytes = 0;
    this.quietBytes = 0;
    this.completedSegments = 0;
    this.committedText = '';
    this.tailText = '';
    this.ready = new Promise((resolve, reject) => { this.readyState = { resolve, reject }; });
    void this.ready.catch(() => {});
  }

  connect(session, beforeAudio = Promise.resolve()) {
    if (this.session) throw new Error('This recording already has a cloud session.');
    this.session = session;
    if (this.cancelled || this.failure) { session.cancel(); return; }
    void (async () => {
      try {
        await Promise.all([session.start(), beforeAudio]);
        if (this.cancelled || this.failure) return;
        this.connected = true;
        this.readyState.resolve();
        this.onConnected();
        this.pump();
      } catch (error) {
        if (!this.cancelled) this.fail(error);
      }
    })();
  }

  push(data) {
    if (this.cancelled || this.failure) throw this.failure || new Error('Recording was cancelled.');
    if (this.stopped) throw new Error('Microphone audio arrived after recording stopped.');
    if (!Buffer.isBuffer(data) || !data.length || data.length % 2 || data.length > 32000) {
      throw new Error('Invalid microphone PCM chunk.');
    }
    if (this.queuedBytes + data.length > this.maxBytes) {
      const error = new Error('Pending audio exceeded the 60-second buffer. Recording stopped; check the network before trying again.');
      this.fail(error);
      throw error;
    }
    this.bytes += data.length;
    this.queuedBytes += data.length;
    for (let offset = 0; offset < data.length;) {
      const count = Math.min(data.length - offset, this.segmentBytes - this.captureSegmentBytes);
      const chunk = data.subarray(offset, offset + count);
      this.captureSegmentBytes += count;
      this.quietBytes = quietPcm(chunk) ? this.quietBytes + count : 0;
      const boundary = this.captureSegmentBytes === this.segmentBytes ||
        this.captureSegmentBytes >= this.segmentBytes * 0.8 && this.quietBytes >= BYTES_PER_SECOND * 0.3;
      this.chunks.push({ data: chunk, boundary });
      offset += count;
      if (boundary) { this.captureSegmentBytes = 0; this.quietBytes = 0; }
    }
    this.pump();
  }

  preview(text) {
    const result = joinTranscript(this.committedText, text);
    if (result.length > MAX_TRANSCRIPT_CHARS) throw new Error('The transcript reached its text-size limit. Stop and start a new dictation.');
    return result;
  }

  segmentText(text) { return this.preview(text).slice(this.committedText.length); }

  cut() {
    if (!this.connected || this.cancelled || this.failure || this.stopped || this.segmentFinalizing ||
        !this.bytes || this.chunks.some((chunk) => chunk.boundary)) return false;
    if (this.chunks.length) this.chunks[this.chunks.length - 1].boundary = true;
    else this.chunks.push({ boundary: true });
    this.captureSegmentBytes = 0;
    this.quietBytes = 0;
    this.pump();
    return true;
  }

  pump() {
    if (!this.connected || this.working || this.cancelled || this.failure) return;
    this.working = (async () => {
      while (this.chunks.length && !this.cancelled && !this.failure) {
        const chunk = this.chunks.shift();
        if (chunk.data) {
          await this.session.audio(chunk.data);
          if (this.cancelled || this.failure) return;
          this.queuedBytes -= chunk.data.length;
          this.sentSegmentBytes += chunk.data.length;
        }
        if (chunk.boundary && this.sentSegmentBytes) {
          this.segmentFinalizing = true;
          this.onSegmentState();
          const text = await this.session.finishTurn();
          if (this.cancelled || this.failure) return;
          const completedBytes = this.sentSegmentBytes;
          const writable = this.segmentText(text);
          const committed = this.preview(text);
          await this.onSegment(writable, this.completedSegments + 1, completedBytes);
          if (this.cancelled || this.failure) return;
          this.committedText = committed;
          this.completedSegments++;
          this.sentSegmentBytes = 0;
          this.segmentFinalizing = false;
          this.onSegmentState();
        }
      }
    })().catch((error) => {
      if (!this.cancelled) this.fail(error);
    }).finally(() => {
      this.working = undefined;
      if (this.chunks.length) this.pump();
    });
  }

  finish() {
    if (this.final) return this.final;
    this.stopped = true;
    this.final = (async () => {
      if (!this.bytes) throw new Error('No microphone audio was recorded.');
      this.finalTimer = setTimeout(() => {
        this.fail(new Error('Recorded audio did not finish uploading/transcribing within 60 seconds.'));
      }, 60000);
      await this.ready;
      this.session.stopRecordingDeadline?.();
      while (this.working) await this.working;
      if (this.failure || this.cancelled) throw this.failure || new Error('Recording was cancelled.');
      if (this.sentSegmentBytes) this.tailText = this.segmentText(await this.session.finish());
      else this.session.close();
      return this.preview(this.tailText);
    })().finally(() => clearTimeout(this.finalTimer));
    return this.final;
  }

  clear() { this.chunks.length = 0; this.queuedBytes = 0; }

  fail(error) {
    if (this.failure || this.cancelled) return;
    this.failure = error;
    this.clear();
    this.readyState.reject(error);
    try { this.onFailure(error); }
    finally { this.session?.cancel(); }
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    clearTimeout(this.finalTimer);
    this.clear();
    this.readyState.reject(new Error('Recording was cancelled.'));
    this.session?.cancel();
  }
}

module.exports = { AudioTurn, joinTranscript, SEGMENT_BYTES, MAX_BUFFER_BYTES };
