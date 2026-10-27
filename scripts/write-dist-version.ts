/*
 * @Purpose: Read version from .env and write to dist directories
 * @Description: Write version to dist/version, dist/device/version, and dist-v{version}/version
 * @Author: zhanglei
 * @Date: 2026-01-27
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// Usage: tsx scripts/write-dist-version.ts pro
const args = process.argv.slice(2)
const envName = (args[0] || 'pro').trim()

const envFilePath = path.join(root, `.env.${envName}`)
const distDir = process.env.ARKKVM_DIST_ROOT || path.join(root, 'dist')

// Read version from .env file
function readVersionFromEnv(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const match = content.match(/^RSB_APP_VERSION=(.*)$/m)
    if (match && match[1]) {
      return match[1].trim()
    }
  } catch (err) {
    console.error(`❌ Failed to read ${path.basename(filePath)}:`, err)
  }
  return '0.0.0'
}

const version = readVersionFromEnv(envFilePath)

if (!version || version === '0.0.0') {
  console.error(`❌ No valid version found. Please run generate-version.ts first`)
  process.exit(1)
}

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true })
}

// Write dist/version
const content = version
fs.writeFileSync(path.join(distDir, 'version'), content, 'utf-8')
console.log(`✅ Written: dist/version (${version})`)

// Write dist/device/version
const deviceDistDir = path.join(distDir, 'device')
if (fs.existsSync(deviceDistDir)) {
  fs.writeFileSync(path.join(deviceDistDir, 'version'), content, 'utf-8')
  console.log(`✅ Written: dist/device/version (${version})`)
}

// Write dist/{version}/version (cloud build with version name)
const cloudDistDir = path.join(distDir, version)
if (fs.existsSync(cloudDistDir)) {
  fs.writeFileSync(path.join(cloudDistDir, 'version'), content, 'utf-8')
  console.log(`✅ Written: dist/${version}/version (${version})`)
}

console.log(`\n📦 Version ${version} has been synced to all dist directories`)
