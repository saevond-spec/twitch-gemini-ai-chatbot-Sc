import axios from 'axios';
import fs from 'fs';
import { getYouTubeAccessToken } from './youtubeAuth.js';

function normalizePrivacy(requested) {
  const value = requested || process.env.YOUTUBE_DEFAULT_PRIVACY || 'private';
  if (value === 'public' && process.env.YOUTUBE_ALLOW_PUBLIC !== 'true') return 'private';
  if (!['private','unlisted','public'].includes(value)) return 'private';
  return value;
}

export async function uploadYouTubeVideo({ filePath, title, description = '', privacyStatus }) {
  if (process.env.YOUTUBE_UPLOAD_ENABLED !== 'true') {
    throw new Error('YouTube uploads are disabled');
  }

  const accessToken = await getYouTubeAccessToken();
  const size = (await fs.promises.stat(filePath)).size;
  const privacy = normalizePrivacy(privacyStatus);

  const init = await axios.post(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      snippet: {
        title: String(title || 'SweatyClanker highlight').slice(0, 100),
        description: String(description || '').slice(0, 5000),
      },
      status: { privacyStatus: privacy },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': size,
        'X-Upload-Content-Type': 'video/mp4',
      },
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
    }
  );

  const location = init.headers.location;
  if (!location) throw new Error('YouTube resumable upload session URL was not returned');

  const upload = await axios.put(location, fs.createReadStream(filePath), {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': size,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 10 * 60 * 1000,
  });

  return {
    id: upload.data?.id,
    privacyStatus: privacy,
    url: upload.data?.id ? `https://www.youtube.com/watch?v=${upload.data.id}` : null,
  };
}
