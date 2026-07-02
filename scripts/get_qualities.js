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
  VALID: `${C.green}[+] VALID${C.reset}`,
  DEAD: `${C.red}[-] DEAD${C.reset}`,
  VPN: `${C.yellow}[!] VPN${C.reset}`,
  SKIP: `${C.dim}[>] SKIP${C.reset}`,
  DUP: `${C.dim}[~] DUP${C.reset}`,
  INFO: `${C.cyan}[i] INFO${C.reset}`,
  PROBE: `${C.magenta}[*] PROBE${C.reset}`,
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

class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.byteOffset = 0;
    this.bitOffset = 0;
  }
  
  readBit() {
    if (this.byteOffset >= this.buffer.length) return 0;
    const byte = this.buffer[this.byteOffset];
    const bit = (byte >> (7 - this.bitOffset)) & 1;
    this.bitOffset++;
    if (this.bitOffset === 8) {
      this.bitOffset = 0;
      this.byteOffset++;
    }
    return bit;
  }
  
  readBits(n) {
    let value = 0;
    for (let i = 0; i < n; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }
  
  readUE() {
    let leadingZeros = 0;
    while (this.readBit() === 0 && leadingZeros < 32) {
      leadingZeros++;
    }
    if (leadingZeros === 0) return 0;
    return ((1 << leadingZeros) - 1) + this.readBits(leadingZeros);
  }
}

function parseSPS(spsBuffer) {
  const rbsp = [];
  for (let i = 0; i < spsBuffer.length; i++) {
    if (i + 2 < spsBuffer.length && spsBuffer[i] === 0x00 && spsBuffer[i + 1] === 0x00 && spsBuffer[i + 2] === 0x03) {
      rbsp.push(0x00);
      rbsp.push(0x00);
      i += 2;
    } else {
      rbsp.push(spsBuffer[i]);
    }
  }

  const reader = new BitReader(new Uint8Array(rbsp));
  
  reader.readBit(); // forbidden_zero_bit
  reader.readBits(2); // nal_ref_idc
  const nal_unit_type = reader.readBits(5);
  
  if (nal_unit_type !== 7) return null;

  const profile_idc = reader.readBits(8);
  reader.readBits(8); // constraint_set_flags
  reader.readBits(8); // level_idc
  reader.readUE(); // seq_parameter_set_id

  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profile_idc)) {
    const chroma_format_idc = reader.readUE();
    if (chroma_format_idc === 3) {
      reader.readBit(); // separate_colour_plane_flag
    }
    reader.readUE(); // bit_depth_luma_minus8
    reader.readUE(); // bit_depth_chroma_minus8
    reader.readBit(); // qpprime_y_zero_transform_bypass_flag
    const seq_scaling_matrix_present_flag = reader.readBit();
    if (seq_scaling_matrix_present_flag) {
      const limit = (chroma_format_idc !== 3) ? 8 : 12;
      for (let i = 0; i < limit; i++) {
        const seq_scaling_list_present_flag = reader.readBit();
        if (seq_scaling_list_present_flag) {
          let lastScale = 8;
          let nextScale = 8;
          const sizeOfScalingList = i < 6 ? 16 : 64;
          for (let j = 0; j < sizeOfScalingList; j++) {
            if (nextScale !== 0) {
              const delta_scale = reader.readUE();
              nextScale = (lastScale + delta_scale + 256) % 256;
            }
            lastScale = (nextScale === 0) ? lastScale : nextScale;
          }
        }
      }
    }
  }

  reader.readUE(); // log2_max_frame_num_minus4
  const pic_order_cnt_type = reader.readUE();

  if (pic_order_cnt_type === 0) {
    reader.readUE(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pic_order_cnt_type === 1) {
    reader.readBit(); // delta_pic_order_always_zero_flag
    reader.readUE(); // offset_for_non_ref_pic
    reader.readUE(); // offset_for_top_to_bottom_field
    const num_ref_frames_in_pic_order_cnt_cycle = reader.readUE();
    for (let i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; i++) {
      reader.readUE();
    }
  }

  reader.readUE(); // max_num_ref_frames
  reader.readBit(); // gaps_in_frame_num_value_allowed_flag
  const pic_width_in_mbs_minus1 = reader.readUE();
  const pic_height_in_map_units_minus1 = reader.readUE();
  const frame_mbs_only_flag = reader.readBit();
  
  if (!frame_mbs_only_flag) {
    reader.readBit(); // mb_adaptive_frame_field_flag
  }
  reader.readBit(); // direct_8x8_inference_flag
  const frame_cropping_flag = reader.readBit();
  
  let crop_left = 0, crop_right = 0, crop_top = 0, crop_bottom = 0;
  if (frame_cropping_flag) {
    crop_left = reader.readUE();
    crop_right = reader.readUE();
    crop_top = reader.readUE();
    crop_bottom = reader.readUE();
  }

  const width = (pic_width_in_mbs_minus1 + 1) * 16 - (crop_left + crop_right) * 2;
  const height = (2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16 - (crop_top + crop_bottom) * 2;
  
  return { width, height };
}

function findSPS(buffer) {
  for (let i = 0; i < buffer.length - 4; i++) {
    if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 && buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
      const nalType = buffer[i + 4] & 0x1F;
      if (nalType === 7) {
        let end = i + 5;
        while (end < buffer.length - 3) {
          if (buffer[end] === 0x00 && buffer[end + 1] === 0x00 && (buffer[end + 2] === 0x01 || (buffer[end + 2] === 0x00 && buffer[end + 3] === 0x01))) {
            break;
          }
          end++;
        }
        return buffer.subarray(i + 4, end);
      }
    } else if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 && buffer[i + 2] === 0x01) {
      const nalType = buffer[i + 3] & 0x1F;
      if (nalType === 7) {
        let end = i + 4;
        while (end < buffer.length - 3) {
          if (buffer[end] === 0x00 && buffer[end + 1] === 0x00 && (buffer[end + 2] === 0x01 || (buffer[end + 2] === 0x00 && buffer[end + 3] === 0x01))) {
            break;
          }
          end++;
        }
        return buffer.subarray(i + 3, end);
      }
    }
  }
  return null;
}

function findMP4Resolution(buffer) {
  for (let i = 0; i < buffer.length - 8; i++) {
    if (buffer[i] === 0x74 && buffer[i + 1] === 0x6B && buffer[i + 2] === 0x68 && buffer[i + 3] === 0x64) {
      const version = buffer[i + 4];
      let width, height;
      if (version === 1) {
        if (i + 92 + 8 <= buffer.length) {
          width = (buffer[i + 92] << 8) | buffer[i + 93];
          height = (buffer[i + 96] << 8) | buffer[i + 97];
        }
      } else {
        if (i + 80 + 8 <= buffer.length) {
          width = (buffer[i + 80] << 8) | buffer[i + 81];
          height = (buffer[i + 84] << 8) | buffer[i + 85];
        }
      }
      
      if (width > 0 && height > 0 && width < 10000 && height < 10000) {
        return { width, height };
      }
    }
  }
  return null;
}

function parseResolution(buffer) {
  if (!buffer) return null;
  const mp4Res = findMP4Resolution(buffer);
  if (mp4Res) return mp4Res;
  const spsNalu = findSPS(buffer);
  if (spsNalu) {
    try {
      return parseSPS(spsNalu);
    } catch (e) {
      // ignore parsing error
    }
  }
  return null;
}

/**
 * Fetches a prefix chunk of a segment to probe reachability and extract resolution.
 */
async function fetchSegmentPrefix(url, headers, maxBytes = 262144) {
  let timedOut = false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SEGMENT_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return { buffer: null, status: response.status, error: `Segment returned HTTP ${response.status}` };
    }

    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      chunks.push(value);
      receivedBytes += value.length;
      
      if (receivedBytes >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }

    const totalBuffer = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      totalBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    return { buffer: totalBuffer, status: response.status, error: null };
  } catch (e) {
    clearTimeout(timeoutId);
    const reason = timedOut ? 'Segment probe timed out' : `Segment probe error: ${e.message}`;
    return { buffer: null, status: 0, error: reason };
  }
}

/**
 * Probes a segment URL with GET request to verify it's reachable and parse metadata.
 * Returns { reachable, status, buffer, reason }
 */
async function probeSegment(url, headers) {
  const { buffer, error, status } = await fetchSegmentPrefix(url, headers);
  if (buffer) {
    return { reachable: true, status, buffer, reason: null };
  }
  return { reachable: false, status: status || 0, buffer: null, reason: error };
}

function formatStatus(statusType) {
  switch (statusType) {
    case 'VALID': return `${C.green}VALID      ${C.reset}`;
    case 'DEAD':  return `${C.red}DEAD       ${C.reset}`;
    case 'VPN':   return `${C.yellow}VPN        ${C.reset}`;
    case 'DUP':   return `${C.dim}DUP        ${C.reset}`;
    case 'SKIP':  return `${C.dim}SKIP       ${C.reset}`;
    default:      return `${C.reset}UNK        ${C.reset}`;
  }
}

function wrapDetails(text, limit = 55) {
  if (text.includes(', ')) {
    const parts = text.split(', ');
    const lines = [];
    let current = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const segment = i === parts.length - 1 ? part : part + ',';
      if (current.length === 0) {
        current = segment;
      } else if (current.length + 1 + segment.length > limit) {
        lines.push(current);
        current = segment;
      } else {
        current += ' ' + segment;
      }
    }
    if (current) {
      lines.push(current);
    }
    return lines;
  } else {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length > limit) {
        lines.push(current);
        current = word;
      } else {
        current += ' ' + word;
      }
    }
    if (current) {
      lines.push(current);
    }
    return lines;
  }
}

function printRow(index, type, name, statusType, details) {
  const padIndex = String(index).padStart(3, '0');
  const padType = String(type).toUpperCase().padEnd(4, ' ');
  
  let cleanName = name || 'Unknown';
  if (cleanName.length > 20) {
    cleanName = cleanName.substring(0, 17) + '...';
  }
  const padName = cleanName.padEnd(20, ' ');
  const statusStr = formatStatus(statusType);
  
  const detailLines = wrapDetails(details, 60);
  if (detailLines.length === 0) {
    detailLines.push('');
  }
  
  console.log(`${padIndex} | ${padType} | ${padName} | ${statusStr} | ${detailLines[0]}`);
  
  const emptyIndex = ' '.repeat(padIndex.length);
  const emptyType = ' '.repeat(padType.length);
  const emptyName = ' '.repeat(padName.length);
  const emptyStatus = ' '.repeat(11); // plain text width of status column is 11
  
  for (let i = 1; i < detailLines.length; i++) {
    console.log(`${emptyIndex} | ${emptyType} | ${emptyName} | ${emptyStatus} | ${detailLines[i]}`);
  }
  console.log('-'.repeat(110));
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

  console.log('-'.repeat(110));
  console.log(`${C.bold}IPTV Stream Quality Checker & Playability Validator${C.reset}`);
  console.log(`${TAG.INFO} Found ${C.bold}${data.length}${C.reset} total streams in ${path.basename(filePath)}`);
  console.log('-'.repeat(110));
  console.log('Idx | Type | Name                | Status     | Quality');
  console.log('-'.repeat(110));

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

  let idx = 0;
  // ── Process Streams ─────────────────────────────────────────────────────
  for (const stream of data) {
    idx++;
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
    const streamTypeStr = isDash ? 'DASH' : isHls ? 'HLS' : 'TS';

    // ── Duplicate detection ─────────────────────────────────────────────
    const uniqueIdentifier = url.trim();

    if (seenIdentifiers.has(uniqueIdentifier)) {
      printRow(idx, streamTypeStr, stream.name, 'DUP', 'Duplicate stream URL');
      stats.duplicate++;
      continue;
    }
    seenIdentifiers.add(uniqueIdentifier);
    uniqueData.push(stream);

    // ── Unknown format ──────────────────────────────────────────────────
    if (!isDash && !isHls && !isTs) {
      printRow(idx, '???', stream.name, 'SKIP', `Unknown format: ${stream.url || 'No URL'}`);
      stats.skipped++;
      continue;
    }

    const hasVpn = stream.name && /vpn/i.test(stream.name);

    // ── TS streams: probe directly ──────────────────────────────────────
    if (isTs) {
      const headers = buildFetchHeaders(stream);
      const probe = await probeSegment(stream.url, headers);
      if (probe.reachable) {
        let resInfo = '';
        const resolution = parseResolution(probe.buffer);
        if (resolution) {
          resInfo = `${resolution.width}x${resolution.height}`;
        } else {
          resInfo = 'TS stream';
        }
        printRow(idx, 'TS', stream.name, 'VALID', resInfo);
        validStreams.push(stream);
        stats.valid++;
      } else if (hasVpn) {
        printRow(idx, 'TS', stream.name, 'VPN', `Unreachable (${probe.reason}) - VPN required`);
        validStreams.push(stream);
        stats.vpn++;
      } else {
        printRow(idx, 'TS', stream.name, 'DEAD', `TS stream unreachable: ${probe.reason}`);
        trackDead(stream, probe.reason);
      }
      continue;
    }

    // ── Fetch manifest (HLS / DASH) ─────────────────────────────────────
    const headers = buildFetchHeaders(stream);
    const { response, error: fetchError } = await fetchWithTimeout(stream.url, headers);

    if (fetchError) {
      const reason = fetchError.name === 'AbortError' ? 'Manifest fetch timed out' : `Manifest fetch error: ${fetchError.message}`;
      if (hasVpn) {
        printRow(idx, streamTypeStr, stream.name, 'VPN', `${reason} - VPN required`);
        validStreams.push(stream);
        stats.vpn++;
      } else {
        printRow(idx, streamTypeStr, stream.name, 'DEAD', reason);
        trackDead(stream, reason);
      }
      continue;
    }

    if (!response.ok) {
      const reason = `Manifest returned HTTP ${response.status} ${response.statusText}`;
      if (hasVpn) {
        printRow(idx, streamTypeStr, stream.name, 'VPN', `${reason} - VPN required`);
        validStreams.push(stream);
        stats.vpn++;
      } else {
        printRow(idx, streamTypeStr, stream.name, 'DEAD', reason);
        trackDead(stream, reason);
      }
      continue;
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';

    // ── Phase 2: Content-Type validation ────────────────────────────────
    const ctCheck = validateContentType(contentType, text.substring(0, 500), isDash);
    if (!ctCheck.valid) {
      if (hasVpn) {
        printRow(idx, streamTypeStr, stream.name, 'VPN', `${ctCheck.reason} - VPN required`);
        validStreams.push(stream);
        stats.vpn++;
      } else {
        printRow(idx, streamTypeStr, stream.name, 'DEAD', ctCheck.reason);
        trackDead(stream, ctCheck.reason);
      }
      continue;
    }

    // ── Phase 3/4: Body validation ──────────────────────────────────────
    let qualities = [];
    let probeUrl = null;

    if (isDash) {
      // DASH body validation
      const dashResult = validateDashBody(text, response.url);
      if (!dashResult.valid) {
        if (hasVpn) {
          printRow(idx, 'DASH', stream.name, 'VPN', `${dashResult.reason} - VPN required`);
          validStreams.push(stream);
          stats.vpn++;
        } else {
          printRow(idx, 'DASH', stream.name, 'DEAD', dashResult.reason);
          trackDead(stream, dashResult.reason);
        }
        continue;
      }

      qualities = extractDashQualities(text);
      probeUrl = dashResult.initSegmentUrl;
    } else {
      // HLS body validation
      const hlsResult = validateHlsBody(text, response.url);
      if (!hlsResult.valid) {
        if (hasVpn) {
          printRow(idx, 'HLS', stream.name, 'VPN', `${hlsResult.reason} - VPN required`);
          validStreams.push(stream);
          stats.vpn++;
        } else {
          printRow(idx, 'HLS', stream.name, 'DEAD', hlsResult.reason);
          trackDead(stream, hlsResult.reason);
        }
        continue;
      }

      qualities = extractHlsQualities(text);

      if (hlsResult.isMaster && hlsResult.childUrls.length > 0) {
        const childUrl = hlsResult.childUrls[0];
        const { response: childResponse, error: childError } = await fetchWithTimeout(childUrl, headers, SEGMENT_PROBE_TIMEOUT_MS);

        if (childError || !childResponse || !childResponse.ok) {
          const reason = childError
            ? (childError.name === 'AbortError' ? 'Child playlist timed out' : `Child playlist error: ${childError.message}`)
            : `Child playlist returned HTTP ${childResponse?.status || 'unknown'}`;

          if (hasVpn) {
            printRow(idx, 'HLS', stream.name, 'VPN', `${reason} - VPN required`);
            validStreams.push(stream);
            stats.vpn++;
            continue;
          } else {
            printRow(idx, 'HLS', stream.name, 'DEAD', reason);
            trackDead(stream, reason);
            continue;
          }
        }

        const childText = await childResponse.text();
        const childHlsResult = validateHlsBody(childText, childResponse.url);

        if (!childHlsResult.valid) {
          if (hasVpn) {
            printRow(idx, 'HLS', stream.name, 'VPN', `Child playlist invalid: ${childHlsResult.reason} - VPN required`);
            validStreams.push(stream);
            stats.vpn++;
            continue;
          } else {
            printRow(idx, 'HLS', stream.name, 'DEAD', `Child playlist invalid: ${childHlsResult.reason}`);
            trackDead(stream, `Child playlist invalid: ${childHlsResult.reason}`);
            continue;
          }
        }

        if (childHlsResult.segmentUrls.length > 0) {
          probeUrl = childHlsResult.segmentUrls[0];
        }
      } else if (!hlsResult.isMaster && hlsResult.segmentUrls.length > 0) {
        probeUrl = hlsResult.segmentUrls[0];
      }
    }

    // ── Segment probe ───────────────────────────────────────────────────
    let parsedRes = null;
    let segmentReachable = true;
    let segmentError = '';
    if (probeUrl) {
      const segmentProbe = await probeSegment(probeUrl, headers);

      if (!segmentProbe.reachable) {
        segmentReachable = false;
        segmentError = segmentProbe.reason;
      } else {
        parsedRes = parseResolution(segmentProbe.buffer);
      }
    }

    if (!segmentReachable) {
      if (hasVpn) {
        printRow(idx, streamTypeStr, stream.name, 'VPN', `Segment unreachable: ${segmentError} - VPN required`);
        validStreams.push(stream);
        stats.vpn++;
      } else {
        printRow(idx, streamTypeStr, stream.name, 'DEAD', `Segment unreachable: ${segmentError}`);
        trackDead(stream, `Segment unreachable: ${segmentError}`);
      }
      continue;
    }

    // ── Stream is VALID ─────────────────────────────────────────────────
    let details = '';
    if (qualities.length > 0) {
      details = qualities.map(q => q.label).join(', ');
    } else if (isDash) {
      details = 'DASH stream (no height info in MPD)';
    } else {
      details = parsedRes ? `${parsedRes.width}x${parsedRes.height}` : 'Single quality stream';
    }

    printRow(idx, streamTypeStr, stream.name, 'VALID', details);
    validStreams.push(stream);
    stats.valid++;
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
    console.log(`${TAG.INFO} Saved ${C.bold}${validStreams.length}${C.reset} valid streams to ${outputFilePath}`);
  } catch (err) {
    console.error(`[-] Failed to write valid streams to ${outputFilePath}:`, err);
  }



  // ── Summary Report ────────────────────────────────────────────────────
  console.log('-'.repeat(110));
  console.log(`${C.bold}Summary Report${C.reset}`);
  console.log('-'.repeat(110));
  console.log(`  [+] VALID:     ${stats.valid}`);
  console.log(`  [-] DEAD:      ${stats.dead}`);
  console.log(`  [!] VPN:       ${stats.vpn}`);
  console.log(`  [~] DUPLICATE: ${stats.duplicate}`);
  console.log(`  [>] SKIPPED:   ${stats.skipped}`);
  console.log('-'.repeat(110));
  console.log(`  Total Input:   ${data.length}`);
  console.log(`  Output:        ${validStreams.length} streams`);

  if (Object.keys(deadReasons).length > 0) {
    console.log('-'.repeat(110));
    console.log(`${C.red}${C.bold}Dead Stream Reasons:${C.reset}`);
    const sortedReasons = Object.entries(deadReasons).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sortedReasons) {
      console.log(`  ${count}x ${reason}`);
    }
  }

  console.log('-'.repeat(110));
  process.exit(0);
}

getStreamQualities();
