class TranscriptOutput {
  constructor(pipeline) {
    this.pipeline = pipeline;
  }

  accept(raw, sealed) {
    if (!Object.isFrozen(sealed) || sealed.runId !== this.pipeline.runId ||
        sealed.pipelineFingerprint !== this.pipeline.fingerprint) throw new Error('Unapproved transcript result.');
    this.raw = this.pipeline.privacy ? undefined : raw;
    this.sealed = sealed;
  }

  copy() {
    if (this.sealed?.outcome !== 'approved' || !this.sealed.text) throw new Error('No approved transcript to copy.');
    return this.sealed.text;
  }

  original() {
    if (this.pipeline.privacy || this.raw === undefined || !this.sealed) throw new Error('Original transcript is unavailable.');
    return this.raw;
  }
}

module.exports = { TranscriptOutput };
