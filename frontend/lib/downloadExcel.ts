/**
 * downloadExcel — authenticated Excel blob download utility.
 * Uses the configured axios api client so auth cookies + headers are sent correctly.
 */
import api from './apiClient';

export async function downloadExcel(apiPath: string, filename: string): Promise<void> {
  const response = await api.get(apiPath, { responseType: 'blob' });
  const url = URL.createObjectURL(new Blob([response.data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
