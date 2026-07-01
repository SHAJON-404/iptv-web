/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs/promises');
const path = require('path');

// ─── ANSI Colors ────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

// ─── Status Tags ────────────────────────────────────────────────────────────
const TAG = {
  VALID: `${C.green}[✅ VALID]${C.reset}`,
  DEAD: `${C.red}[❌ DEAD]${C.reset}`,
  VPN: `${C.yellow}[⚠️  VPN]${C.reset}`,
  SKIP: `${C.dim}[⏭️  SKIP]${C.reset}`,
  DUP: `${C.dim}[🔄 DUP]${C.reset}`,
  INFO: `${C.cyan}[ℹ️  INFO]${C.reset}`,
  PROBE: `${C.magenta}[🔍 PROBE]${C.reset}`,
};

// ─── Constants ──────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 10000;
const SEGMENT_PROBE_TIMEOUT_MS = 6000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Formats bandwidth into a human-readable Mbps string.
 * @param {string|number} bandwidthBps Bandwidth in bits per second
 * @returns {string} Formatted bandwidth string
 */
function formatBandwidth(bandwidthBps) {
  if (!bandwidthBps) return '';
  const bps = parseInt(bandwidthBps, 10);
  const mbps = (bps / 1000000).toFixed(2);
  let mbpsStr = mbps;
  if (mbps.endsWith('.00')) {
    mbpsStr = mbps.slice(0, -3);
  } else if (mbps.endsWith('0')) {
    mbpsStr = mbps.slice(0, -1);
  }
  return ` (${mbpsStr} Mbps)`;
}

/**
 * Resolves a relative URL against a base URL.
 */
function resolveUrl(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

/**
 * Builds fetch headers from stream properties — mirrors what the IPTV proxy sends.
 * Forwards referer, origin, user-agent, x-playback-session-id, and any other custom headers.
 */
function buildFetchHeaders(stream) {
  const headers = {
    'User-Agent': stream['user-agent'] || DEFAULT_USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
  };

  if (stream.referer) {
    try {
      const parsedReferer = new URL(stream.referer);
      headers['Referer'] = parsedReferer.origin + '/';
      // Use custom origin if provided, otherwise derive from referer
      headers['Origin'] = stream.origin || parsedReferer.origin;
    } catch { /* invalid referer URL, skip */ }
  } else if (stream.origin) {
    headers['Origin'] = stream.origin;
  }

  // Forward any extra custom headers the stream might need
  if (stream['x-playback-session-id']) {
    headers['X-Playback-Session-Id'] = stream['x-playback-session-id'];
  }

  return headers;
}

/**
 * Fetches a URL with timeout and custom headers. Returns { response, error }.
 */
async function fetchWithTimeout(url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);
    return { response, error: null };
  } catch (e) {
    clearTimeout(timeoutId);
    return { response: null, error: e };
  }
}

/**
 * Validates response Content-Type against expected stream type.
 * Returns { valid, reason } — reason is set when invalid.
 */
function validateContentType(contentType, bodyPrefix, isDash) {
  const ct = (contentType || '').toLowerCase();

  // Reject obvious HTML error pages returned with 200
  if (ct.includes('text/html')) {
    // Some CDNs serve m3u8 as text/html — check body prefix as fallback
    const trimmedBody = bodyPrefix.replace(/^\uFEFF/, '').trim();
    if (isDash) {
      if (trimmedBody.startsWith('<?xml') || trimmedBody.startsWith('<MPD')) {
        return { valid: true, reason: null };
      }
    } else {
      if (trimmedBody.startsWith('#EXTM3U') || trimmedBody.startsWith('#EXT')) {
        return { valid: true, reason: null };
      }
    }
    return { valid: false, reason: 'Response is HTML error page (Content-Type: text/html, body is not a valid manifest)' };
  }

  // Validate body starts with expected manifest prefix
  const trimmedBody = bodyPrefix.replace(/^\uFEFF/, '').trim();
  if (isDash) {
    if (!trimmedBody.startsWith('<?xml') && !trimmedBody.startsWith('<MPD') && !trimmedBody.includes('<MPD')) {
      return { valid: false, reason: 'DASH response body does not contain a valid MPD manifest' };
    }
  } else {
    // HLS
    if (!trimmedBody.startsWith('#EXTM3U') && !trimmedBody.startsWith('#EXT')) {
      // Check if it's JSON or plaintext garbage
      if (trimmedBody.startsWith('{') || trimmedBody.startsWith('[') || trimmedBody.startsWith('<')) {
        return { valid: false, reason: `HLS response body is not a valid M3U8 manifest (starts with: ${trimmedBody.substring(0, 20)}...)` };
      }
      return { valid: false, reason: 'HLS response body does not start with #EXTM3U' };
    }
  }

  return { valid: true, reason: null };
}

/**
 * Validates HLS manifest body for actual playable content.
 * Returns { valid, isMaster, childUrls, segmentUrls, reason }
 */
function validateHlsBody(text, manifestUrl) {
  const lines = text.split(/\r?\n/);
  const streamInfLines = [];
  const childUrls = [];
  const segmentUrls = [];
  let hasStreamInf = false;
  let hasExtinf = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      hasStreamInf = true;
      streamInfLines.push(line);
      // Next non-empty, non-comment line should be the child playlist URL
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith('#')) {
          childUrls.push(resolveUrl(nextLine, manifestUrl));
          break;
        }
      }
    }

    if (line.startsWith('#EXTINF:')) {
      hasExtinf = true;
      // Next non-empty, non-comment line should be a segment URL
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith('#')) {
          segmentUrls.push(resolveUrl(nextLine, manifestUrl));
          break;
        }
      }
    }
  }

  if (hasStreamInf) {
    // Master playlist
    if (childUrls.length === 0) {
      return { valid: false, isMaster: true, childUrls, segmentUrls, reason: 'Master playlist has #EXT-X-STREAM-INF but no child playlist URLs' };
    }
    return { valid: true, isMaster: true, childUrls, segmentUrls, reason: null };
  }

  if (hasExtinf) {
    // Media playlist
    if (segmentUrls.length === 0) {
      return { valid: false, isMaster: false, childUrls, segmentUrls, reason: 'Media playlist has #EXTINF but no segment URLs' };
    }
    return { valid: true, isMaster: false, childUrls, segmentUrls, reason: null };
  }

  // No STREAM-INF and no EXTINF — could be an empty or audio-only playlist
  // Check if it has any meaningful content at all
  const hasEndList = text.includes('#EXT-X-ENDLIST');
  const hasTargetDuration = text.includes('#EXT-X-TARGETDURATION');
  if (hasTargetDuration && !hasExtinf) {
    return { valid: false, isMaster: false, childUrls, segmentUrls, reason: 'Media playlist has TARGETDURATION but no segments (#EXTINF)' };
  }

  if (hasEndList && !hasExtinf && !hasStreamInf) {
    return { valid: false, isMaster: false, childUrls, segmentUrls, reason: 'Playlist has ENDLIST but no playable content' };
  }

  return { valid: false, isMaster: false, childUrls, segmentUrls, reason: 'Manifest has no playable content (no #EXT-X-STREAM-INF or #EXTINF found)' };
}

/**
 * Validates DASH MPD manifest body for actual playable content.
 * Returns { valid, initSegmentUrl, reason }
 */
function validateDashBody(text, manifestUrl) {
  // Check for Representation tags with height (video tracks)
  const representationRegex = /<Representation[^>]+>/g;
  const heightRegex = /height="(\d+)"/;
  let hasVideoRepresentation = false;
  let match;

  while ((match = representationRegex.exec(text)) !== null) {
    const repStr = match[0];
    if (heightRegex.test(repStr)) {
      hasVideoRepresentation = true;
      break;
    }
  }

  // Even without height, check if there's any Representation at all (audio-only streams can still play)
  if (!hasVideoRepresentation && !/<Representation/i.test(text)) {
    return { valid: false, initSegmentUrl: null, reason: 'MPD has no <Representation> elements' };
  }

  // Check for segment delivery mechanism
  const hasSegmentTemplate = /<SegmentTemplate/i.test(text);
  const hasSegmentList = /<SegmentList/i.test(text);
  const hasSegmentBase = /<SegmentBase/i.test(text);
  const hasBaseUrl = /<BaseURL/i.test(text);

  if (!hasSegmentTemplate && !hasSegmentList && !hasSegmentBase && !hasBaseUrl) {
    return { valid: false, initSegmentUrl: null, reason: 'MPD has no segment delivery mechanism (SegmentTemplate/SegmentList/SegmentBase/BaseURL)' };
  }

  // Try to resolve the init segment URL for probing
  let initSegmentUrl = null;
  if (hasSegmentTemplate) {
    const initMatch = text.match(/<SegmentTemplate[^>]*initialization="([^"]+)"/i);
    if (initMatch) {
      // Resolve the init URL template — replace $RepresentationID$ etc. with a dummy to test reachability
      let initTemplate = initMatch[1];
      // Extract a real representation ID if possible
      const repIdMatch = text.match(/<Representation[^>]*id="([^"]+)"/i);
      if (repIdMatch) {
        initTemplate = initTemplate.replace(/\$RepresentationID\$/g, repIdMatch[1]);
      }
      initTemplate = initTemplate.replace(/\$Bandwidth\$/g, '0');
      initTemplate = initTemplate.replace(/\$Number[^$]*\$/g, '0');

      // Resolve base URL hierarchy
      let baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
      const mpdBaseMatch = text.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);
      if (mpdBaseMatch) {
        baseUrl = resolveUrl(mpdBaseMatch[1].trim(), baseUrl);
      }
      initSegmentUrl = resolveUrl(initTemplate, baseUrl);
    }
  }

  return { valid: true, initSegmentUrl, reason: null };
}

/**
 * Probes a segment URL with HEAD request to verify it's reachable.
 * Returns { reachable, status, reason }
 */
async function probeSegment(url, headers) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEGMENT_PROBE_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'HEAD',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);

    if (response.ok || response.status === 206) {
      return { reachable: true, status: response.status, reason: null };
    }

    // Fallback: some servers block HEAD, try GET with Range
    if (response.status === 405 || response.status === 403) {
      const controller2 = new AbortController();
      const timeoutId2 = setTimeout(() => controller2.abort(), SEGMENT_PROBE_TIMEOUT_MS);
      const getResponse = await fetch(url, {
        method: 'GET',
        headers: { ...headers, 'Range': 'bytes=0-0' },
        signal: controller2.signal,
        redirect: 'follow',
      });
      clearTimeout(timeoutId2);

      // Consume the body to release network resources
      await getResponse.text().catch(() => {});

      if (getResponse.ok || getResponse.status === 206) {
        return { reachable: true, status: getResponse.status, reason: null };
      }
      return { reachable: false, status: getResponse.status, reason: `Segment returned HTTP ${getResponse.status}` };
    }

    return { reachable: false, status: response.status, reason: `Segment returned HTTP ${response.status}` };
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'Segment probe timed out' : `Segment probe error: ${e.message}`;
    return { reachable: false, status: 0, reason };
  }
}

/**
 * Extracts quality information from HLS manifest text.
 */
function extractHlsQualities(text) {
  const qualities = [];
  const streamInfRegex = /#EXT-X-STREAM-INF:([^]+?)(?=\n[^#]|$)/g;
  let match;

  while ((match = streamInfRegex.exec(text)) !== null) {
    const attributesStr = match[1];
    const resMatch = attributesStr.match(/RESOLUTION=(\d+x\d+)/);
    const bwMatch = attributesStr.match(/BANDWIDTH=(\d+)/);

    if (resMatch) {
      const height = parseInt(resMatch[1].split('x')[1], 10);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      if (!qualities.some(q => q.height === height && q.bandwidth === bandwidth)) {
        const bwInfo = bandwidth ? formatBandwidth(bandwidth) : '';
        qualities.push({ height, bandwidth, label: `${height}p${bwInfo}` });
      }
    } else if (bwMatch) {
      const bandwidth = parseInt(bwMatch[1], 10);
      if (!qualities.some(q => q.height === 0 && q.bandwidth === bandwidth)) {
        qualities.push({ height: 0, bandwidth, label: `Unknown Res${formatBandwidth(bandwidth)}` });
      }
    }
  }

  qualities.sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return b.bandwidth - a.bandwidth;
  });

  return qualities;
}

/**
 * Extracts quality information from DASH MPD text.
 */
function extractDashQualities(text) {
  const qualities = [];
  const representationRegex = /<Representation[^>]+>/g;
  const heightRegex = /height="(\d+)"/;
  const bandwidthRegex = /bandwidth="(\d+)"/;
  let match;

  while ((match = representationRegex.exec(text)) !== null) {
    const repStr = match[0];
    const heightMatch = repStr.match(heightRegex);
    if (heightMatch) {
      const height = parseInt(heightMatch[1], 10);
      const bwMatch = repStr.match(bandwidthRegex);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      if (!qualities.some(q => q.height === height && q.bandwidth === bandwidth)) {
        const bwInfo = bandwidth ? formatBandwidth(bandwidth) : '';
        qualities.push({ height, bandwidth, label: `${height}p${bwInfo}` });
      }
    }
  }

  qualities.sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return b.bandwidth - a.bandwidth;
  });

  return qualities;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function getStreamQualities() {
  const filePathArg = process.argv[2];
  const outputFilePathArg = process.argv[3];
  if (!filePathArg) {
    console.error('[-] Usage: node scripts/get_qualities.js <input-path> [output-path]');
    process.exit(1);
  }

  const filePath = path.resolve(filePathArg);

  // ── Parse Input ─────────────────────────────────────────────────────────
  let data = [];
  try {
    const ext = path.extname(filePath).toLowerCase();
    const fileContent = await fs.readFile(filePath, 'utf8');

    if (ext === '.json') {
      data = JSON.parse(fileContent);
    } else if (ext === '.m3u' || ext === '.m3u8') {
      const lines = fileContent.split(/\r?\n/);
      let currentName = '';
      for (const line of lines) {
        if (line.startsWith('#EXTINF:')) {
          const commaIndex = line.lastIndexOf(',');
          currentName = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : 'Unknown';
        } else if (line.trim() && !line.startsWith('#')) {
          data.push({ name: currentName || 'Unknown', url: line.trim() });
          currentName = '';
        }
      }
    } else {
      console.error('[-] Error: Unsupported file format. Please provide a .json or .m3u file.');
      process.exit(1);
    }
  } catch (e) {
    console.error(`[-] Error: Failed to read or parse file at ${filePath}:`, e);
    return;
  }

  console.log('\n' + '═'.repeat(80));
  console.log(`${C.bold}  IPTV Stream Quality Checker & Playability Validator${C.reset}`);
  console.log('═'.repeat(80));
  console.log(`${TAG.INFO} Found ${C.bold}${data.length}${C.reset} total streams in ${path.basename(filePath)}\n`);

  // ── Tracking ────────────────────────────────────────────────────────────
  const validStreams = [];
  const deadStreams = [];
  const seenIdentifiers = new Set();
  const uniqueData = [];
  const stats = { valid: 0, dead: 0, vpn: 0, duplicate: 0, skipped: 0 };
  const deadReasons = {};

  function trackDead(stream, reason) {
    deadStreams.push({ ...stream, _deadReason: reason });
    stats.dead++;
    deadReasons[reason] = (deadReasons[reason] || 0) + 1;
  }

  // ── Process Streams ─────────────────────────────────────────────────────
  for (const stream of data) {
    const url = stream.url || stream.link;
    if (!url) continue;
    if (!stream.url) stream.url = url;

    // ── Normalize proxy flags ───────────────────────────────────────────
    if (stream.no_proxy !== undefined) {
      if (stream.useProxy === undefined) {
        stream.useProxy = !stream.no_proxy;
      }
      delete stream.no_proxy;
    }

    if (stream.useProxy === undefined) {
      stream.useProxy = !!stream.referer;
    } else if (stream.referer && stream.useProxy === false) {
      stream.useProxy = true;
    }

    // ── Detect stream type ──────────────────────────────────────────────
    // Strip query params for reliable extension detection
    const cleanUrl = (stream.url || '').split(/[?#]/)[0].toLowerCase();
    const isDash = stream.type === 'dash' || cleanUrl.endsWith('.mpd');
    const isHls = !isDash && (stream.type === 'hls' || cleanUrl.endsWith('.m3u8') || cleanUrl.endsWith('.m3u'));
    const isTs = !isDash && !isHls && (cleanUrl.endsWith('.ts') || stream.type === 'ts');

    // ── Duplicate detection ─────────────────────────────────────────────
    let uniqueIdentifier = url.trim();
    if (isDash && stream.kid && stream.key) {
      uniqueIdentifier = `DASH_${stream.kid.trim()}_${stream.key.trim()}`;
    }

    if (seenIdentifiers.has(uniqueIdentifier)) {
      console.log(`${TAG.DUP} ${stream.name}`);
      console.log('-'.repeat(80));
      stats.duplicate++;
      continue;
    }
    seenIdentifiers.add(uniqueIdentifier);
    uniqueData.push(stream);

    // ── Unknown format ──────────────────────────────────────────────────
    if (!isDash && !isHls && !isTs) {
      console.log(`${TAG.SKIP} Unknown format for ${C.bold}${stream.name}${C.reset}: ${stream.url || 'No URL'}`);
      console.log('-'.repeat(80));
      stats.skipped++;
      continue;
    }

    const streamTypeStr = isDash ? 'DASH' : isHls ? 'HLS' : 'TS';
    console.log(`${TAG.INFO} Checking ${C.bold}${streamTypeStr}${C.reset}: ${stream.name}`);

    const hasVpn = stream.name && /vpn/i.test(stream.name);
    if (hasVpn) {
      console.log(`  ${C.yellow}⚠ VPN Required — will keep even if validation fails${C.reset}`);
    }

    // ── TS streams: probe directly ──────────────────────────────────────
    if (isTs) {
      const headers = buildFetchHeaders(stream);
      const probe = await probeSegment(stream.url, headers);
      if (probe.reachable) {
        console.log(`${TAG.VALID} Direct TS stream is reachable (HTTP ${probe.status})`);
        validStreams.push(stream);
        stats.valid++;
      } else if (hasVpn) {
        console.log(`${TAG.VPN} TS stream unreachable (${probe.reason}) — keeping as VPN stream`);
        validStreams.push(stream);
        stats.vpn++;
      } else {
        console.log(`${TAG.DEAD} TS stream unreachable: ${probe.reason}`);
        trackDead(stream, probe.reason);
      }
      console.log('-'.repeat(80));
      continue;
    }

    // ── Fetch manifest (HLS / DASH) ─────────────────────────────────────
    const headers = buildFetchHeaders(stream);
    const { response, error: fetchError } = await fetchWithTimeout(stream.url, headers);

    if (fetchError) {
      const reason = fetchError.name === 'AbortError' ? 'Manifest fetch timed out' : `Manifest fetch error: ${fetchError.message}`;
      if (hasVpn) {
        console.log(`${TAG.VPN} ${reason} — keeping as VPN stream`);
        validStreams.push(stream);
        stats.vpn++;
      } else {
        console.log(`${TAG.DEAD} ${reason}`);
        trackDead(stream, reason);
      }
      console.log('-'.repeat(80));
      continue;
    }

    if (!response.ok) {
      const reason = `Manifest returned HTTP ${response.status} ${response.statusText}`;
      if (hasVpn) {
        console.log(`${TAG.VPN} ${reason} — keeping as VPN stream`);
        validStreams.push(stream);
        stats.vpn++;
      } else {
        console.log(`${TAG.DEAD} ${reason}`);
        trackDead(stream, reason);
      }
      console.log('-'.repeat(80));
      continue;
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';

    // ── Phase 2: Content-Type validation ────────────────────────────────
    const ctCheck = validateContentType(contentType, text.substring(0, 500), isDash);
    if (!ctCheck.valid) {
      if (hasVpn) {
        console.log(`${TAG.VPN} ${ctCheck.reason} — keeping as VPN stream`);
        validStreams.push(stream);
        stats.vpn++;
      } else {
        console.log(`${TAG.DEAD} ${ctCheck.reason}`);
        trackDead(stream, ctCheck.reason);
      }
      console.log('-'.repeat(80));
      continue;
    }

    // ── Phase 3/4: Body validation ──────────────────────────────────────
    let qualities = [];
    let probeUrl = null;

    if (isDash) {
      // DASH body validation
      const dashResult = validateDashBody(text, stream.url);
      if (!dashResult.valid) {
        if (hasVpn) {
          console.log(`${TAG.VPN} ${dashResult.reason} — keeping as VPN stream`);
          validStreams.push(stream);
          stats.vpn++;
        } else {
          console.log(`${TAG.DEAD} ${dashResult.reason}`);
          trackDead(stream, dashResult.reason);
        }
        console.log('-'.repeat(80));
        continue;
      }

      qualities = extractDashQualities(text);
      probeUrl = dashResult.initSegmentUrl;
    } else {
      // HLS body validation
      const hlsResult = validateHlsBody(text, stream.url);
      if (!hlsResult.valid) {
        if (hasVpn) {
          console.log(`${TAG.VPN} ${hlsResult.reason} — keeping as VPN stream`);
          validStreams.push(stream);
          stats.vpn++;
        } else {
          console.log(`${TAG.DEAD} ${hlsResult.reason}`);
          trackDead(stream, hlsResult.reason);
        }
        console.log('-'.repeat(80));
        continue;
      }

      qualities = extractHlsQualities(text);

      if (hlsResult.isMaster && hlsResult.childUrls.length > 0) {
        // Probe: fetch first child playlist to verify it's reachable and has segments
        const childUrl = hlsResult.childUrls[0];
        console.log(`${TAG.PROBE} Probing child playlist: ${childUrl.substring(0, 80)}...`);
        const { response: childResponse, error: childError } = await fetchWithTimeout(childUrl, headers, SEGMENT_PROBE_TIMEOUT_MS);

        if (childError || !childResponse || !childResponse.ok) {
          const reason = childError
            ? (childError.name === 'AbortError' ? 'Child playlist timed out' : `Child playlist error: ${childError.message}`)
            : `Child playlist returned HTTP ${childResponse?.status || 'unknown'}`;

          if (hasVpn) {
            console.log(`${TAG.VPN} ${reason} — keeping as VPN stream`);
            validStreams.push(stream);
            stats.vpn++;
            console.log('-'.repeat(80));
            continue;
          } else {
            console.log(`${TAG.DEAD} ${reason}`);
            trackDead(stream, reason);
            console.log('-'.repeat(80));
            continue;
          }
        }

        const childText = await childResponse.text();
        const childHlsResult = validateHlsBody(childText, childUrl);

        if (!childHlsResult.valid) {
          if (hasVpn) {
            console.log(`${TAG.VPN} Child playlist invalid: ${childHlsResult.reason} — keeping as VPN stream`);
            validStreams.push(stream);
            stats.vpn++;
            console.log('-'.repeat(80));
            continue;
          } else {
            console.log(`${TAG.DEAD} Child playlist invalid: ${childHlsResult.reason}`);
            trackDead(stream, `Child playlist invalid: ${childHlsResult.reason}`);
            console.log('-'.repeat(80));
            continue;
          }
        }

        // Probe the first segment from the child playlist
        if (childHlsResult.segmentUrls.length > 0) {
          probeUrl = childHlsResult.segmentUrls[0];
        }
      } else if (!hlsResult.isMaster && hlsResult.segmentUrls.length > 0) {
        // Single-quality media playlist — probe first segment directly
        probeUrl = hlsResult.segmentUrls[0];
      }
    }

    // ── Segment probe ───────────────────────────────────────────────────
    if (probeUrl) {
      console.log(`${TAG.PROBE} Probing segment: ${probeUrl.substring(0, 80)}...`);
      const segmentProbe = await probeSegment(probeUrl, headers);

      if (!segmentProbe.reachable) {
        if (hasVpn) {
          console.log(`${TAG.VPN} Segment unreachable: ${segmentProbe.reason} — keeping as VPN stream`);
          validStreams.push(stream);
          stats.vpn++;
        } else {
          console.log(`${TAG.DEAD} Segment unreachable: ${segmentProbe.reason}`);
          trackDead(stream, `Segment unreachable: ${segmentProbe.reason}`);
        }
        console.log('-'.repeat(80));
        continue;
      }
      console.log(`  ${C.green}✓ Segment reachable (HTTP ${segmentProbe.status})${C.reset}`);
    }

    // ── Stream is VALID ─────────────────────────────────────────────────
    if (qualities.length > 0) {
      console.log(`${TAG.VALID} Qualities: ${qualities.map(q => q.label).join(', ')}`);
    } else if (isDash) {
      console.log(`${TAG.VALID} DASH stream (no height info in MPD)`);
    } else {
      console.log(`${TAG.VALID} Single quality stream`);
    }

    validStreams.push(stream);
    stats.valid++;
    console.log('-'.repeat(80));
  }

  // ── Deduplicate original file ─────────────────────────────────────────
  if (stats.duplicate > 0) {
    console.log(`\n${TAG.INFO} Removing ${stats.duplicate} duplicates from original input file: ${filePath}`);
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.json') {
        await fs.writeFile(filePath, JSON.stringify(uniqueData, null, 4), 'utf8');
      } else if (ext === '.m3u' || ext === '.m3u8') {
        const m3uContent = ['#EXTM3U'];
        for (const item of uniqueData) {
          m3uContent.push(`#EXTINF:-1,${item.name}`);
          m3uContent.push(item.url);
        }
        await fs.writeFile(filePath, m3uContent.join('\n'), 'utf8');
      }
    } catch (err) {
      console.error(`[-] Failed to update original file:`, err);
    }
  }

  // ── Save valid streams ────────────────────────────────────────────────
  const outputFilePath = outputFilePathArg ? path.resolve(outputFilePathArg) : path.resolve('app/data/fifa.json');
  try {
    await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
    await fs.writeFile(outputFilePath, JSON.stringify(validStreams, null, 4), 'utf8');
    console.log(`\n${TAG.INFO} Saved ${C.bold}${validStreams.length}${C.reset} valid streams to ${outputFilePath}`);
  } catch (err) {
    console.error(`[-] Failed to write valid streams to ${outputFilePath}:`, err);
  }



  // ── Summary Report ────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log(`${C.bold}  Summary Report${C.reset}`);
  console.log('═'.repeat(80));
  console.log(`  ${C.green}✅ VALID:${C.reset}     ${stats.valid}`);
  console.log(`  ${C.red}❌ DEAD:${C.reset}      ${stats.dead}`);
  console.log(`  ${C.yellow}⚠️  VPN:${C.reset}       ${stats.vpn}`);
  console.log(`  ${C.dim}🔄 DUPLICATE:${C.reset} ${stats.duplicate}`);
  console.log(`  ${C.dim}⏭️  SKIPPED:${C.reset}  ${stats.skipped}`);
  console.log('─'.repeat(80));
  console.log(`  ${C.bold}Total Input:${C.reset}  ${data.length}`);
  console.log(`  ${C.bold}Output:${C.reset}       ${validStreams.length} streams`);

  if (Object.keys(deadReasons).length > 0) {
    console.log(`\n  ${C.red}${C.bold}Dead Stream Reasons:${C.reset}`);
    const sortedReasons = Object.entries(deadReasons).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sortedReasons) {
      console.log(`    ${count}x ${reason}`);
    }
  }

  console.log('═'.repeat(80) + '\n');
}

getStreamQualities();
