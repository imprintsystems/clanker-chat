// Renders video/launch.html to an MP4, frame by frame, so timing is exact.
//
//   node video/render.mjs <url-of-launch.html> <out.mp4> <ffmpeg> [--stills t1,t2,...]
//
// Serve the repository root over HTTP first (the page loads ../site/fonts).
// Uses the design-taste-frontend skill's CDP helper; set CHROME_PATH to a Chromium browser.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Browser } from '/Users/erik/.omp/agent/skills/design-taste-frontend/scripts/lib/cdp.mjs';

const [url, out, ffmpeg, flag, list] = process.argv.slice(2);
const FPS = 30;
const browser = await Browser.launch({ width: 1920, height: 1080 });
try {
  const page = await browser.newPage({ width: 1920, height: 1080 });
  await page.goto(url + '?capture', { settleMs: 500 });
  await page.eval('window.ready.then(() => true)');
  const duration = await page.eval('window.DURATION');

  if (flag === '--stills') {
    for (const t of list.split(',')) {
      await page.eval(`renderAt(${+t})`);
      await page.screenshot({ path: `${out}-${t}.jpg`, quality: 85 });
    }
  } else {
    const enc = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-vf', 'scale=out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const frames = Math.round(duration * FPS);
    for (let i = 0; i < frames; i++) {
      await page.eval(`renderAt(${i / FPS})`);
      const data = await page.screenshot({ quality: 96 });
      if (!enc.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => enc.stdin.once('drain', r));
      if (i % 90 === 0) process.stdout.write(`frame ${i}/${frames}\n`);
    }
    enc.stdin.end();
    await new Promise((r, j) => enc.on('close', (code) => (code === 0 ? r() : j(new Error('ffmpeg exit ' + code)))));
    writeFileSync('/dev/stdout', `wrote ${out}\n`);
  }
} finally {
  await browser.close();
}
