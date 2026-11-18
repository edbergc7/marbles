/**
 * Turns attached documents into text for the AI. Runs in main on files the person picked.
 * The libraries are loaded on first use so they don't slow down startup.
 */

/** Rows read per Excel sheet; a bigger sheet is cut (the text limit would cut it anyway). */
const XLSX_MAX_ROWS = 5000

/** UTF-8 text, or null when the bytes aren't text (bad UTF-8, or NUL bytes as in binaries). */
export function utf8Text(bytes: Uint8Array): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (text.includes('\0')) return null
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** A Word document as simple HTML (headings, lists and tables survive; images are dropped). */
export async function docxText(bytes: Uint8Array): Promise<string> {
  // mammoth is CommonJS: `default` when imported as ESM, the module itself when required.
  const mod = (await import('mammoth')) as typeof import('mammoth') & {
    default?: typeof import('mammoth')
  }
  const mammoth = mod.default ?? mod
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) }
  )
  return result.value
    .replace(/<img[^>]*>/g, '')
    .replace(/<\/(p|h[1-6]|li|tr|table|ul|ol)>/g, '$&\n')
    .trim()
}

/** An Excel workbook as one CSV block per sheet. */
export async function xlsxText(bytes: Uint8Array): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(bytes, {
    type: 'array',
    sheetRows: XLSX_MAX_ROWS,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false
  })
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim()
    parts.push(`## Sheet: ${name}\n${csv || '(empty)'}`)
  }
  return parts.join('\n\n')
}
