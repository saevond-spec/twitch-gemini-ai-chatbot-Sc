import axios from 'axios';
import fs from 'fs';

export async function uploadTikTokDraft({ filePath }) {
  if (process.env.TIKTOK_UPLOAD_ENABLED !== 'true') {
    throw new Error('TikTok uploads are disabled');
  }
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) throw new Error('TIKTOK_ACCESS_TOKEN is not configured');

  const size = (await fs.promises.stat(filePath)).size;
  const init = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
    {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: size,
        total_chunk_count: 1,
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

  await axios.put(uploadUrl, fs.createReadStream(filePath), {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': size,
      'Content-Range': `bytes 0-${size - 1}/${size}`,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 10 * 60 * 1000,
  });

  return { publishId, mode: 'draft' };
}
