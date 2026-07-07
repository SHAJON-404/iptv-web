import DownloadClient from "./DownloadClient";
import Link from "next/link";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  download_count: number;
}

interface ReleaseData {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  assets: GitHubAsset[];
}

export const dynamic = "force-dynamic";

async function getLatestRelease(): Promise<ReleaseData | null> {
  const secret = process.env.GITHUB_SECRETS || process.env.GITHUB_SECREST;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'IPTV-Docs-Web',
  };
  
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
  }

  try {
    // Fetch dynamically on every request without caching
    const res = await fetch('https://api.github.com/repos/SHAJON-404/iptv/releases/latest', {
      headers,
      cache: 'no-store'
    });

    if (!res.ok) {
      console.warn(`GitHub API release fetch failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    if (!data.assets || data.assets.length === 0) {
      return null;
    }

    return {
      tag_name: data.tag_name,
      name: data.name || `IPTV Player ${data.tag_name}`,
      published_at: data.published_at,
      html_url: data.html_url,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assets: data.assets.map((asset: any) => ({
        name: asset.name,
        browser_download_url: asset.browser_download_url,
        size: asset.size,
        download_count: asset.download_count,
      }))
    };
  } catch (error) {
    console.error("Error fetching release from GitHub API:", error);
    return null;
  }
}

export default async function DownloadPage() {
  const release = await getLatestRelease();

  if (!release) {
    return (
      <main className="container mx-auto px-4 sm:px-6 py-16 max-w-xl flex flex-col items-center justify-center min-h-[60vh] relative z-10 select-none animate-fade-in">
        <div className="absolute -top-12 w-64 h-64 rounded-full bg-red-500/10 blur-[80px] pointer-events-none -z-10 animate-pulse duration-[6000ms]" />
        
        <div className="w-full bg-slate-900/40 backdrop-blur-xl border border-white/15 rounded-2xl p-8 sm:p-10 text-center shadow-2xl relative overflow-hidden">
          {/* Ambient inner glow */}
          <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />
          
          <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center text-xl mx-auto mb-6 shadow-inner">
            ⚠️
          </div>
          
          <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight mb-4">
            Service Offline
          </h1>
          
          <p className="text-sm sm:text-base text-zinc-400 leading-relaxed mb-8">
            We are currently unable to retrieve the latest version information from GitHub. You can still download all releases directly from the GitHub repository.
          </p>
          
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a 
              href="https://github.com/SHAJON-404/iptv/releases" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm tracking-wide shadow-lg shadow-blue-600/20 hover:shadow-blue-500/30 transition-all duration-300 transform active:scale-95"
            >
              Go to GitHub Releases
            </a>
            <Link 
              href="/"
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-white/[0.03] border border-white/15 hover:bg-white/[0.08] hover:border-white/20 text-zinc-300 font-bold text-sm tracking-wide transition-all duration-300 text-center"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const publishDate = new Date(release.published_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return (
    <DownloadClient 
      release={release} 
      publishDate={publishDate} 
    />
  );
}
