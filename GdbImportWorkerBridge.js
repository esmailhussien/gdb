import { getOrRestoreSupabaseSession } from '../storage/supabaseClient.js';

// Development uploads stay on the Vite origin and are forwarded by the
// server-side proxy. This avoids treating the browser/device itself as the
// GDAL host and keeps Render's CORS allowlist narrow.
const DEFAULT_DEV_WORKER_URL = '/gdb-worker/convert-filegdb';
const DEFAULT_HOSTED_WORKER_URL = 'https://gdb.geova.net/convert-filegdb';
const DEFAULT_WORKER_WAKE_TIMEOUT_MS = 120_000;
const DEFAULT_WAKE_ATTEMPT_TIMEOUT_MS = 35_000;
const DEFAULT_WAKE_RETRY_DELAY_MS = 3_000;
const RAW_WORKER_URL = String(import.meta.env?.VITE_GDB_IMPORT_WORKER_URL || '').trim();
const WORKER_URL = RAW_WORKER_URL || (import.meta.env?.DEV
    ? DEFAULT_DEV_WORKER_URL
    : DEFAULT_HOSTED_WORKER_URL);
let workerUrlTestOverride = null;
let workerReadinessCheckTestOverride = null;

function currentWorkerUrl() {
    return workerUrlTestOverride === null ? WORKER_URL : workerUrlTestOverride;
}

/**
 * Test-only configuration seam. Production callers should not use this.
 * Passing no URL restores the build-time Vite configuration.
 */
export function __setGdbImportWorkerUrlForTests(workerUrl) {
    workerUrlTestOverride = workerUrl === undefined ? null : String(workerUrl || '').trim();
}

/** Test-only seam used to keep conversion contract tests deterministic. */
export function __setGdbImportWorkerReadinessCheckForTests(check) {
    workerReadinessCheckTestOverride = check === undefined ? null : check;
}

function abortError(signal) {
    if (signal?.reason instanceof Error) return signal.reason;
    return new DOMException('FileGDB conversion cancelled.', 'AbortError');
}

function workerExportUrl(workerUrl) {
    const value = String(workerUrl || '').trim();
    if (!value) return '';
    if (value.startsWith('/')) {
        return value.replace(/\/convert-filegdb\/?(?:\?.*)?$/i, '/export-filegdb');
    }
    try {
        const url = new URL(value);
        url.pathname = url.pathname.replace(/\/convert-filegdb\/?$/i, '/export-filegdb');
        url.search = '';
        url.hash = '';
        return url.href;
    } catch (_) {
        return '';
    }
}

function workerHealthUrl(workerUrl) {
    const value = String(workerUrl || '').trim();
    if (!value) return '';
    if (value.startsWith('/')) {
        return value.replace(/\/(?:convert|export)-filegdb\/?(?:\?.*)?$/i, '/health');
    }

    try {
        const url = new URL(value);
        url.pathname = url.pathname.replace(/\/(?:convert|export)-filegdb\/?$/i, '/health');
        url.search = '';
        url.hash = '';
        return url.href;
    } catch (_) {
        return '';
    }
}

function waitBeforeWakeRetry(delayMs, signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', cancel);
            resolve();
        }, Math.max(0, delayMs));
        const cancel = () => {
            clearTimeout(timer);
            reject(abortError(signal));
        };
        signal?.addEventListener('abort', cancel, { once: true });
    });
}

async function probeWorkerHealth(healthUrl, { signal, attemptTimeoutMs }) {
    if (signal?.aborted) throw abortError(signal);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1, attemptTimeoutMs));

    try {
        // Any readable HTTP response proves the service is awake. The provided
        // worker returns 200 JSON; custom workers may use another status.
        await fetch(healthUrl, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal
        });
        return true;
    } catch (_) {
        if (signal?.aborted) throw abortError(signal);
        return false;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
    }
}

/**
 * Wake a sleeping hosted worker before transmitting a potentially large ZIP.
 * Render free services can cold-start slowly; retrying this small health call
 * is safer than automatically replaying a multipart conversion request.
 */
export async function waitForGdbImportWorkerReady(workerUrl, {
    signal = null,
    onProgress = null,
    timeoutMs = DEFAULT_WORKER_WAKE_TIMEOUT_MS,
    attemptTimeoutMs = DEFAULT_WAKE_ATTEMPT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_WAKE_RETRY_DELAY_MS
} = {}) {
    if (workerReadinessCheckTestOverride) {
        return workerReadinessCheckTestOverride(workerUrl, { signal, onProgress });
    }
    if (globalThis.navigator?.onLine === false) {
        throw new Error('FileGDB conversion requires an internet connection to reach the GDAL worker.');
    }

    const healthUrl = workerHealthUrl(workerUrl);
    if (!healthUrl) return;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    onProgress?.({
        phase: 'wake',
        percent: 3,
        message: 'Waking the FileGDB conversion server...'
    });

    while (Date.now() < deadline) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const ready = await probeWorkerHealth(healthUrl, {
            signal,
            attemptTimeoutMs: Math.min(attemptTimeoutMs, remainingMs)
        });
        if (ready) return;

        const retryMs = Math.min(retryDelayMs, Math.max(0, deadline - Date.now()));
        if (retryMs > 0) await waitBeforeWakeRetry(retryMs, signal);
    }

    throw new Error('FileGDB worker did not become ready within two minutes. The free service may be suspended or unavailable.');
}

async function currentUserAuthorization() {
    try {
        const session = await getOrRestoreSupabaseSession();
        const accessToken = String(session?.access_token || '').trim();
        return accessToken ? `Bearer ${accessToken}` : '';
    } catch (_) {
        // Local worker development can explicitly opt into unauthenticated
        // mode. Production workers fail closed and return a clear 401/503.
        return '';
    }
}

function isSameWorkerOrigin(candidateUrl, workerUrl) {
    try {
        return new URL(candidateUrl, workerUrl).origin === new URL(workerUrl).origin;
    } catch (_) {
        return false;
    }
}

function filenameFromDisposition(disposition) {
    const value = String(disposition || '');
    const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
        try { return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, '')); }
        catch (_) { return utf8Match[1].trim().replace(/^"|"$/g, ''); }
    }

    const plainMatch = value.match(/filename="?([^";]+)"?/i);
    return plainMatch?.[1]?.trim() || '';
}

function fileFromBlob(blob, filename, fallbackType = '') {
    const type = blob.type || fallbackType || 'application/octet-stream';
    try {
        return new File([blob], filename, { type });
    } catch (_) {
        blob.name = filename;
        return blob;
    }
}

function base64ToFile(base64, filename, mimeType) {
    const clean = String(base64 || '').replace(/^data:[^,]+,/, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return fileFromBlob(new Blob([bytes], { type: mimeType || 'application/octet-stream' }), filename, mimeType);
}

async function errorMessageFromResponse(response) {
    try {
        const body = await response.clone().json();
        return body?.error || body?.message || body?.detail || '';
    } catch (_) {
        try { return await response.clone().text(); }
        catch (_) { return ''; }
    }
}

export function isGdbImportWorkerConfigured() {
    return Boolean(currentWorkerUrl());
}

export function isLikelyGdbZipName(name) {
    return /\.gdb\.zip$/i.test(String(name || '').trim());
}

export async function convertGdbZipToImportFile(file, options = {}) {
    const {
        projectId = '',
        targetLayerId = '',
        onProgress = null,
        signal = null
    } = options;

    if (!file) throw new Error('No FileGDB archive selected.');
    const workerUrl = currentWorkerUrl();
    if (!workerUrl) {
        throw new Error('File geodatabase import needs the GDAL worker. Configure VITE_GDB_IMPORT_WORKER_URL for this build.');
    }

    await waitForGdbImportWorkerReady(workerUrl, { signal, onProgress });
    onProgress?.({ phase: 'upload', percent: 8, message: 'Uploading FileGDB archive...' });

    const formData = new FormData();
    formData.append('file', file, file.name || 'mapplex_import.gdb.zip');
    if (projectId) formData.append('project_id', String(projectId));
    if (targetLayerId) formData.append('target_layer_id', String(targetLayerId));
    formData.append('return_format', 'gpkg');
    formData.append('include_domains', 'true');

    const headers = new Headers({
        Accept: 'application/geopackage+sqlite3, application/zip, application/json'
    });
    const auth = await currentUserAuthorization();
    if (auth) headers.set('Authorization', auth);

    let response;
    try {
        response = await fetch(workerUrl, {
            method: 'POST',
            headers,
            body: formData,
            signal
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new Error(`FileGDB worker is not reachable at ${workerUrl}. Check the hosted worker or development proxy, then retry the import.`);
    }

    if (!response.ok) {
        const detail = await errorMessageFromResponse(response);
        throw new Error(detail || `FileGDB worker failed with HTTP ${response.status}.`);
    }

    onProgress?.({ phase: 'convert', percent: 60, message: 'Converting FileGDB with GDAL...' });

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const payload = await response.json();

        if (payload.downloadUrl || payload.download_url) {
            const rawDownloadUrl = payload.downloadUrl || payload.download_url;
            const url = new URL(rawDownloadUrl, workerUrl).href;
            const downloadHeaders = new Headers();
            // Never forward a user access token to a different origin. A
            // cross-origin download URL must be independently signed.
            if (auth && isSameWorkerOrigin(url, workerUrl)) {
                downloadHeaders.set('Authorization', auth);
            }
            const downloadResponse = await fetch(url, { headers: downloadHeaders, signal });
            if (!downloadResponse.ok) {
                throw new Error(`Converted FileGDB download failed with HTTP ${downloadResponse.status}.`);
            }
            const blob = await downloadResponse.blob();
            const filename = payload.filename || filenameFromDisposition(downloadResponse.headers.get('content-disposition')) || 'filegdb_import.gpkg';
            onProgress?.({ phase: 'download', percent: 90, message: 'Downloading converted GeoPackage...' });
            return fileFromBlob(blob, filename, blob.type || 'application/geopackage+sqlite3');
        }

        if (payload.fileBase64 || payload.gpkgBase64) {
            const filename = payload.filename || 'filegdb_import.gpkg';
            const mimeType = payload.mimeType || 'application/geopackage+sqlite3';
            onProgress?.({ phase: 'download', percent: 90, message: 'Preparing converted GeoPackage...' });
            return base64ToFile(payload.fileBase64 || payload.gpkgBase64, filename, mimeType);
        }

        throw new Error('FileGDB worker returned JSON without a converted file.');
    }

    const blob = await response.blob();
    const filename = filenameFromDisposition(response.headers.get('content-disposition')) || 'filegdb_import.gpkg';
    onProgress?.({ phase: 'download', percent: 90, message: 'Preparing converted GeoPackage...' });
    return fileFromBlob(blob, filename, blob.type || 'application/geopackage+sqlite3');
}

export async function convertGpkgToGdbZip(file, options = {}) {
    const {
        projectId = '',
        projectName = '',
        onProgress = null,
        signal = null
    } = options;

    if (!file) throw new Error('No GeoPackage was prepared for FileGDB export.');
    const configuredWorkerUrl = currentWorkerUrl();
    const exportUrl = workerExportUrl(configuredWorkerUrl);
    if (!configuredWorkerUrl || !exportUrl) {
        throw new Error('File geodatabase export needs the GDAL worker. Configure VITE_GDB_IMPORT_WORKER_URL for this build.');
    }

    await waitForGdbImportWorkerReady(exportUrl, { signal, onProgress });
    onProgress?.({ phase: 'upload', percent: 12, message: 'Uploading the prepared GeoPackage...' });

    const formData = new FormData();
    formData.append('file', file, file.name || 'mapplex_export.gpkg');
    if (projectId) formData.append('project_id', String(projectId));
    if (projectName) formData.append('project_name', String(projectName));
    formData.append('return_format', 'gdb_zip');

    const headers = new Headers({ Accept: 'application/zip, application/json' });
    const auth = await currentUserAuthorization();
    if (auth) headers.set('Authorization', auth);

    let response;
    try {
        response = await fetch(exportUrl, {
            method: 'POST',
            headers,
            body: formData,
            signal
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new Error(`FileGDB worker is not reachable at ${exportUrl}. Check the hosted worker or development proxy, then retry the export.`);
    }

    if (!response.ok) {
        const detail = await errorMessageFromResponse(response);
        throw new Error(detail || `FileGDB export failed with HTTP ${response.status}.`);
    }

    onProgress?.({ phase: 'convert', percent: 65, message: 'Creating the FileGDB with GDAL...' });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const payload = await response.json();
        if (payload.downloadUrl || payload.download_url) {
            const rawDownloadUrl = payload.downloadUrl || payload.download_url;
            const url = new URL(rawDownloadUrl, exportUrl).href;
            const downloadHeaders = new Headers();
            if (auth && isSameWorkerOrigin(url, exportUrl)) downloadHeaders.set('Authorization', auth);
            const downloadResponse = await fetch(url, { headers: downloadHeaders, signal });
            if (!downloadResponse.ok) {
                throw new Error(`FileGDB archive download failed with HTTP ${downloadResponse.status}.`);
            }
            const blob = await downloadResponse.blob();
            const filename = payload.filename
                || filenameFromDisposition(downloadResponse.headers.get('content-disposition'))
                || 'mapplex_export.gdb.zip';
            onProgress?.({ phase: 'download', percent: 92, message: 'Preparing the FileGDB archive...' });
            return fileFromBlob(blob, filename, blob.type || 'application/zip');
        }
        if (payload.fileBase64 || payload.gdbZipBase64) {
            const filename = payload.filename || 'mapplex_export.gdb.zip';
            onProgress?.({ phase: 'download', percent: 92, message: 'Preparing the FileGDB archive...' });
            return base64ToFile(payload.fileBase64 || payload.gdbZipBase64, filename, payload.mimeType || 'application/zip');
        }
        throw new Error('FileGDB worker returned JSON without an exported archive.');
    }

    const blob = await response.blob();
    const filename = filenameFromDisposition(response.headers.get('content-disposition')) || 'mapplex_export.gdb.zip';
    onProgress?.({ phase: 'download', percent: 92, message: 'Preparing the FileGDB archive...' });
    return fileFromBlob(blob, filename, blob.type || 'application/zip');
}
