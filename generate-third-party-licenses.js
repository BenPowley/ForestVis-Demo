#!/usr/bin/env node
/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/**
 * Regenerates THIRD_PARTY_LICENSES.txt (repo root and public/).
 *
 * Runs a production build into a temporary directory, records every module
 * that ends up in the bundle (workers included), maps each one to its npm
 * package and collects that package's license files. Vendored files and the
 * packages that ship no license file are covered by the texts in licenses/.
 *
 * Usage: npm run licenses
 */

import { build } from 'vite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(f, 'utf8');
const norm = s => s.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
const lic = f => read(join(ROOT, 'licenses', f));

const GIRO3D = 'https://gitlab.com/giro3d/giro3d/-/blob/v0.43.5';

// Files vendored directly in this repository.
const VENDORED = [
  { name: 'Bootstrap', version: '5.3.8', license: 'MIT',
    files: 'public/vendor/bootstrap/bootstrap.bundle.min.js, public/vendor/bootstrap/bootstrap-custom.css',
    source: 'https://github.com/twbs/bootstrap', text: lic('bootstrap-LICENSE') },
  { name: 'Bootstrap Icons', version: '1.13.1', license: 'MIT',
    files: 'public/vendor/bootstrap/fonts/bootstrap-icons.woff, public/vendor/bootstrap/fonts/bootstrap-icons.woff2 (and the icon rules in bootstrap-custom.css)',
    source: 'https://github.com/twbs/icons', text: lic('bootstrap-icons-LICENSE') },
  { name: 'laz-perf', version: '0.0.7', license: 'Apache-2.0',
    files: 'public/vendor/laz-perf/laz-perf.wasm',
    source: 'https://github.com/hobuinc/laz-perf', see: 'laz-perf@0.0.7' },
  { name: 'Giro3D (modified)', version: '0.43.5', license: 'MIT',
    files: 'giropatch/filter.ts (modified copy of src/sources/las/filter.ts)',
    source: `${GIRO3D}/src/sources/las/filter.ts`, see: '@giro3d/giro3d@0.43.5' },
  { name: 'Giro3D example code (adapted)', version: '0.43.5', license: 'MIT',
    files: 'index.js, index.html, example.css (adapted, with additional custom rules)',
    source: ['lidar_hd.js', 'ol_vector.js', 'minimap.js', 'css/example.css']
      .map(f => `${GIRO3D}/examples/${f}`).join('\n        '),
    see: '@giro3d/giro3d@0.43.5' },
];

// Packages whose npm tarball ships no license file: texts taken from the upstream repos.
const MISSING = {
  'laz-perf': { text: lic('laz-perf-COPYING'), source: 'https://github.com/hobuinc/laz-perf (COPYING)' },
  'lerc': { text: lic('lerc-LICENSE') + '\n\n----- NOTICE -----\n\n' + lic('lerc-NOTICE'),
    source: 'https://github.com/Esri/lerc/tree/v3.0 (LICENSE, NOTICE)' },
  'color-rgba': { text: 'MIT License\n\n' + lic('color-rgba-LICENSE'), source: 'https://github.com/colorjs/color-rgba (LICENSE)' },
};

// package.json "license" fields that contradict the LICENSE file shipped in the package.
const LICENSE_OVERRIDE = {
  'umap-js': 'Apache-2.0 (the package.json "license" field says MIT, but the LICENSE file shipped in the package is Apache-2.0)',
};

// 1. Build and record the bundled modules.
const ids = new Set();
const collect = {
  name: 'collect-modules',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type === 'chunk') Object.keys(chunk.modules).forEach(id => ids.add(id));
    }
  },
};
const outDir = mkdtempSync(join(tmpdir(), 'licenses-build-'));
try {
  await build({
    root: ROOT,
    logLevel: 'warn',
    plugins: [collect],
    worker: { plugins: [collect] },
    build: { outDir, emptyOutDir: true },
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// 2. Map modules to packages.
const findPackage = file => {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    const pj = join(dir, 'package.json');
    // Nested package.json files (e.g. {"type": "module"}) have no name; keep climbing.
    if (existsSync(pj)) {
      const pkg = JSON.parse(read(pj));
      if (pkg.name) return { pkg, dir };
    }
    dir = dirname(dir);
  }
  throw new Error(`No package.json for ${file}`);
};

const packages = new Map();
for (let id of ids) {
  id = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  if (!/node_modules\/|\/giro3d\//.test(id)) continue;
  const { pkg, dir } = findPackage(id);
  packages.set(pkg.name, {
    name: pkg.name, version: pkg.version, license: pkg.license || JSON.stringify(pkg.licenses), dir,
    files: readdirSync(dir).filter(f => /^(licen[cs]e|copying|notice)/i.test(f)),
  });
}

// 3. Where each package was retrieved from, per package-lock.json.
const lock = JSON.parse(read(join(ROOT, 'package-lock.json'))).packages;
const retrieved = p => {
  const rel = relative(ROOT, p.dir).replace(/\\/g, '/');
  if (rel.startsWith('giro3d')) return `https://gitlab.com/giro3d/giro3d (tag v${p.version}, built locally by setup-patched-giro3d.js)`;
  const url = lock[rel]?.resolved;
  if (!url) throw new Error(`No resolved URL in package-lock.json for ${p.name} (${rel})`);
  const git = url.match(/github\.com\/(.+?)\.git#([0-9a-f]+)$/);
  if (git) return `https://github.com/${git[1]}/tree/${git[2]} (git dependency in package.json)`;
  return `${url}\n  npm page: https://www.npmjs.com/package/${p.name}/v/${p.version}`;
};

// 4. Write the notices.
const RULE = '='.repeat(78);
const LINE = '-'.repeat(78);
const out = [`THIRD-PARTY SOFTWARE NOTICES AND LICENSES

This project includes third-party software. Part 1 lists files vendored
directly in this repository. Part 2 lists the npm packages that are bundled
into the built web application (the output of \`npm run build\`), including
transitive dependencies. Each entry gives the package, its license, and the
full license text as distributed by the copyright holders.
`];

out.push(`${RULE}\nPART 1: VENDORED FILES\n${RULE}\n`);
for (const v of VENDORED) {
  out.push(`${LINE}\n${v.name} ${v.version}\nLicense: ${v.license}\nFiles: ${v.files}\nSource: ${v.source}\n${LINE}\n`);
  out.push(v.text ? norm(v.text) + '\n' : `See the ${v.see} entry in Part 2 for the full license text.\n`);
}

out.push(`${RULE}\nPART 2: PACKAGES BUNDLED INTO THE BUILT APPLICATION\n${RULE}\n`);
for (const p of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const missing = MISSING[p.name];
  if (!missing && !p.files.length) throw new Error(`No license text for ${p.name}@${p.version}; add it to MISSING`);
  const text = missing ? missing.text : p.files.map(f => norm(read(join(p.dir, f)))).join('\n\n');
  const from = missing ? `\nLicense text from: ${missing.source}` : '';
  out.push(`${LINE}\n${p.name}@${p.version}\nLicense: ${LICENSE_OVERRIDE[p.name] || p.license}\nRetrieved from: ${retrieved(p)}${from}\n${LINE}\n`);
  out.push(norm(text) + '\n');
}

const notices = out.join('\n');
for (const f of ['THIRD_PARTY_LICENSES.txt', 'public/THIRD_PARTY_LICENSES.txt']) writeFileSync(join(ROOT, f), notices);
console.log(`Wrote THIRD_PARTY_LICENSES.txt and public/THIRD_PARTY_LICENSES.txt (${packages.size} bundled packages)`);
