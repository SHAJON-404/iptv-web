import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';

export const dynamic = 'force-dynamic';

const PLAYLIST_NAMES: Record<string, string> = {
  'fifa.json': 'FIFA Playlist',
  'sports.json': 'Sports Playlist',
  'channels.json': 'Universal Playlist',
  'bangla.json': 'Bangla Playlist',
};

function getPlaylistName(filename: string): string {
  if (PLAYLIST_NAMES[filename]) {
    return PLAYLIST_NAMES[filename];
  }
  const base = path.basename(filename, path.extname(filename));
  const capitalized = base.charAt(0).toUpperCase() + base.slice(1);
  return `${capitalized} Playlist`;
}

export async function GET(request: Request) {
  try {
    const dataDir = path.join(process.cwd(), 'app', 'data');
    const dirEntries = await fs.readdir(dataDir);
    
    // Filter and sort the files alphabetically
    const playlistFiles = dirEntries
      .filter((file) => file.endsWith('.json'))
      .sort();

    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
    const proto = request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '');
    const origin = host ? `${proto}://${host}` : new URL(request.url).origin;

    const availablePlaylists = playlistFiles.map((file) => {
      const name = getPlaylistName(file);
      const url = `${origin}/playlist/${file}`;
      return { name, url };
    });

    const response = NextResponse.json(availablePlaylists);
    
    // Set headers
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    response.headers.set('Access-Control-Allow-Origin', '*');
    
    return response;
  } catch (error) {
    console.error('Error reading available playlists:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
