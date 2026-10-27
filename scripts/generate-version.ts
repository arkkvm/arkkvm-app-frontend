/*
 * @Purpose: Generate app version and write it to .env file
 * @Description: Generate version from date/sequence, or use provided version
 * @Author: zhanglei
 * @Date: 2026-01-27
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// Usage:
//   tsx scripts/generate-version.ts pro           -> auto-generate 0.0.YYMMDDXX
//   tsx scripts/generate-version.ts pro 1.2.3     -> use provided version
//   VERSION=1.2.3 tsx scripts/generate-version.ts pro -> pass via env variable
const args = process.argv.slice(2)
const envName = (args[0] || 'pro').trim()
const overrideVersion = (args[1] || process.env.VERSION || '').trim()

const envFilePath = path.join(root, `.env.${envName}`)

// Read current version prefix from .env file
function getVersionPrefix(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const match = content.match(/^RSB_APP_VERSION=(.*)$/m)
    if (match && match[1]) {
      const parts = match[1].trim().split('.')
      if (parts.length >= 2) {
        return `${parts[0]}.${parts[1]}`
      }
    }
  } catch {
    // Read failed
  }
  return '0.0'
}

// Generate version by date + historical sequence
function generateVersion(prefix: string): string {
  const now = new Date()
  const yy = String(now.getFullYear()).slice(-2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const dateCode = `${yy}${mm}${dd}`

  let seq = 1

  // Try to extract sequence from existing version
  try {
    const content = fs.readFileSync(envFilePath, 'utf-8')
    const match = content.match(/^RSB_APP_VERSION=(.*)$/m)
    if (match && match[1]) {
      const last = match[1].trim()
      const parts = last.split('.')
      if (parts.length >= 3) {
        const lastPrefix = `${parts[0]}.${parts[1]}`
        const suffix = parts[2] || ''
        if (lastPrefix === prefix && suffix.length >= 8) {
          const lastDate = suffix.slice(0, 6)
          const lastSeqStr = suffix.slice(6)
          if (lastDate === dateCode && /^\d{2,}$/.test(lastSeqStr)) {
            const lastSeq = Number(lastSeqStr)
            if (Number.isSafeInteger(lastSeq) && lastSeq < Number.MAX_SAFE_INTEGER) {
              seq = lastSeq + 1
            }
          }
        }
      }
    }
  } catch {
    // Read failed
  }

  const seqStr = String(seq).padStart(2, '0')
  return `${prefix}.${dateCode}${seqStr}`
}

// Resolve final version
const versionPrefix = overrideVersion
  ? overrideVersion.split('.').slice(0, 2).join('.')
  : getVersionPrefix(envFilePath)

const finalVersion = overrideVersion || generateVersion(versionPrefix)

// Write version to .env file
try {
  let envContent = ''
  try {
    envContent = fs.readFileSync(envFilePath, 'utf-8')
  } catch {
    envContent = ''
  }

  if (/^RSB_APP_VERSION=/m.test(envContent)) {
    envContent = envContent.replace(
      /^RSB_APP_VERSION=.*$/m,
      `RSB_APP_VERSION=${finalVersion}`
    )
  } else {
    if (envContent && !envContent.endsWith('\n')) envContent += '\n'
    envContent += `RSB_APP_VERSION=${finalVersion}\n`
  }

  fs.writeFileSync(envFilePath, envContent, 'utf-8')
  console.log(`✅ Version generated: ${finalVersion}`)
  console.log(`✅ Written to file: ${path.basename(envFilePath)}`)
} catch (err) {
  console.error(`❌ Write failed:`, err)
  process.exit(1)
}
