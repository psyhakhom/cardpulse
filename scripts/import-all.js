/**
 * Run all card game imports sequentially.
 * Run: npm run import-all
 */
import { execSync } from 'child_process'

const scripts = [
  { name: 'DBS', file: 'scripts/import-dbs-cards.js' },
  { name: 'Pokemon', file: 'scripts/import-pokemon.js' },
  { name: 'MTG', file: 'scripts/import-mtg.js' },
  { name: 'Yu-Gi-Oh', file: 'scripts/import-yugioh.js' },
  { name: 'One Piece', file: 'scripts/import-onepiece.js' },
  { name: 'Lorcana', file: 'scripts/import-lorcana.js' },
]

console.log('═══════════════════════════════════════')
console.log('  CardPulse — Import All Card Games')
console.log('═══════════════════════════════════════\n')

for (const { name, file } of scripts) {
  console.log(`\n▶ Starting ${name} import...`)
  try {
    execSync(`node --env-file=.env.local ${file}`, { stdio: 'inherit' })
    console.log(`✓ ${name} import complete\n`)
  } catch (err) {
    console.error(`✗ ${name} import failed: ${err.message}\n`)
  }
}

console.log('\n═══════════════════════════════════════')
console.log('  All imports finished!')
console.log('═══════════════════════════════════════')
