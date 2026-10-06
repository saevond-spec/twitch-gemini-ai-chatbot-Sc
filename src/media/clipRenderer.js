import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import ffmpegPath from 'ffmpeg-static';

export async function renderVerticalShort(inputPath) {
  if (!ffmpegPath) throw new Error('ffmpeg binary is unavailable');
  const outputPath = path.join(os.tmpdir(), `sweatyclanker-vertical-${randomUUID()}.mp4`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    outputPath,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });

  return outputPath;
}
