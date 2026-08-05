import type { ImageItem, ImagePage, ImageQuery, ImageScore, SubjectItem } from '../types/image';

async function readErrorMessage(response: Response) {
  const text = await response.text().catch(() => '');
  if (!text) return '请求失败';
  try {
    const body = JSON.parse(text) as { message?: string };
    return body.message || text;
  } catch {
    return text;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function requestEmpty(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

const ZIP_CHUNK_SIZE = 8 * 1024 * 1024;

export function createUploadId() {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) return randomUUID;

  // HTTP 或旧浏览器可能没有 randomUUID，回退值也必须只包含服务端允许的字符。
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

async function uploadZipChunk(uploadId: string, index: number, chunk: Blob, onProgress?: (loaded: number, total: number) => void) {
  const body = new FormData();
  body.append('chunk', chunk, `chunk-${index}.part`);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/import/chunks/${uploadId}/parts/${index}`);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      const responseText = xhr.responseText || '';
      try {
        const body = JSON.parse(responseText) as { message?: string };
        reject(new Error(body.message || responseText || `请求失败 (${xhr.status})`));
      } catch {
        reject(new Error(responseText || `请求失败 (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('请求失败'));
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
    }
    xhr.send(body);
  });
}

export const imageApi = {
  subjects: () => requestJson<SubjectItem[]>('/api/subjects'),
  categories(subjectId?: string | null) {
    const params = new URLSearchParams();
    if (subjectId) params.set('subjectId', subjectId);
    return requestJson<string[]>(`/api/categories${params.toString() ? `?${params}` : ''}`);
  },
  scorers(subjectId?: string | null) {
    const params = new URLSearchParams();
    if (subjectId) params.set('subjectId', subjectId);
    return requestJson<string[]>(`/api/scorers${params.toString() ? `?${params}` : ''}`);
  },
  list(query: ImageQuery & { page: number; pageSize: number }) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value == null || value === '') return;
      if (Array.isArray(value)) params.set(key, value.join(','));
      else if (typeof value === 'object') params.set(key, JSON.stringify(value));
      else params.set(key, String(value));
    });
    return requestJson<ImagePage>(`/api/images?${params}`);
  },
  importZip(file: File, options?: { uploadId?: string; onProgress?: (progress: number) => void }) {
    const uploadId = options?.uploadId ?? createUploadId();
    const onProgress = options?.onProgress;
    const totalChunks = Math.max(1, Math.ceil(file.size / ZIP_CHUNK_SIZE));
    const totalBytes = Math.max(file.size, 1);

    return (async () => {
      try {
        onProgress?.(0);
        let uploadedBytes = 0;
        for (let index = 0; index < totalChunks; index++) {
          const start = index * ZIP_CHUNK_SIZE;
          const end = Math.min(file.size, start + ZIP_CHUNK_SIZE);
          const chunk = file.slice(start, end);
          await uploadZipChunk(uploadId, index, chunk, (loaded, total) => {
            const chunkBytes = Math.min(total || chunk.size, chunk.size);
            const current = uploadedBytes + Math.min(loaded, chunkBytes);
            onProgress?.(Math.min(99, (current / totalBytes) * 100));
          });
          uploadedBytes += chunk.size;
          onProgress?.(Math.min(99, (uploadedBytes / totalBytes) * 100));
        }

        const result = await requestJson<{ subject: SubjectItem; imported: number; skipped: number; batch: string }>(
          `/api/import/chunks/${uploadId}/complete`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: file.name, totalChunks })
          }
        );
        onProgress?.(100);
        return result;
      } catch (error) {
        await requestEmpty(`/api/import/chunks/${uploadId}`, { method: 'DELETE' }).catch(() => {});
        throw error;
      }
    })();
  },
  saveScore(id: string, score: ImageScore) {
    return requestJson<ImageItem>(`/api/images/${id}/score`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(score) });
  },
  deleteSubject(id: string) {
    return requestJson<{ subject: SubjectItem; deletedImages: number }>(`/api/subjects/${id}`, { method: 'DELETE' });
  }
};
