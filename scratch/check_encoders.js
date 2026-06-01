import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import fs from 'fs';

const CORE_VERSION = '0.12.9';
const baseURL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

async function main() {
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    console.log(message);
  });
  
  console.log('Loading FFmpeg...');
  // Since we are in Node, we can fetch from unpkg or load from node_modules if installed.
  // Let's load the WASM and JS.
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  
  console.log('Listing encoders...');
  await ffmpeg.exec(['-encoders']);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
