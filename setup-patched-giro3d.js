#!/usr/bin/env node
/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/**
 * Script to clone Giro3D, apply the filter patch, and build it
 */

import { execSync } from 'child_process';
import { existsSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GIRO3D_DIR = join(__dirname, 'giro3d');
const GIRO3D_REPO = 'https://gitlab.com/giro3d/giro3d.git';
const GIRO3D_VERSION = '0.43.5'; // Match your package.json version

console.log('🔧 Setting up patched Giro3D build...\n');

// Check if Giro3D is already built (check for package.json and build directory)
const giro3dPackageJson = join(GIRO3D_DIR, 'package.json');
const buildDir = join(GIRO3D_DIR, 'build');
const isAlreadyBuilt = existsSync(giro3dPackageJson) && existsSync(buildDir);

if (isAlreadyBuilt) {
  console.log('✓ Giro3D directory and build already exist, skipping setup\n');
} else {
  // Step 1: Clone Giro3D if not exists
  if (!existsSync(giro3dPackageJson)) {
    // If directory exists but is incomplete, remove it
    if (existsSync(GIRO3D_DIR)) {
      console.log('⚠️  Incomplete Giro3D directory found, removing...');
      try {
        rmSync(GIRO3D_DIR, { recursive: true, force: true });
        console.log('✓ Cleaned up incomplete directory\n');
      } catch (error) {
        console.error('❌ Failed to remove incomplete directory:', error.message);
        console.error('Please manually delete the giro3d folder and try again.');
        process.exit(1);
      }
    }
    
    console.log('📦 Cloning Giro3D repository...');
    try {
      execSync(`git clone --depth 1 --branch v${GIRO3D_VERSION} ${GIRO3D_REPO} "${GIRO3D_DIR}"`, { 
        stdio: 'inherit',
        cwd: __dirname
      });
      console.log('✓ Giro3D cloned\n');
    } catch (error) {
      console.error('❌ Failed to clone Giro3D:', error.message);
      process.exit(1);
    }
  } else {
    console.log('✓ Giro3D directory already exists\n');
  }

  // Step 2: Install Giro3D dependencies
  console.log('📦 Installing Giro3D dependencies...');
  try {
    execSync('npm install', { 
      stdio: 'inherit',
      cwd: GIRO3D_DIR
    });
    console.log('✓ Dependencies installed\n');
  } catch (error) {
    console.error('❌ Failed to install dependencies:', error.message);
    process.exit(1);
  }

  // Step 3: Copy patched filter
  console.log('🔧 Applying filter patch...');
  const sourceFilter = join(__dirname, 'giropatch', 'filter.ts');
  const targetFilter = join(GIRO3D_DIR, 'src', 'sources', 'las', 'filter.ts');

  if (!existsSync(sourceFilter)) {
    console.error('❌ Source filter not found at:', sourceFilter);
    process.exit(1);
  }

  try {
    copyFileSync(sourceFilter, targetFilter);
    console.log('✓ Filter patched\n');
  } catch (error) {
    console.error('❌ Failed to copy filter:', error.message);
    process.exit(1);
  }

  // Step 4: Build Giro3D
  console.log('🔨 Building Giro3D...');
  try {
    execSync('npm run build', { 
      stdio: 'inherit',
      cwd: GIRO3D_DIR
    });
    console.log('✓ Giro3D built successfully\n');
  } catch (error) {
    console.error('❌ Failed to build Giro3D:', error.message);
    process.exit(1);
  }
}

// Step 5: Update package.json to use local Giro3D (only if not already configured)
const packageJsonPath = join(__dirname, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

const currentGiro3dDep = packageJson.dependencies?.['@giro3d/giro3d'];
const isAlreadyLinked = currentGiro3dDep === 'file:./giro3d';

if (!isAlreadyLinked) {
  console.log('🔗 Linking local Giro3D...');
  packageJson.dependencies['@giro3d/giro3d'] = 'file:./giro3d';
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 4) + '\n');
  console.log('✓ package.json updated\n');
} else {
  console.log('✓ package.json already linked to local Giro3D\n');
}

console.log('✅ Setup complete!');
console.log('\nNext steps:');
console.log('1. Run npm install, [if this task was not performed automatically.]');
console.log('2. Run: npm run build');
console.log('3. Run: npm start');
console.log('\nThe patched Giro3D with OR filter logic is now ready to use.');
