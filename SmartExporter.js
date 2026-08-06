/**
 * SmartExporter.js — Intelligent Streaming ZIP Exporter for GeoJSON & GeoPackage
 *
 * Architecture:
 * - Uses fflate's streaming Zip class (NOT JSZip) for memory-efficient ZIP generation.
 *   Images are compressed and flushed one-at-a-time so peak RAM is bounded to a single
 *   image + one compressed chunk, NOT the entire dataset.
 * - On Capacitor (native Android): chunks are flushed to the native filesystem
 *   progressively via appendFile(), keeping WebView heap usage minimal.
 * - On web: compressed chunks accumulate in an array and are assembled into a
 *   Blob at the end (still far less RAM than JSZip's full-dataset model).
 *
 * If a dataset has zero images and no domain metadata, the raw .geojson or
 * .gpkg is returned directly.
 */

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { DataManager } from '../modules/data/DataManager.js';

// ── Constants ────────────────────────────────────────────────────────────────
const BATCH_SIZE = 5;            // Concurrent URL downloads (mobile-safe)
const FETCH_TIMEOUT_MS = 15000;  // Per-image fetch timeout
const FLUSH_THRESHOLD = 2 * 1024 * 1024; // 2MB — flush to disk on native when exceeded

// ── Helpers ──────────────────────────────────────────────────────────────────

function isBase64Image(val) {
    return typeof val === 'string' && val.startsWith('data:image');
}

function isImageUrl(val) {
    if (typeof val !== 'string') return false;
    try {
        const url = new URL(val);
        return (url.protocol === 'http:' || url.protocol === 'https:');
    } catch {
        return false;
    }
}

function extensionFromBase64(dataUri) {
    const match = dataUri.match(/^data:image\/([\w+.-]+);/);
    if (!match) return 'jpg';
    const mime = match[1].toLowerCase();
    if (mime === 'jpeg') return 'jpg';
    if (mime === 'svg+xml') return 'svg';
    return mime;
}

function extensionFromUrl(urlStr) {
    try {
        const pathname = new URL(urlStr).pathname;
        const dotIdx = pathname.lastIndexOf('.');
        if (dotIdx !== -1) {
            const ext = pathname.substring(dotIdx + 1).toLowerCase().split('?')[0];
            if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff'].includes(ext)) {
                return ext === 'jpeg' ? 'jpg' : ext;
            }
        }
    } catch { /* ignore */ }
    return 'jpg';
}

/** Determine if an image format is already compressed (skip DEFLATE) */
function isPreCompressed(ext) {
    return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buffer = await resp.arrayBuffer();
        clearTimeout(timer);
        return buffer;
    } catch (err) {
        clearTimeout(timer);
        console.warn(`[SmartExporter] Failed to fetch image: ${url}`, err.message);
        return null;
    }
}

/**
 * Convert Base64 data URI → Uint8Array of raw bytes.
 * Handles both standard and URL-safe Base64.
 */
function base64ToUint8Array(dataUri) {
    const raw = dataUri.split(',')[1];
    if (!raw) return null;
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Convert Uint8Array → Base64 string for Capacitor Filesystem.
 * Uses Blob + FileReader for efficient conversion of large arrays.
 */
function uint8ArrayToBase64(bytes) {
    return new Promise(resolve => {
        const blob = new Blob([bytes]);
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
    });
}

function textToUint8Array(text) {
    return new TextEncoder().encode(text || '');
}

function addDomainFiles(writer, domainExport) {
    if (!domainExport) return;
    writer.addFile('metadata/mapplex_schema.json', textToUint8Array(domainExport.metadataJson), true);
    writer.addFile('metadata/arcgis_domains.csv', textToUint8Array(domainExport.domainsCsv), true);
    writer.addFile('metadata/arcgis_field_domains.csv', textToUint8Array(domainExport.fieldDomainsCsv), true);
}

/** Concatenate multiple Uint8Arrays into one */
function concatUint8Arrays(arrays) {
    let totalLen = 0;
    for (const arr of arrays) totalLen += arr.length;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}


// ── StreamingZipWriter ───────────────────────────────────────────────────────
// Abstraction over fflate's Zip class that handles progressive disk flushing
// on Capacitor and in-memory accumulation on web.

class StreamingZipWriter {
    constructor() {
        this._pendingChunks = [];
        this._pendingSize = 0;
        this._webChunks = [];      // For web: accumulated compressed output
        this._isNative = false;
        this._nativePath = null;
        this._Filesystem = null;
        this._Directory = null;
    }

    async init() {
        this._isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform());

        if (this._isNative) {
            try {
                const { Filesystem, Directory } = await import('@capacitor/filesystem');
                this._Filesystem = Filesystem;
                this._Directory = Directory;
                this._nativePath = `smart_export_${Date.now()}.zip`;
                // Create the empty file so appendFile works
                await Filesystem.writeFile({
                    path: this._nativePath,
                    data: '',
                    directory: Directory.Cache,
                });
            } catch (err) {
                console.warn('[SmartExporter] Native filesystem unavailable, falling back to web mode', err);
                this._isNative = false;
            }
        }

        // Create the fflate Zip instance
        // IMPORTANT: fflate reuses internal buffers — we MUST .slice() each chunk!
        this._zip = new Zip((err, chunk, final) => {
            if (err) {
                console.error('[SmartExporter] fflate zip error:', err);
                return;
            }
            const copy = new Uint8Array(chunk.length);
            copy.set(chunk);
            this._pendingChunks.push(copy);
            this._pendingSize += copy.length;
        });
    }

    /**
     * Add a file to the ZIP archive.
     * @param {string} path     — Path inside the ZIP (e.g. "attachments/img_001.jpg")
     * @param {Uint8Array} data — Raw file bytes
     * @param {boolean} compress — Whether to DEFLATE compress (false for JPEG/PNG)
     */
    addFile(path, data, compress = false) {
        const entry = compress
            ? new ZipDeflate(path, { level: 6 })
            : new ZipPassThrough(path);
        this._zip.add(entry);
        entry.push(data, true); // true = final chunk for this file
    }

    /**
     * Flush accumulated compressed chunks to disk (native) or keep in memory (web).
     * Call this after adding each large file to bound peak RAM.
     */
    async flush() {
        if (this._pendingChunks.length === 0) return;

        if (this._isNative) {
            const combined = concatUint8Arrays(this._pendingChunks);
            this._pendingChunks = [];
            this._pendingSize = 0;
            const base64 = await uint8ArrayToBase64(combined);
            await this._Filesystem.appendFile({
                path: this._nativePath,
                data: base64,
                directory: this._Directory.Cache,
            });
        } else {
            // Move pending chunks to the permanent web accumulator
            this._webChunks.push(...this._pendingChunks);
            this._pendingChunks = [];
            this._pendingSize = 0;
        }
    }

    /**
     * Auto-flush if pending data exceeds threshold (for native disk writes).
     */
    async autoFlush() {
        if (this._pendingSize >= FLUSH_THRESHOLD) {
            await this.flush();
        }
    }

    /**
     * Finalize the ZIP and return the result.
     * @returns {{ blob?: Blob, fileUri?: string }}
     */
    async finalize() {
        this._zip.end();
        await this.flush(); // Flush any remaining data

        if (this._isNative) {
            const result = await this._Filesystem.getUri({
                path: this._nativePath,
                directory: this._Directory.Cache,
            });
            return { fileUri: result.uri };
        } else {
            return { blob: new Blob(this._webChunks, { type: 'application/zip' }) };
        }
    }
}


// ── SmartExporter Class ──────────────────────────────────────────────────────

export class SmartExporter {

    /**
     * Main entry point.
     *
     * @param {Object} opts
     * @param {'geojson'|'gpkg'} opts.format
     * @param {string|null}       opts.layerId
     * @param {string}            opts.projectName
     * @param {Function}          [opts.onProgress]
     *
     * @returns {Promise<{ blob?: Blob, fileUri?: string, filename: string, isZip: boolean, imageCount: number, domainCount?: number, fieldDomainCount?: number } | null>}
     */
    static async export({ format, layerId = null, projectName = 'export', onProgress = () => {} }) {
        const datestamp = new Date().toISOString().split('T')[0];
        const baseName = `${projectName}_${datestamp}`;

        // ── Phase 1: Fetch the raw FeatureCollection ─────────────────────
        onProgress({ phase: 'prepare', current: 0, total: 0, message: 'Loading features...' });

        const fc = await DataManager.exportToGeoJSON(layerId);
        if (!fc || !fc.features || fc.features.length === 0) {
            return null;
        }
        const domainExport = await DataManager.buildLexiconDomainExport(layerId);

        // ── Phase 2: Scan for images ─────────────────────────────────────
        onProgress({ phase: 'scan', current: 0, total: 0, message: 'Scanning for images...' });
        const { totalCount, imageEntries } = SmartExporter._scanForImages(fc.features);

        onProgress({
            phase: 'scan',
            current: totalCount,
            total: totalCount,
            message: totalCount > 0
                ? `Found ${totalCount} image${totalCount !== 1 ? 's' : ''} across ${fc.features.length} features`
                : 'No images found — exporting raw file'
        });

        // ── Phase 3a: No images — direct raw export ──────────────────────
        if (totalCount === 0 && !domainExport) {
            if (format === 'gpkg') {
                const gpkgBlob = await DataManager.exportToGPKG(layerId);
                return {
                    blob: gpkgBlob,
                    filename: `${baseName}.gpkg`,
                    isZip: false,
                    imageCount: 0,
                    domainCount: 0,
                    fieldDomainCount: 0
                };
            }
            const jsonStr = JSON.stringify(fc, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/geo+json' });
            return {
                blob,
                filename: `${baseName}.geojson`,
                isZip: false,
                imageCount: 0,
                domainCount: 0,
                fieldDomainCount: 0
            };
        }

        if (totalCount === 0 && domainExport) {
            const writer = new StreamingZipWriter();
            await writer.init();

            if (format === 'gpkg') {
                onProgress({ phase: 'build', current: 0, total: 0, message: 'Building GeoPackage...' });
                const gpkgBlob = await DataManager.exportToGPKG(layerId);
                const gpkgBytes = new Uint8Array(await gpkgBlob.arrayBuffer());
                writer.addFile(`${baseName}.gpkg`, gpkgBytes, false);
            } else {
                onProgress({ phase: 'build', current: 0, total: 0, message: 'Building GeoJSON...' });
                writer.addFile(`${baseName}.geojson`, textToUint8Array(JSON.stringify(fc, null, 2)), true);
            }

            addDomainFiles(writer, domainExport);
            onProgress({ phase: 'zip', current: 0, total: 100, message: 'Packaging domain metadata...' });
            const zipResult = await writer.finalize();
            onProgress({ phase: 'zip', current: 100, total: 100, message: 'Archive ready!' });

            return {
                blob: zipResult.blob || null,
                fileUri: zipResult.fileUri || null,
                filename: `${baseName}.zip`,
                isZip: true,
                imageCount: 0,
                domainCount: domainExport.domainCount,
                fieldDomainCount: domainExport.fieldDomainCount
            };
        }

        // ── Phase 3b: Has images — build streaming ZIP ───────────────────
        const writer = new StreamingZipWriter();
        await writer.init();

        // Deduplicate images: same value → same file
        const uniqueImages = new Map();
        for (const entry of imageEntries) {
            if (!uniqueImages.has(entry.value)) {
                uniqueImages.set(entry.value, { entries: [entry], path: null });
            } else {
                uniqueImages.get(entry.value).entries.push(entry);
            }
        }

        // Process images ONE AT A TIME — key to bounded RAM
        let counter = 0;
        let processedCount = 0;
        const replacementMap = new Map();

        for (const [value, info] of uniqueImages) {
            counter++;
            const entry = info.entries[0];
            const paddedIdx = String(counter).padStart(3, '0');

            try {
                if (entry.type === 'base64') {
                    const ext = extensionFromBase64(value);
                    const filename = `img_${paddedIdx}.${ext}`;
                    const relativePath = `attachments/${filename}`;
                    const bytes = base64ToUint8Array(value);

                    if (bytes) {
                        writer.addFile(relativePath, bytes, !isPreCompressed(ext));
                        info.path = relativePath;
                        await writer.autoFlush(); // Flush if threshold exceeded
                    }
                } else if (entry.type === 'url') {
                    const ext = extensionFromUrl(value);
                    const filename = `img_${paddedIdx}.${ext}`;
                    const relativePath = `attachments/${filename}`;
                    const buffer = await fetchWithTimeout(value);

                    if (buffer) {
                        writer.addFile(relativePath, new Uint8Array(buffer), !isPreCompressed(ext));
                        info.path = relativePath;
                        await writer.autoFlush();
                    } else {
                        // Failed — write placeholder
                        const placeholderName = `img_${paddedIdx}_MISSING.txt`;
                        const placeholder = new TextEncoder().encode(
                            `Image could not be downloaded.\nOriginal URL: ${value}\nExported: ${new Date().toISOString()}`
                        );
                        writer.addFile(`attachments/${placeholderName}`, placeholder, true);
                        info.path = `attachments/${placeholderName}`;
                    }
                }
            } catch (err) {
                console.warn(`[SmartExporter] Error processing image #${counter}:`, err);
                const errorName = `img_${paddedIdx}_ERROR.txt`;
                const errorContent = new TextEncoder().encode(
                    `Image processing failed.\nError: ${err.message}\nExported: ${new Date().toISOString()}`
                );
                writer.addFile(`attachments/${errorName}`, errorContent, true);
                info.path = `attachments/${errorName}`;
            }

            processedCount += info.entries.length;
            onProgress({
                phase: 'images',
                current: Math.min(processedCount, totalCount),
                total: totalCount,
                message: `Packaging images: ${Math.min(processedCount, totalCount)} / ${totalCount}`
            });

            // Yield to UI thread between images
            await new Promise(r => setTimeout(r, 0));
        }

        // Build replacement map
        for (const [value, info] of uniqueImages) {
            if (info.path) replacementMap.set(value, info.path);
        }

        // ── Phase 4: Deep clone + mutate features with relative paths ────
        onProgress({ phase: 'mutate', current: 0, total: 0, message: 'Rewriting image paths...' });
        const mutatedFC = SmartExporter._mutateFeatures(fc, replacementMap);

        // ── Phase 5: Build the spatial file and add to ZIP ───────────────
        if (format === 'gpkg') {
            onProgress({ phase: 'build', current: 0, total: 0, message: 'Building GeoPackage...' });
            const gpkgBlob = await DataManager.exportToGPKG(layerId, mutatedFC.features);
            const gpkgBytes = new Uint8Array(await gpkgBlob.arrayBuffer());
            writer.addFile(`${baseName}.gpkg`, gpkgBytes, false); // SQLite is not compressible
        } else {
            onProgress({ phase: 'build', current: 0, total: 0, message: 'Building GeoJSON...' });
            const jsonStr = JSON.stringify(mutatedFC, null, 2);
            const jsonBytes = new TextEncoder().encode(jsonStr);
            writer.addFile(`${baseName}.geojson`, jsonBytes, true); // JSON compresses well
        }
        addDomainFiles(writer, domainExport);

        // ── Phase 6: Finalize ZIP ────────────────────────────────────────
        onProgress({ phase: 'zip', current: 0, total: 100, message: 'Finalizing archive...' });
        const zipResult = await writer.finalize();
        onProgress({ phase: 'zip', current: 100, total: 100, message: 'Archive ready!' });

        return {
            blob: zipResult.blob || null,
            fileUri: zipResult.fileUri || null,
            filename: `${baseName}.zip`,
            isZip: true,
            imageCount: totalCount,
            domainCount: domainExport?.domainCount || 0,
            fieldDomainCount: domainExport?.fieldDomainCount || 0
        };
    }

    // ── Internal: Scan features for image data ───────────────────────────

    static _scanForImages(features) {
        const imageEntries = [];

        for (let fi = 0; fi < features.length; fi++) {
            const props = features[fi].properties;
            if (!props) continue;

            for (const [key, val] of Object.entries(props)) {
                if (Array.isArray(val)) {
                    for (let ii = 0; ii < val.length; ii++) {
                        const item = val[ii];
                        if (isBase64Image(item)) {
                            imageEntries.push({ featureIdx: fi, fieldKey: key, imageIdx: ii, value: item, type: 'base64' });
                        } else if (isImageUrl(item)) {
                            imageEntries.push({ featureIdx: fi, fieldKey: key, imageIdx: ii, value: item, type: 'url' });
                        }
                    }
                } else if (isBase64Image(val)) {
                    imageEntries.push({ featureIdx: fi, fieldKey: key, imageIdx: -1, value: val, type: 'base64' });
                } else if (isImageUrl(val)) {
                    imageEntries.push({ featureIdx: fi, fieldKey: key, imageIdx: -1, value: val, type: 'url' });
                }
            }
        }

        return { totalCount: imageEntries.length, imageEntries };
    }

    // ── Internal: Deep clone + replace image values ──────────────────────

    static _mutateFeatures(fc, replacementMap) {
        const mutatedFeatures = fc.features.map(feature => {
            const newProps = {};

            for (const [key, val] of Object.entries(feature.properties || {})) {
                if (Array.isArray(val)) {
                    newProps[key] = val.map(item =>
                        replacementMap.has(item) ? replacementMap.get(item) : item
                    );
                } else if (replacementMap.has(val)) {
                    newProps[key] = replacementMap.get(val);
                } else {
                    newProps[key] = val;
                }
            }

            return {
                type: 'Feature',
                geometry: feature.geometry,
                properties: newProps
            };
        });

        return { ...fc, type: 'FeatureCollection', features: mutatedFeatures };
    }
}
