/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Tests attachment staging (type sniffing, names, limits) and copying into an app's assets/,
// without Electron.
//   node scripts/test-attachments.mjs
import ts from 'typescript'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const nodeReq = createRequire(import.meta.url)

function load(rel, extra = {}) {
  const out = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const mod = { exports: {} }
  const req = (id) => (id in extra ? extra[id] : nodeReq(id))
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports)
  return mod.exports
}

const types = load('src/shared/types.ts')
const { AttachmentStore, sniffImage, cleanFileName, detectKind, imageSize, assetMime } = load(
  'src/main/services/attachments.ts',
  {
    '../../shared/types': types,
    './docText': load('src/main/services/docText.ts')
  }
)
const { LibraryService } = load('src/main/services/library.ts')

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9])
const GIF = new TextEncoder().encode('GIF89a....')
const WEBP = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marbles-attach-'))
try {
  // Sniffing goes by bytes, not the claimed type.
  assert.equal(sniffImage(PNG), 'image/png')
  assert.equal(sniffImage(JPG), 'image/jpeg')
  assert.equal(sniffImage(GIF), 'image/gif')
  assert.equal(sniffImage(WEBP), 'image/webp')
  assert.equal(sniffImage(new TextEncoder().encode('<svg></svg>')), null)
  assert.equal(sniffImage(new Uint8Array()), null)

  // Names: no path parts, extension from the real type.
  assert.equal(cleanFileName('../../etc/passwd', '.png'), 'passwd.png')
  assert.equal(cleanFileName('My Screenshot (2).PNG', '.png'), 'My-Screenshot-2.png')
  assert.equal(cleanFileName('photo.png', '.jpg'), 'photo.jpg')
  assert.equal(cleanFileName('', '.gif'), 'file.gif')
  assert.equal(cleanFileName('.hidden', '.png'), 'file.png')

  // Staging.
  const store = new AttachmentStore(path.join(dir, 'staging'))
  const a = await store.stage('shot.png', 'image/png', PNG)
  assert.equal(a.name, 'shot.png')
  assert.equal(a.mime, 'image/png')
  assert.equal(a.size, PNG.length)
  // A JPEG named .png is kept as a JPEG.
  const b = await store.stage('fake.png', 'image/png', JPG)
  assert.equal(b.mime, 'image/jpeg')
  assert.equal(b.name, 'fake.jpg')
  await assert.rejects(store.stage('x.exe', '', new TextEncoder().encode('MZ...')))
  await assert.rejects(store.stage('x.svg', 'image/svg+xml', new TextEncoder().encode('<svg/>')))
  await assert.rejects(store.stage('empty.png', 'image/png', new Uint8Array()))
  await assert.rejects(store.stage('big.png', 'image/png', new Uint8Array(21 * 1024 * 1024)))
  // The AI copy must also be an image.
  await assert.rejects(
    store.stage('a.png', 'image/png', PNG, { mime: 'image/png', data: new Uint8Array([1, 2]) })
  )
  const c = await store.stage('big.gif', 'image/gif', GIF, { mime: 'image/png', data: PNG })
  const url = await store.modelDataUrl(store.resolve([c.id])[0])
  assert.ok(url.startsWith('data:image/png;base64,'))
  assert.ok((await store.modelDataUrl(store.resolve([a.id])[0])).startsWith('data:image/png;'))

  assert.deepEqual(store.resolve(undefined), [])
  assert.throws(() => store.resolve(['nope']))
  assert.throws(() => store.resolve('x'))
  await store.discard(b.id)
  assert.throws(() => store.resolve([b.id]))

  // Copying into an app: clashes get -2, -3 (case-insensitive), originals untouched.
  const lib = new LibraryService(async () => path.join(dir, 'lib'))
  lib.setNotifier(() => {})
  const app = await lib.create({ name: 'Pics', html: '<p>x</p>' })
  const items = store.resolve([a.id, c.id])
  const files = items.map((i) => ({ name: i.name, path: store.originalPath(i) }))
  assert.deepEqual(await lib.addAssets(app.id, files), ['shot.png', 'big.gif'])
  assert.deepEqual(await lib.addAssets(app.id, [files[0], files[0]]), ['shot-2.png', 'shot-3.png'])
  assert.deepEqual(await lib.addAssets(app.id, [{ ...files[0], name: 'SHOT.png' }]), ['SHOT-4.png'])
  assert.deepEqual([...(await lib.readAsset(app.id, 'shot.png'))], [...PNG])
  await assert.rejects(lib.addAssets(app.id, [{ name: '../x.png', path: files[0].path }]))
  await assert.rejects(lib.readAsset(app.id, '../meta.json'))
  await assert.rejects(lib.readAsset(app.id, '.hidden'))
  await assert.rejects(lib.readAsset(app.id, 'missing.png'))

  // A linked asset is refused.
  if (process.platform !== 'win32') {
    const secret = path.join(dir, 'secret.png')
    fs.writeFileSync(secret, PNG)
    const assets = path.join(dir, 'lib', 'apps', app.id, 'assets')
    fs.symlinkSync(secret, path.join(assets, 'link.png'))
    await assert.rejects(lib.readAsset(app.id, 'link.png'))
  }

  // ---- documents ----
  const enc = (t) => new TextEncoder().encode(t)
  assert.equal(detectKind('a.csv', enc('a,b')).kind, 'text')
  assert.equal(detectKind('A.MD', enc('# hi')).mime, 'text/markdown')
  // An image with a .txt name is still an image.
  assert.equal(detectKind('a.txt', PNG).kind, 'image')
  assert.throws(() => detectKind('a.pdf', enc('not a pdf')), /valid PDF/)
  assert.throws(() => detectKind('a.docx', enc('nope')), /valid Word/)
  assert.throws(() => detectKind('a.zip', enc('PK\x03\x04')), /can attach/)

  // Text: UTF-8 only, BOM and CRLF cleaned, binary refused, long text cut.
  const csv = await store.stage('data.csv', 'text/csv', enc('\uFEFFname,age\r\nAna,31\r\n'))
  assert.equal(csv.kind, 'text')
  assert.equal(csv.name, 'data.csv')
  assert.equal(await store.text(store.resolve([csv.id])[0]), 'name,age\nAna,31\n')
  await assert.rejects(store.stage('bin.txt', '', Uint8Array.from([0x61, 0, 0x62])), /plain text/)
  await assert.rejects(
    store.stage('latin1.txt', '', Uint8Array.from([0x63, 0xe9, 0x20])),
    /plain text/
  )
  await assert.rejects(store.stage('blank.md', '', enc('  \n ')), /no text/)
  const long = await store.stage('long.txt', '', enc('x'.repeat(types.ATTACH_MAX_CHARS + 10)))
  assert.equal(long.truncated, true)
  assert.equal((await store.text(store.resolve([long.id])[0])).length, types.ATTACH_MAX_CHARS)

  // PDF: kept as is and sent as a file.
  const pdf = await store.stage('Spec v2.pdf', '', enc('%PDF-1.4\n%fake\n'))
  assert.equal(pdf.kind, 'pdf')
  assert.equal(pdf.name, 'Spec-v2.pdf')
  assert.ok(
    (await store.modelDataUrl(store.resolve([pdf.id])[0])).startsWith(
      'data:application/pdf;base64,'
    )
  )

  // Excel: one CSV block per sheet.
  const XLSX = nodeReq('xlsx')
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Item', 'Cost'],
      ['Tea', 3.5]
    ]),
    'Shop'
  )
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x'], [1]]), 'Other')
  const xbytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
  const xl = await store.stage('budget.xlsx', '', xbytes)
  assert.equal(xl.kind, 'xlsx')
  assert.equal(
    await store.text(store.resolve([xl.id])[0]),
    '## Sheet: Shop\nItem,Cost\nTea,3.5\n\n## Sheet: Other\nx\n1'
  )
  await assert.rejects(store.stage('broken.xlsx', '', enc('PK\x03\x04garbage')), /Couldn't read/)

  // Word: headings, paragraphs and tables as HTML.
  const JSZip = createRequire(nodeReq.resolve('mammoth'))('jszip')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  )
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello spec</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
  )
  const dbytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))
  const doc = await store.stage('spec.docx', '', dbytes)
  assert.equal(doc.kind, 'docx')
  const html = await store.text(store.resolve([doc.id])[0])
  assert.match(html, /<p>Hello spec<\/p>/)
  assert.match(html, /<table>.*A1.*B1.*<\/table>/s)

  // Documents copy into assets like images.
  const [docName] = await lib.addAssets(app.id, [
    { name: doc.name, path: store.originalPath(store.resolve([doc.id])[0]) }
  ])
  assert.equal(docName, 'spec.docx')

  // ---- image sizes and types of app files ----
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02,
    0x00, 0, 0, 0x01, 0x2c
  ])
  assert.deepEqual(imageSize(png), { width: 512, height: 300 })
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])
  assert.deepEqual(imageSize(gif), { width: 320, height: 240 })
  // JPEG: an APP0 segment, then SOF0 with height 600, width 800.
  const jpg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03,
    0x20, 0x03, 0, 0, 0, 0
  ])
  assert.deepEqual(imageSize(jpg), { width: 800, height: 600 })
  const vp8x = new Uint8Array(30)
  vp8x.set(enc('RIFF'), 0)
  vp8x.set(enc('WEBPVP8X'), 8)
  vp8x.set([0x3f, 0x01, 0x00, 0xc7, 0x00, 0x00], 24) // 320 - 1, 200 - 1
  assert.deepEqual(imageSize(vp8x), { width: 320, height: 200 })
  assert.equal(imageSize(enc('not an image')), null)
  assert.equal(imageSize(Uint8Array.from([0xff, 0xd8, 0xff])), null)
  assert.equal(assetMime('Logo.PNG'), 'image/png')
  assert.equal(assetMime('a.jpeg'), 'image/jpeg')
  assert.equal(assetMime('d.csv'), 'text/csv')
  assert.equal(assetMime('n.log'), 'text/plain')
  assert.equal(assetMime('x.xlsx').includes('spreadsheet'), true)
  assert.equal(assetMime('x.bin'), 'application/octet-stream')

  // ---- listing and removing app files ----
  const listed = (await lib.listAssets(app.id)).map((f) => f.name)
  assert.ok(listed.includes('shot.png') && listed.includes('spec.docx'))
  assert.ok(!listed.includes('link.png') || process.platform === 'win32')
  await lib.removeAsset(app.id, 'shot.png')
  await lib.addAssets(app.id, [{ name: 'shot.png', path: files[0].path }])
  await lib.removeAsset(app.id, 'shot.png')
  assert.ok(!(await lib.listAssets(app.id)).some((f) => f.name === 'shot.png'))
  const bin = path.join(dir, 'lib', 'apps', app.id, 'removed-assets')
  assert.deepEqual(fs.readdirSync(bin).sort(), ['shot-2.png', 'shot.png'])
  await assert.rejects(lib.readAsset(app.id, 'shot.png'))
  await assert.rejects(lib.removeAsset(app.id, '../meta.json'))
  await assert.rejects(lib.removeAsset(app.id, 'missing.png'))
  assert.deepEqual(await lib.listAssets((await lib.create({ name: 'Empty' })).id), [])

  // Startup clears staging.
  await store.clear()
  assert.equal(fs.existsSync(path.join(dir, 'staging')), false)
  assert.throws(() => store.resolve([a.id]))

  console.log('test-attachments: all passed')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
