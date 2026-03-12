# Site Visual Diff

Most of the files in this project were created in whole or in part by generative AI.

Visual Regression Testing tool. Crawls websites, captures full-page screenshots at multiple viewports, and detects visual changes using pixel-level comparison (using SSIM aproach).

## Features

- **Automatic crawling** — Discovers internal pages up to depth 2
- **Multi-viewport** — Desktop (1920×1080) and Mobile (iPhone 13)
- **Pixel-accurate diffing** — Generates diff images for regressions above 0.5%
- **Broken link detection** — Reports non-200 status codes during crawl
- **Cookie banner dismissal** — Built-in selectors for common consent dialogs
- **GitHub Actions integration** — Automated baseline/test workflows with artifact uploads

## Setup

```bash
npm install
npx playwright install --with-deps chromium
```

## Usage

### Capture a baseline

```bash
npm run baseline -- --url https://example.com --project-name my-site
```

Real example:
```bash
npm run baseline -- --url "https://doktorpetrovic.rs" --project-name doktor-petrovic --threshold 0.95 --depth 2
```

### Run a visual test against the baseline by crawling a website and generating screenshots and by comparing a diff

```bash
npm run test -- --url https://example.com --project-name my-site
```

Real example:
```bash
npm run test -- --url "https://doktorpetrovic.rs" --project-name doktor-petrovic --threshold 0.95 --depth 2
```

### Run a JUST A visual test against the baseline by JUST comparing a diff between the baseline and existing (if any) test files from previous 'test' sessions

```bash
npm run testdiffalg -- --url https://example.com --project-name my-site
```

Real example:
```bash
npm run testdiffalg -- --url "https://doktorpetrovic.rs" --project-name doktor-petrovic --threshold 0.95 --depth 2
```

### Local debugging (headed mode)

```bash
node index.js --url https://example.com --project-name my-site --mode baseline --headed
```

## Adding a New Site

1. Choose a `project-name` (e.g., `my-company-site`). This becomes the folder name under `screenshots/`.
2. Run the baseline command to capture reference screenshots.
3. Commit and push the baseline screenshots.
4. Run the test command whenever you want to check for regressions.

### Custom Cookie Selectors

If a site has a non-standard cookie banner, create a file at:

```
screenshots/{project-name}/cookie-selectors.json
```

With an array of CSS selectors:

```json
["#my-custom-accept-btn", ".specific-cookie-dismiss"]
```

These are appended to the built-in selector list.

## GitHub Actions

The workflow is triggered manually via **Actions → Visual Regression Check → Run workflow**.

### Inputs

| Input | Description | Example |
|-------|-------------|---------|
| `site_url` | URL to scan | `https://example.com` |
| `project_name` | Folder name for this site | `my-site` |
| `run_mode` | `baseline` or `test` | `baseline` |

### Behavior

- **`baseline`** — Captures screenshots and commits them to the repo automatically.
- **`test`** — Compares against the baseline and uploads current screenshots + diff images as downloadable artifacts.

## Folder Structure

```
screenshots/
└── {project-name}/
    ├── baseline/          # Reference screenshots
    ├── current/           # Latest test screenshots
    └── diff/              # Diff images (only for regressions)
```

## How It Works

1. **Crawl** — Starts at the base URL, follows internal links to depth 2, deduplicates, and filters external domains.
2. **Screenshot** — Captures full-page screenshots for each discovered page at desktop and mobile viewports. Dismisses cookie banners before capture.
3. **Compare** (test mode) — Diffs each current screenshot against its baseline using pixelmatch. Generates a diff image if the difference exceeds 0.5% of pixels.

## License

MIT
