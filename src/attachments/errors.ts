export class AttachmentError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_attachment") {
    super(message);
  }
}

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AttachmentError("Attachment extraction was cancelled", 499, "attachment_extraction_aborted");
  }
}
