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

export function resumeAudioContext(): void {
  if (_ctx?.state === 'suspended') void _ctx.resume();
}
