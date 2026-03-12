#!/usr/bin/env node

const { chromium, devices } = require('playwright');
const { PNG } = require('pngjs');
const { ssim } = require('ssim.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) parsed.url = args[++i];
    else if (args[i] === '--project-name' && args[i + 1]) parsed.projectName = args[++i];
    else if (args[i] === '--mode' && args[i + 1]) parsed.mode = args[++i];
    else if (args[i] === '--threshold' && args[i + 1]) parsed.threshold = parseFloat(args[++i]);
    else if (args[i] === '--depth' && args[i + 1]) parsed.depth = parseInt(args[++i], 10);
    else if (args[i] === '--headed') parsed.headed = true;
  }

  if (!parsed.projectName || !parsed.mode) {
    console.error('Usage: node index.js --url <url> --project-name <name> --mode <baseline|test|testdiffalg> [--threshold <score>] [--depth <number>] [--headed]');
    process.exit(1);
  }
  if (!['baseline', 'test', 'testdiffalg'].includes(parsed.mode)) {
    console.error('Error: --mode must be "baseline", "test", or "testdiffalg"');
    process.exit(1);
  }
  if (['baseline', 'test'].includes(parsed.mode) && !parsed.url) {
    console.error('Error: --url is required for baseline and test modes');
    process.exit(1);
  }

  // Defaults: 0.95 SSIM threshold (1.0 = identical), depth 2
  if (parsed.threshold === undefined || isNaN(parsed.threshold)) parsed.threshold = 0.95;
  if (parsed.depth === undefined || isNaN(parsed.depth)) parsed.depth = 2;

  // Ensure correct types (guards against string pass-through)
  parsed.threshold = Number(parsed.threshold);
  parsed.depth = Math.floor(Number(parsed.depth));

  return parsed;
}

// ---------------------------------------------------------------------------
// Cookie Banner Dismissal
// ---------------------------------------------------------------------------

const DEFAULT_COOKIE_SELECTORS = [
  '#accept-cookies',
  '.cookie-button',
  '#cookie-accept',
  '#onetrust-accept-btn-handler',
  '.cc-accept',
  '.cc-btn.cc-dismiss',
  '[data-testid="cookie-accept"]',
  '[aria-label="Accept cookies"]',
  'button[id*="cookie" i][id*="accept" i]',
  'button[class*="cookie" i][class*="accept" i]',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '.js-cookie-consent-agree',
];

function loadProjectCookieSelectors(projectDir) {
  const configPath = path.join(projectDir, 'cookie-selectors.json');
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return Array.isArray(data) ? data : [];
    } catch {
      console.warn(`Warning: Could not parse ${configPath}, using defaults only.`);
    }
  }
  return [];
}

async function dismissCookieBanners(page, extraSelectors = []) {
  const selectors = [...DEFAULT_COOKIE_SELECTORS, ...extraSelectors];
  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el && await el.isVisible()) {
        await el.click();
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // Selector not found or not clickable — continue
    }
  }
}

// ---------------------------------------------------------------------------
// Crawler — finds internal links up to depth 2
// ---------------------------------------------------------------------------

// File extensions to skip — these are not HTML pages
const SKIP_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.mp4', '.mp3', '.avi', '.mov', '.webm', '.ogg', '.wav',
  '.zip', '.rar', '.gz', '.tar', '.7z',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
  '.xml', '.json', '.txt', '.rtf',
  '.woff', '.woff2', '.ttf', '.eot',
  '.js', '.css', '.map',
]);

function isFilePath(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext && SKIP_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

async function crawl(page, baseUrl, maxDepth = 2) {
  const base = new URL(baseUrl);
  const visited = new Set();
  const toVisit = [{ url: normalizeUrl(baseUrl), depth: 0 }];
  const results = []; // { url, status }
  const brokenLinks = [];

  while (toVisit.length > 0) {
    const { url, depth } = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let status;
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(10000);
      status = response ? response.status() : 0;
    } catch (err) {
      status = 0;
      console.warn(`  ⚠ Failed to load: ${url} — ${err.message}`);
    }

    results.push({ url, status });

    if (status !== 200) {
      brokenLinks.push({ url, status });
      continue;
    }

    if (depth < maxDepth) {
      const links = await extractInternalLinks(page, base);
      for (const link of links) {
        if (!visited.has(link)) {
          toVisit.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }

  return { pages: results.filter((r) => r.status === 200), brokenLinks };
}

async function extractInternalLinks(page, base) {
  const hrefs = await page.$$eval('a[href]', (anchors) =>
    anchors.map((a) => a.href)
  );

  const links = new Set();
  for (const href of hrefs) {
    try {
      const parsed = new URL(href, base.origin);
      if (parsed.hostname !== base.hostname) continue;
      // Strip hash and trailing slash for dedup
      parsed.hash = '';
      const normalized = normalizeUrl(parsed.toString());
      if (!isFilePath(normalized)) {
        links.add(normalized);
      }
    } catch {
      // Invalid URL — skip
    }
  }
  return [...links];
}

function normalizeUrl(urlStr) {
  const u = new URL(urlStr);
  u.hash = '';
  // Remove trailing slash except for root
  let p = u.pathname.replace(/\/+$/, '') || '/';
  u.pathname = p;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Screenshot Capture
// ---------------------------------------------------------------------------

const MAX_FILENAME_LENGTH = 200;

function sanitizeFilename(url) {
  const u = new URL(url);
  let name = u.pathname.replace(/\//g, '_').replace(/^_/, '') || 'index';
  // Include query string in filename if present
  if (u.search) {
    name += u.search.replace(/[?&=]/g, '_');
  }
  name = name.replace(/[^a-zA-Z0-9_-]/g, '_');

  // If the name is too long, use a SHA-1 hash with a readable prefix
  if (name.length > MAX_FILENAME_LENGTH) {
    const hash = crypto.createHash('sha1').update(u.pathname + u.search).digest('hex');
    const prefix = name.slice(0, 40);
    name = `${prefix}_${hash}`;
  }

  return name;
}

// Realistic browser fingerprint to avoid bot detection / throttling
const REALISTIC_HEADERS = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36/VISUAL-DIFF-CHECKER',
  extraHTTPHeaders: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': '"Chromium";v="131", "Google Chrome";v="131", "Not_A_Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  },
};

const MAX_CONCURRENCY = 1;

async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let index = 0;
  async function next() {
    const i = index++;
    if (i >= tasks.length) return;
    results[i] = await tasks[i]();
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => next()));
  return results;
}

async function captureScreenshots(browser, urls, outputDir, extraCookieSelectors) {
  const viewports = [
    { name: 'desktop', width: 1920, height: 1080 },
    { name: 'mobile', device: devices['iPhone 13'] },
  ];

  const screenshots = [];

  for (const vpConfig of viewports) {
    const contextOptions = vpConfig.device
      ? { ...vpConfig.device, ...REALISTIC_HEADERS }
      : { viewport: { width: vpConfig.width, height: vpConfig.height }, ...REALISTIC_HEADERS };

    const tasks = urls.map((url) => async () => {
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      const filename = `${sanitizeFilename(url)}_${vpConfig.name}.png`;
      const filepath = path.join(outputDir, filename);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(10000); // Allow images and fonts to settle
        await dismissCookieBanners(page, extraCookieSelectors);
        await page.screenshot({ path: filepath, fullPage: true });
        screenshots.push({ url, viewport: vpConfig.name, filepath, filename });
        console.log(`  ✓ ${vpConfig.name}: ${url}`);
      } catch (err) {
        console.error(`  ✗ ${vpConfig.name}: ${url} — ${err.message}`);
      } finally {
        await context.close();
      }
    });

    await runWithConcurrency(tasks, MAX_CONCURRENCY);
  }

  return screenshots;
}

// ---------------------------------------------------------------------------
// Image Comparison
// ---------------------------------------------------------------------------

function compareImages(baselinePath, currentPath, diffPath, ssimThreshold = 0.95) {
  if (!fs.existsSync(baselinePath)) {
    return { match: false, reason: 'no-baseline', ssimScore: 0 };
  }

  const baselineImg = PNG.sync.read(fs.readFileSync(baselinePath));
  const currentImg = PNG.sync.read(fs.readFileSync(currentPath));

  // Handle different dimensions by padding to the larger size
  const width = Math.max(baselineImg.width, currentImg.width);
  const height = Math.max(baselineImg.height, currentImg.height);

  const padded1 = padImage(baselineImg, width, height);
  const padded2 = padImage(currentImg, width, height);

  // ssim.js expects { data: Uint8Array, width, height, channels } with RGBA
  const result = ssim(
    { data: padded1.data, width, height, channels: 4 },
    { data: padded2.data, width, height, channels: 4 },
  );

  const score = result.mssim; // Mean SSIM (0 to 1, where 1 = identical)

  if (score < ssimThreshold) {
    // Generate a visual diff image highlighting structural differences
    const diffImg = generateDiffImage(padded1, padded2, width, height);
    fs.writeFileSync(diffPath, PNG.sync.write(diffImg));
    return { match: false, reason: 'diff', ssimScore: score, diffPath };
  }

  return { match: true, ssimScore: score };
}

function generateDiffImage(img1, img2, width, height) {
  const diff = new PNG({ width, height });
  for (let i = 0; i < img1.data.length; i += 4) {
    const dr = Math.abs(img1.data[i] - img2.data[i]);
    const dg = Math.abs(img1.data[i + 1] - img2.data[i + 1]);
    const db = Math.abs(img1.data[i + 2] - img2.data[i + 2]);
    const pixelDiff = dr + dg + db;

    if (pixelDiff > 30) {
      // Highlight differences in red
      diff.data[i] = 255;
      diff.data[i + 1] = 0;
      diff.data[i + 2] = 0;
      diff.data[i + 3] = 255;
    } else {
      // Keep original pixel but dimmed
      diff.data[i] = Math.floor(img1.data[i] * 0.3);
      diff.data[i + 1] = Math.floor(img1.data[i + 1] * 0.3);
      diff.data[i + 2] = Math.floor(img1.data[i + 2] * 0.3);
      diff.data[i + 3] = 255;
    }
  }
  return diff;
}

function padImage(img, targetWidth, targetHeight) {
  if (img.width === targetWidth && img.height === targetHeight) return img;

  const padded = new PNG({ width: targetWidth, height: targetHeight, fill: true });
  // Fill with transparent pixels
  padded.data.fill(0);
  PNG.bitblt(img, padded, 0, 0, img.width, img.height, 0, 0);
  return padded;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const projectDir = path.join(__dirname, 'screenshots', args.projectName);
  const baselineDir = path.join(projectDir, 'baseline');
  const currentDir = path.join(projectDir, 'current');
  const diffDir = path.join(projectDir, 'diff');

  // Ensure directories exist
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.mkdirSync(currentDir, { recursive: true });
  fs.mkdirSync(diffDir, { recursive: true });

  const extraCookieSelectors = loadProjectCookieSelectors(projectDir);
  const headless = !args.headed;

  console.log(`\n🔍 Visual Regression Tool`);
  console.log(`   Project:   ${args.projectName}`);
  console.log(`   Mode:      ${args.mode}`);
  console.log(`   Threshold: ${args.threshold}`);
  if (args.url) console.log(`   URL:       ${args.url}`);
  if (args.mode !== 'testdiffalg') console.log(`   Depth:     ${args.depth}`);
  console.log(`   Headless:  ${headless}\n`);

  let screenshots = [];
  let brokenLinks = [];
  const summaryPath = path.join(projectDir, 'summary.md');

  // Phases 1 & 2: Crawl + Screenshot (skipped in testdiffalg mode)
  if (args.mode !== 'testdiffalg') {
    const browser = await chromium.launch({ headless });

    // Phase 1: Crawl
    console.log('📡 Crawling site...');
    const crawlContext = await browser.newContext(REALISTIC_HEADERS);
    const crawlPage = await crawlContext.newPage();
    const crawlResult = await crawl(crawlPage, args.url, args.depth);
    const pages = crawlResult.pages;
    brokenLinks = crawlResult.brokenLinks;
    await crawlContext.close();

    console.log(`   Found ${pages.length} page(s)\n`);

    if (brokenLinks.length > 0) {
      console.log('⚠️  Broken links detected:');
      for (const bl of brokenLinks) {
        console.log(`   ${bl.status} — ${bl.url}`);
      }
      console.log('');
    }

    if (pages.length === 0) {
      console.error('No pages found to screenshot. Exiting.');
      await browser.close();
      process.exit(1);
    }

    const urls = pages.map((p) => p.url);

    // Phase 2: Screenshot
    const outputDir = args.mode === 'baseline' ? baselineDir : currentDir;

    // Clean output directory before capturing
    for (const file of fs.readdirSync(outputDir)) {
      fs.unlinkSync(path.join(outputDir, file));
    }

    console.log(`📸 Capturing screenshots (${args.mode} mode)...`);
    screenshots = await captureScreenshots(browser, urls, outputDir, extraCookieSelectors);

    await browser.close();
  }

  // Phase 3: Compare (test and testdiffalg modes)
  if (args.mode === 'test' || args.mode === 'testdiffalg') {
    // In testdiffalg mode, build screenshot list from existing current/ files
    if (args.mode === 'testdiffalg') {
      const currentFiles = fs.readdirSync(currentDir).filter((f) => f.endsWith('.png'));
      if (currentFiles.length === 0) {
        console.error('No screenshots found in current/ folder. Run "test" or "baseline" mode first.');
        process.exit(1);
      }
      screenshots = currentFiles.map((filename) => {
        const viewport = filename.includes('_mobile.png') ? 'mobile' : 'desktop';
        return { url: filename.replace(/_(?:desktop|mobile)\.png$/, ''), viewport, filepath: path.join(currentDir, filename), filename };
      });
      console.log(`📂 Using ${screenshots.length} existing screenshot(s) from current/`);
    }
    console.log('\n🔬 Comparing against baseline...\n');

    // Clean diff directory
    for (const file of fs.readdirSync(diffDir)) {
      fs.unlinkSync(path.join(diffDir, file));
    }

    let hasRegressions = false;
    const results = [];

    for (const shot of screenshots) {
      const baselinePath = path.join(baselineDir, shot.filename);
      const currentPath = shot.filepath;
      const diffPath = path.join(diffDir, `diff_${shot.filename}`);

      const result = compareImages(baselinePath, currentPath, diffPath, args.threshold);
      results.push({ ...shot, ...result });

      if (!result.match) {
        hasRegressions = true;
      }
    }

    // Print results table
    console.log('┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ Visual Regression Results (SSIM)                                │');
    console.log('├──────────────┬──────────┬──────────┬──────────────────────────────┤');
    console.log('│ Status       │ Viewport │ SSIM     │ Page                         │');
    console.log('├──────────────┼──────────┼──────────┼──────────────────────────────┤');

    for (const r of results) {
      const status = r.match ? '  ✅ PASS  ' : '  ❌ FAIL  ';
      const viewport = r.viewport.padEnd(8);
      const score = r.ssimScore !== undefined ? r.ssimScore.toFixed(4).padEnd(8) : 'N/A     ';
      const page = r.url.length > 28 ? r.url.slice(0, 28) + '..' : r.url.padEnd(30);
      console.log(`│${status} │ ${viewport} │ ${score} │ ${page}│`);
    }

    console.log('└──────────────┴──────────┴──────────┴──────────────────────────────┘');

    // Write summary markdown
    const summaryLines = [];
    summaryLines.push(`## 🔍 Visual Regression Report — \`${args.projectName}\``);
    summaryLines.push('');

    if (brokenLinks.length > 0) {
      summaryLines.push('### ⚠️ Broken Links');
      summaryLines.push('');
      summaryLines.push('| Status | URL |');
      summaryLines.push('|--------|-----|');
      for (const bl of brokenLinks) {
        summaryLines.push(`| \`${bl.status}\` | ${bl.url} |`);
      }
      summaryLines.push('');
    }

    summaryLines.push('### 🔬 SSIM Comparison Results');
    summaryLines.push('');
    summaryLines.push(`> Threshold: **${args.threshold}** (1.0 = identical)`);
    summaryLines.push('');
    summaryLines.push('| Status | Viewport | SSIM | Page |');
    summaryLines.push('|--------|----------|------|------|');
    for (const r of results) {
      const status = r.match ? '✅ PASS' : '❌ FAIL';
      const score = r.ssimScore !== undefined ? r.ssimScore.toFixed(4) : 'N/A';
      summaryLines.push(`| ${status} | ${r.viewport} | \`${score}\` | ${r.url} |`);
    }
    summaryLines.push('');

    if (hasRegressions) {
      summaryLines.push('### ❌ Visual regressions detected');
      summaryLines.push('Check the diff images in the uploaded artifacts.');
    } else {
      summaryLines.push('### ✅ All pages match baseline');
    }

    fs.writeFileSync(summaryPath, summaryLines.join('\n'));
    console.log(`\n📄 Summary written to ${summaryPath}`);

    if (hasRegressions) {
      console.log('\n❌ Visual regressions detected! Check the diff/ folder for details.');
      process.exit(1);
    } else {
      console.log('\n✅ All pages match baseline.');
    }
  } else if (args.mode === 'baseline') {
    // Write baseline summary
    const summaryLines = [];
    summaryLines.push(`## 🔍 Baseline Captured — \`${args.projectName}\``);
    summaryLines.push('');

    if (brokenLinks.length > 0) {
      summaryLines.push('### ⚠️ Broken Links');
      summaryLines.push('');
      summaryLines.push('| Status | URL |');
      summaryLines.push('|--------|-----|');
      for (const bl of brokenLinks) {
        summaryLines.push(`| \`${bl.status}\` | ${bl.url} |`);
      }
      summaryLines.push('');
    }

    summaryLines.push(`✅ **${screenshots.length}** screenshot(s) saved as baseline.`);
    fs.writeFileSync(summaryPath, summaryLines.join('\n'));
    console.log(`\n📄 Summary written to ${summaryPath}`);
    console.log(`\n✅ Baseline captured: ${screenshots.length} screenshot(s) saved.`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
