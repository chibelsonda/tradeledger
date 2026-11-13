import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib'

export interface WaiverPdfData {
  organizationName: string
  paymentRequestId: string
  paymentReference: string
  projectName: string
  projectCode: string
  subcontractorName: string
  subcontractorContact: string | null
  description: string
  grossAmount: number
  retainageAmount: number
  netAmount: number
  currency: string
  paidAt: string
}

const pageWidth = 612
const pageHeight = 792
const margin = 54
const ink = rgb(0.07, 0.14, 0.12)
const forest = rgb(0.06, 0.27, 0.22)
const muted = rgb(0.38, 0.44, 0.42)
const line = rgb(0.85, 0.87, 0.85)

function cleanText(value: string | null | undefined): string {
  return (value ?? 'Not provided')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100)
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = cleanText(text).split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word

    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate
      continue
    }

    if (current) lines.push(current)
    current = word
  }

  if (current) lines.push(current)
  return lines
}

function drawLabelValue(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number,
): number {
  page.drawText(label.toUpperCase(), {
    x,
    y,
    size: 8,
    font: bold,
    color: muted,
  })

  const lines = wrapText(value, regular, 10.5, width)
  lines.forEach((lineText, index) => {
    page.drawText(lineText, {
      x,
      y: y - 16 - index * 14,
      size: 10.5,
      font: regular,
      color: ink,
    })
  })

  return y - 16 - lines.length * 14
}

export async function buildWaiverPdf(data: WaiverPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([pageWidth, pageHeight])
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const generatedAt = new Date()

  pdf.setTitle(`Payment waiver record ${data.paymentReference.slice(0, 8)}`)
  pdf.setAuthor(data.organizationName)
  pdf.setSubject('Payment confirmation and waiver record')
  pdf.setCreator('TradeLedger')
  pdf.setProducer('TradeLedger')
  pdf.setCreationDate(generatedAt)
  pdf.setModificationDate(generatedAt)

  page.drawRectangle({
    x: 0,
    y: pageHeight - 128,
    width: pageWidth,
    height: 128,
    color: forest,
  })
  page.drawText('TRADELEDGER', {
    x: margin,
    y: pageHeight - 48,
    size: 9,
    font: bold,
    color: rgb(0.79, 0.94, 0.61),
  })
  page.drawText('Payment Waiver Record', {
    x: margin,
    y: pageHeight - 82,
    size: 24,
    font: bold,
    color: rgb(1, 1, 1),
  })
  page.drawText(`Reference ${data.paymentReference.slice(0, 8).toUpperCase()}`, {
    x: margin,
    y: pageHeight - 106,
    size: 10,
    font: regular,
    color: rgb(0.84, 0.9, 0.87),
  })

  let y = pageHeight - 170
  y = drawLabelValue(
    page,
    regular,
    bold,
    'Organization',
    cleanText(data.organizationName),
    margin,
    y,
    230,
  )
  drawLabelValue(
    page,
    regular,
    bold,
    'Paid on',
    new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(data.paidAt)),
    332,
    pageHeight - 170,
    220,
  )

  y -= 12
  page.drawLine({
    start: { x: margin, y },
    end: { x: pageWidth - margin, y },
    color: line,
  })
  y -= 28

  y = drawLabelValue(
    page,
    regular,
    bold,
    'Project',
    `${cleanText(data.projectName)} (${cleanText(data.projectCode)})`,
    margin,
    y,
    230,
  )
  drawLabelValue(
    page,
    regular,
    bold,
    'Payee / subcontractor',
    `${cleanText(data.subcontractorName)} - ${cleanText(data.subcontractorContact)}`,
    332,
    y + 30,
    220,
  )

  y -= 18
  y = drawLabelValue(
    page,
    regular,
    bold,
    'Work description',
    data.description,
    margin,
    y,
    pageWidth - margin * 2,
  )
  y -= 18

  page.drawRectangle({
    x: margin,
    y: y - 90,
    width: pageWidth - margin * 2,
    height: 96,
    color: rgb(0.96, 0.96, 0.93),
    borderColor: line,
    borderWidth: 1,
  })

  const amounts: Array<readonly [string, string]> = [
    ['Gross amount', formatMoney(data.grossAmount, data.currency)],
    ['Retainage', formatMoney(data.retainageAmount, data.currency)],
    ['Net payment', formatMoney(data.netAmount, data.currency)],
  ]
  amounts.forEach(([label, value], index) => {
    const x = margin + 18 + index * 168
    page.drawText(label.toUpperCase(), {
      x,
      y: y - 25,
      size: 8,
      font: bold,
      color: muted,
    })
    page.drawText(value, {
      x,
      y: y - 54,
      size: index === 2 ? 16 : 13,
      font: bold,
      color: index === 2 ? forest : ink,
    })
  })

  y -= 126
  page.drawText('ACKNOWLEDGMENT', {
    x: margin,
    y,
    size: 9,
    font: bold,
    color: forest,
  })
  y -= 24

  const acknowledgment =
    'This record confirms receipt of the net payment shown above for the described work. It preserves the payment facts recorded by TradeLedger at the time of generation. Any later refund automatically voids this document in the application ledger.'
  for (
    const lineText of wrapText(acknowledgment, regular, 10.5, pageWidth - margin * 2)
  ) {
    page.drawText(lineText, { x: margin, y, size: 10.5, font: regular, color: ink })
    y -= 15
  }

  y -= 14
  const disclaimer =
    'Demonstration document only. This artifact is not legal advice and does not replace a jurisdiction-specific, signed lien waiver.'
  for (const lineText of wrapText(disclaimer, regular, 9, pageWidth - margin * 2)) {
    page.drawText(lineText, { x: margin, y, size: 9, font: regular, color: muted })
    y -= 13
  }

  page.drawLine({
    start: { x: margin, y: 68 },
    end: { x: pageWidth - margin, y: 68 },
    color: line,
  })
  page.drawText(`Request ${data.paymentRequestId}`, {
    x: margin,
    y: 46,
    size: 7.5,
    font: regular,
    color: muted,
  })
  page.drawText('Generated by TradeLedger', {
    x: pageWidth - margin - 92,
    y: 46,
    size: 7.5,
    font: bold,
    color: muted,
  })

  return pdf.save()
}
