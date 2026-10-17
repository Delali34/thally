/** A realistic shared-logo checkpoint must not expand into one giant JSON string. */
import { cloneUrlMigrationCheckpoint } from '../../url-journal-clone.ts'

const base64 = Buffer.alloc(100 * 1024).toString('base64')
const checkpoint = {
  schemaVersion: 1, converterVersion: 'url-evidence-v2', sourceUrl: 'https://docs.test/', scopePath: '/', captureVersion: 'fetch-v1', navigation: [],
  records: Array.from({ length: 10_000 }, (_, index) => ({ url: `https://docs.test/p${index}`, discoveredBy: ['submitted'], outcome: 'pending', assets: [{ url: 'https://docs.test/logo.png', base64 }] })),
}
// Detect the old implementation's whole-corpus serialization without asking
// a test worker to actually allocate its >1GiB intermediate string.
const stringify = JSON.stringify
let wholeJournalSerializations = 0
JSON.stringify = (value, ...args) => {
  if (value === checkpoint) { wholeJournalSerializations++; throw new Error('Whole-journal serialization is forbidden') }
  return stringify(value, ...args)
}
global.gc()
const before = process.memoryUsage().heapUsed
const copy = cloneUrlMigrationCheckpoint(checkpoint)
global.gc()
const retainedHeapBytes = process.memoryUsage().heapUsed - before
JSON.stringify = stringify
copy.records[0].assets[0].base64 = 'changed'
console.log(JSON.stringify({ records: copy.records.length, retainedHeapBytes, wholeJournalSerializations,
  sharedPayloadBytes: base64.length, expandedPayloadBytes: base64.length * copy.records.length,
  isolated: checkpoint.records[0].assets[0].base64 === base64 && copy.records[1].assets[0].base64 === base64 }))
