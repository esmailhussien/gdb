/**
 * FileImportService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Mapplex — Phase 1: Main Thread Liberation
 *
 * Singleton service that manages the geo-parser Web Worker.
 * The main thread never parses a file directly — it delegates here.
 *
 * Key guarantees:
 *  - Worker is instantiated ONCE and reused across all imports.
 *  - Abort cancels the worker cleanly and spins up a fresh replacement.
 *  - Progress callbacks keep the UI live during parsing.
 *  - KMZ pre-extraction still happens on main thread (JSZip),
 *    then the inner KML text is sent to the worker as UTF-8 bytes.
 *  - onChunk callbacks are processed SEQUENTIALLY via a Promise queue,
 *    preventing concurrent SQLite transactions on Android (which crash with
 *    "Failed in beginTransaction: Already in transaction").
 */

export class FileImportService {
  #worker = null;
  #abortController = null;
  #taskCallbacks = new Map(); // taskId -> { resolve, reject, onProgress, onChunk }

  // ── Chunk Processing Queue ─────────────────────────────────────────────────
  // Ensures async onChunk callbacks (which do SQLite putBatch writes) are
  // processed SEQUENTIALLY. Without this, the worker sends chunks faster than
  // the DB can commit them, causing concurrent beginTransaction() calls that
  // crash on Android SQLite with "Already in transaction".
  #chunkQueue = Promise.resolve();

  constructor() {}

  _initWorker() {
    if (this.#worker) return this.#worker;

    // Vite handles worker bundling automatically with ?worker suffix
    // For the plain URL approach (Capacitor-safe), use explicit URL constructor:
    this.#worker = new Worker(new URL('../workers/geo-parser.worker.js', import.meta.url), {
      type: 'module'
    });
    this.#worker.onmessage = this._handleWorkerMessage.bind(this);
    this.#worker.onerror = (e) => {
      const message = [
        e?.message || 'Worker failed to load or crashed.',
        e?.filename ? `file: ${e.filename}` : '',
        e?.lineno ? `line: ${e.lineno}` : '',
        e?.colno ? `column: ${e.colno}` : ''
      ].filter(Boolean).join(' ');

      console.error('[FileImportService] Worker error:', message, e);
      this._rejectAllPending(new Error(message));
      this.#worker?.terminate();
      this.#worker = null;
    };
    this.#worker.onmessageerror = (e) => {
      const err = new Error('Worker message could not be cloned.');
      console.error('[FileImportService] Worker message error:', e);
      this._rejectAllPending(err);
    };

    return this.#worker;
  }

  _rejectAllPending(err) {
    for (const [, cb] of this.#taskCallbacks) {
      cb.reject(err);
    }
    this.#taskCallbacks.clear();
  }

  /**
   * Parse a File object using the Web Worker.
   *
   * @param {File} file — The raw File object
   * @param {function(number, string): void} [onProgress] — (percent, stageLabel) callback
   * @param {function(Array, number): Promise<void>} [onChunk] — Receiver for streamed record chunks
   * @param {string} [kmlOverrideText] — Pre-extracted KML text (for KMZ files)
   * @returns {Promise<{ format: string, count: number }>}
   */
  async parseFile(file, onProgress, onChunk = null, kmlOverrideText = null) {
    const taskId = crypto.randomUUID();
    this.#abortController = new AbortController();
    // Reset the chunk queue for each new import task
    this.#chunkQueue = Promise.resolve();
    const worker = this._initWorker();

    return new Promise(async (resolve, reject) => {
      this.#taskCallbacks.set(taskId, { resolve, reject, onProgress, onChunk, chunkError: null });

      // Wire up the abort signal
      this.#abortController.signal.addEventListener('abort', () => {
        // Terminate the worker — there's no way to interrupt mid-parse otherwise
        worker.terminate();
        if (this.#worker === worker) this.#worker = null;
        this.#taskCallbacks.delete(taskId);
        reject(new DOMException('File import cancelled by user.', 'AbortError'));
      }, { once: true });

      try {
        let fileBuffer;
        let fileName;

        if (kmlOverrideText) {
          // KMZ pre-extracted path: encode text -> buffer
          const encoder = new TextEncoder();
          fileBuffer = encoder.encode(kmlOverrideText).buffer;
          fileName = file.name.replace(/\.kmz$/i, '.kml');
        } else {
          // Standard path: read the file as ArrayBuffer (non-blocking on modern browsers)
          fileName = file.name;
          fileBuffer = await file.arrayBuffer();
        }

        // Transfer the buffer (zero-copy) to the worker thread
        worker.postMessage({ taskId, fileBuffer, fileName }, [fileBuffer]);

      } catch (err) {
        this.#taskCallbacks.delete(taskId);
        reject(err);
      }
    });
  }

  /**
   * Abort any in-progress parse operation.
   * The returned promise will reject with AbortError.
   */
  abort() {
    this.#abortController?.abort();
  }

  _handleWorkerMessage({ data }) {
    const cb = this.#taskCallbacks.get(data.taskId);
    if (!cb) return;

    switch (data.type) {
      case 'PROGRESS':
        cb.onProgress?.(data.percent, data.stage);
        break;

      case 'CHUNK':
        // ── SEQUENTIAL CHUNK PROCESSING ─────────────────────────────────────
        // The onChunk callback is async (it writes to SQLite via putBatch).
        // We MUST await each chunk before processing the next one. Without
        // this queue, the worker floods the main thread with chunks faster
        // than SQLite can commit, causing concurrent beginTransaction() crashes
        // on Android: "Failed in beginTransaction: Already in transaction".
        if (cb.onChunk) {
          this.#chunkQueue = this.#chunkQueue.then(async () => {
            if (cb.chunkError) return;
            try {
              await cb.onChunk(data.chunk, data.percent);
            } catch (err) {
              cb.chunkError = err instanceof Error ? err : new Error(String(err));
              this.#taskCallbacks.delete(data.taskId);
              cb.reject(cb.chunkError);
            }
          });
        }
        break;

      case 'DONE':
        // Wait for ALL pending chunk DB writes to finish before resolving.
        // This ensures the caller sees a completed import, not a partial one.
        this.#chunkQueue.then(() => {
          if (cb.chunkError) return;
          this.#taskCallbacks.delete(data.taskId);
          cb.resolve(data.result);
        });
        break;

      case 'ERROR':
        this.#taskCallbacks.delete(data.taskId);
        cb.reject(new Error(data.error));
        break;
    }
  }
}

// Export a singleton — one worker for the entire app lifecycle
export const fileImportService = new FileImportService();
