// How an attached image's size is written, for every composer.
//
// It lived in `local/image-attachments.js`, which the shared Orchestrator pane
// cannot import — so that pane showed no size at all, and the same paste
// produced a visibly different chip in each of the two composers this document
// renders. The reader is one number in one format or it is two behaviours.

/**
 * @param {number} bytes
 * @returns {string} e.g. "12 KB", "1.4 MB"
 */
export function formatAttachmentBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
