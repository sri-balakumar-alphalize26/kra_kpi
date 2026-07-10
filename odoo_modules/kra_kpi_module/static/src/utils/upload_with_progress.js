/** @odoo-module **/

/**
 * Upload a file via XMLHttpRequest + multipart FormData so we get real upload
 * progress events (base64-in-JSON RPC can't report progress).
 *
 * @param {string} url            endpoint (e.g. "/kpi/progress/upload_file")
 * @param {FormData} formData     the multipart body (must include the file)
 * @param {function} onProgress   called with { loaded, total, percent }
 * @returns {{promise: Promise<Object>, xhr: XMLHttpRequest}}
 *          Resolve value is the parsed JSON response. Keep `xhr` so the caller
 *          can `xhr.abort()` on Cancel.
 */
export function uploadWithProgress(url, formData, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
        xhr.open("POST", url, true);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && typeof onProgress === "function") {
                onProgress({
                    loaded: e.loaded,
                    total: e.total,
                    percent: Math.min(100, Math.round((e.loaded / e.total) * 100)),
                });
            }
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    resolve(JSON.parse(xhr.responseText));
                } catch (e) {
                    resolve({ status: false, message: "Unexpected server response." });
                }
            } else if (xhr.status === 413) {
                reject(new Error("File too large — the server or proxy rejected it (413)."));
            } else {
                reject(new Error("Upload failed (HTTP " + xhr.status + ")."));
            }
        };
        xhr.onerror = () => reject(new Error("Network error during upload."));
        xhr.onabort = () => reject(new Error("aborted"));
        xhr.send(formData);
    });
    return { promise, xhr };
}
