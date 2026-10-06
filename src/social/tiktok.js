import axios from 'axios';
import fs from 'fs';

const MAX_SINGLE_CHUNK = 64 * 1024 * 1024;
const MULTI_CHUNK_SIZE = 32 * 1024 * 1024;

function chunkPlan(size) {
  if (size <= MAX_SINGLE_CHUNK) {
    return { chunkSize: size, count: 1 };
  }
  const count = Math.floor(size / MULTI_CHUNK_SIZE);
  return { chunkSize: MULTI_CHUNK_SIZE, count: Math.max(2, count) };
}

export async function uploadTikTokDraft({ filePath }) {
  if (process.env.TIKTOK_UPLOAD_ENABLED !== 'true') {
    throw new Error('TikTok uploads are disabled');
  }
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) throw new Error('TIKTOK_ACCESS_TOKEN is not configured');

  const size = (await fs.promises.stat(filePath)).size;
  if (!size) throw new Error('TikTok upload file is empty');
  const { chunkSize, count } = chunkPlan(size);

  const init = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
    {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: chunkSize,
        total_chunk_count: count,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      timeout: 15000,
    }
  );

  const uploadUrl = init.data?.data?.upload_url;
  const publishId = init.data?.data?.publish_id;
  if (!uploadUrl) {
    throw new Error(`TikTok draft init failed: ${init.data?.error?.code || 'upload_url missing'}`);
  }

  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const isLast = index === count - 1;
    const end = isLast ? size - 1 : start + chunkSize - 1;
    const length = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });

    await axios.put(uploadUrl, stream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': length,
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 10 * 60 * 1000,
    });

    start = end + 1;
  }

  return { publishId, mode: 'draft' };
}
