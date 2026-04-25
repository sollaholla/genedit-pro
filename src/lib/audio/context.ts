let _ctx: AudioContext | null = null;
let _masterInput: GainNode | null = null;
let _masterGain: GainNode | null = null;
let _analyserL: AnalyserNode | null = null;
let _analyserR: AnalyserNode | null = null;

function boot(): AudioContext {
  if (_ctx) return _ctx;
  _ctx = new AudioContext();

  _masterInput = _ctx.createGain();
  _masterInput.channelCount = 2;
  _masterInput.channelCountMode = 'max';

  _masterGain = _ctx.createGain();
  // Force the fader output to stereo so the channel splitter always has L/R.
  _masterGain.channelCount = 2;
  _masterGain.channelCountMode = 'explicit';
  _masterInput.connect(_masterGain);
  _masterGain.connect(_ctx.destination);

  const splitter = _ctx.createChannelSplitter(2);
  _masterGain.connect(splitter);

  _analyserL = _ctx.createAnalyser();
  _analyserL.fftSize = 1024;
  _analyserL.smoothingTimeConstant = 0.7;

  _analyserR = _ctx.createAnalyser();
  _analyserR.fftSize = 1024;
  _analyserR.smoothingTimeConstant = 0.7;

  // MediaStreamDestination is a sink that lets leaf analyser nodes process audio
  // without needing to be connected to AudioContext.destination themselves.
  const sink = _ctx.createMediaStreamDestination();
  splitter.connect(_analyserL, 0);
  splitter.connect(_analyserR, 1);
  _analyserL.connect(sink);
  _analyserR.connect(sink);

  return _ctx;
}

export function getAudioContext(): AudioContext {
  return boot();
}

export function getMasterGain(): GainNode {
  boot();
  return _masterGain!;
}

export function getMasterInput(): GainNode {
  boot();
  return _masterInput!;
}

export function getAnalysers(): { left: AnalyserNode; right: AnalyserNode } {
  boot();
  return { left: _analyserL!, right: _analyserR! };
}

export type StereoAnalyserMeter = {
  input: GainNode;
  left: AnalyserNode;
  right: AnalyserNode;
  dispose: () => void;
};

export function createStereoAnalyserMeter(): StereoAnalyserMeter {
  const ctx = boot();
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'max';

  const splitter = ctx.createChannelSplitter(2);
  const left = ctx.createAnalyser();
  const right = ctx.createAnalyser();
  left.fftSize = 512;
  right.fftSize = 512;
  left.smoothingTimeConstant = 0.65;
  right.smoothingTimeConstant = 0.65;

  input.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);

  const sink = ctx.createMediaStreamDestination();
  left.connect(sink);
  right.connect(sink);

  return {
    input,
    left,
    right,
    dispose: () => {
      input.disconnect();
      splitter.disconnect();
      left.disconnect();
      right.disconnect();
    },
  };
}

export function resumeAudioContext(): void {
  if (_ctx?.state === 'suspended') void _ctx.resume();
}
