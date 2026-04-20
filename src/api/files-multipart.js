function parseMultipart(buffer, boundary) {
  const boundaryStr = `--${boundary}`;
  const str = buffer.toString("latin1");
  const parts = str.split(boundaryStr).filter((p) => p.trim() && p.trim() !== "--");
  let file = null;
  let filename = null;
  let mimeType = null;
  let purpose = null;

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.substring(0, headerEnd);
    const body = part.substring(headerEnd + 4).replace(/\r\n$/, "");

    if (headers.includes('name="purpose"')) {
      purpose = body.trim();
    } else if (headers.includes('name="file"') || headers.includes("filename=")) {
      const fnMatch = headers.match(/filename="([^"]+)"/);
      if (fnMatch) filename = fnMatch[1];
      const ctMatch = headers.match(/Content-Type:\s*(.+)/i);
      if (ctMatch) mimeType = ctMatch[1].trim();
      file = Buffer.from(body, "latin1");
    }
  }

  return { file, filename, mimeType, purpose };
}

module.exports = { parseMultipart };
