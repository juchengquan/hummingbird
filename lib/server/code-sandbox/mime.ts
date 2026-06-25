import "server-only"

/** Minimal extension→MIME map for files the code interpreter writes to
 *  the output dir. The sandbox is airgapped, so we infer from the name
 *  rather than sniff bytes. Unknown extensions → octet-stream (the
 *  browser still downloads it; only the chip icon is generic). */
const MIME_BY_EXT: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  pdf: "application/pdf",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  parquet: "application/vnd.apache.parquet",
}

export function mimeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase()
  if (!ext || ext === name.toLowerCase()) return "application/octet-stream"
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}
