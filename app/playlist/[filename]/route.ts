import { NextResponse } from 'next/server';
import path from 'path';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  
  // Basic security check
  if (!filename || filename.includes('..') || filename.includes('/')) {
    return new NextResponse('Invalid filename', { status: 400 });
  }

  try {
    // Append a cache-busting timestamp to bypass GitHub's 5-minute CDN raw content caching
    const githubUrl = `https://raw.githubusercontent.com/SHAJON-404/iptv-playlist/refs/heads/main/app/data/${filename}?t=${Date.now()}`;
    const githubResponse = await fetch(githubUrl, { cache: 'no-store' });
    
    if (!githubResponse.ok) {
      return new NextResponse('Playlist not found', { status: 404 });
    }

    const fileBuffer = await githubResponse.arrayBuffer();

    const ext = path.extname(filename).toLowerCase();
    let contentType = 'text/plain';

    if (ext === '.json') {
      contentType = 'application/json';
    } else if (ext === '.m3u' || ext === '.m3u8') {
      contentType = 'application/vnd.apple.mpegurl';
    }

    const response = new NextResponse(fileBuffer);
    response.headers.set('Content-Type', contentType);
    response.headers.set('Content-Length', fileBuffer.byteLength.toString());
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    response.headers.set('Access-Control-Allow-Origin', '*');
    
    return response;
  } catch (error) {
    console.error('Error fetching playlist file from GitHub:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

