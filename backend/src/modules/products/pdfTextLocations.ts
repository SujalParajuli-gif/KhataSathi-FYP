export type PdfTextLineRegion = {
  text: string;
  region: { top: number; left: number; bottom: number; right: number; scale: 1000 };
};

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export async function extractPdfTextLineRegions(buffer: Buffer) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: new Uint8Array(buffer) }).promise;
  try {
    const pages: Array<{ pageNumber: number; lines: PdfTextLineRegion[] }> = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items
        .filter((item: any) => typeof item?.str === "string" && compact(item.str))
        .map((item: any) => ({
          text: compact(item.str),
          x: Number(item.transform?.[4] || 0),
          y: Number(item.transform?.[5] || 0),
          width: Math.max(1, Number(item.width || 0)),
          height: Math.max(1, Number(item.height || Math.abs(item.transform?.[3] || 0) || 8)),
        }));
      const groups: typeof items[] = [];
      for (const item of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
        const group = groups.find((candidate) => Math.abs(candidate[0].y - item.y) <= 2.5);
        if (group) group.push(item);
        else groups.push([item]);
      }
      const lines = groups.map((group) => {
        const ordered = group.sort((a, b) => a.x - b.x);
        const left = Math.min(...ordered.map((item) => item.x));
        const right = Math.max(...ordered.map((item) => item.x + item.width));
        const pdfBottom = Math.min(...ordered.map((item) => item.y - item.height * 0.2));
        const pdfTop = Math.max(...ordered.map((item) => item.y + item.height));
        return {
          text: compact(ordered.map((item) => item.text).join(" ")),
          region: {
            top: Math.max(0, Math.round(((viewport.height - pdfTop - 2) / viewport.height) * 1000)),
            left: Math.max(0, Math.round(((left - 2) / viewport.width) * 1000)),
            bottom: Math.min(1000, Math.round(((viewport.height - pdfBottom + 2) / viewport.height) * 1000)),
            right: Math.min(1000, Math.round(((right + 2) / viewport.width) * 1000)),
            scale: 1000 as const,
          },
        };
      });
      pages.push({ pageNumber, lines });
    }
    return pages;
  } finally {
    await document.destroy();
  }
}
