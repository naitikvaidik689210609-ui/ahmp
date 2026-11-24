import {
  Archive,
  ChevronRight,
  Download,
  FileCode2,
  FilePlus2,
  Folder,
  FolderPlus,
  KeyRound,
  MoveRight,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiDownloadFile, apiFetch, formatBytes, getAuthToken } from '../../lib/api';
import type { VmInstance, VpsFileEntry } from '../../types';
import { CodeEditorView } from '../CodeEditorView';

interface VpsFileManagerTabProps {
  instance: VmInstance;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

const QUICK_PATHS = ['/root', '/var/www', '/etc', '/home'];

export function VpsFileManagerTab({ instance, onNotify }: VpsFileManagerTabProps) {
  const [currentPath, setCurrentPath] = useState('/root');
  const [entries, setEntries] = useState<VpsFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // CodeMirror Editor state
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [savingFile, setSavingFile] = useState(false);

  // Create File/Folder state
  const [createModalType, setCreateModalType] = useState<'file' | 'folder' | null>(null);
  const [createName, setCreateName] = useState('');

  // Rename / Move modal state
  const [moveTarget, setMoveTarget] = useState<VpsFileEntry | null>(null);
  const [moveDest, setMoveDest] = useState('');

  // Chmod modal state
  const [chmodTarget, setChmodTarget] = useState<VpsFileEntry | null>(null);
  const [chmodMode, setChmodMode] = useState('755');

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadDir = useCallback(
    async (targetPath: string) => {
      setLoading(true);
      setErrorMsg('');
      try {
        const res = await apiFetch<{ currentPath: string; entries: VpsFileEntry[] }>(
          `/api/incus/instances/${instance.id}/files?path=${encodeURIComponent(targetPath)}`
        );
        setCurrentPath(res.currentPath);
        setEntries(res.entries);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to browse VPS directory.';
        setErrorMsg(msg);
      } finally {
        setLoading(false);
      }
    },
    [instance.id]
  );

  useEffect(() => {
    setEditingPath(null);
    void loadDir('/root');
  }, [instance.id, loadDir]);

  async function handleOpenFile(entry: VpsFileEntry) {
    if (entry.isDirectory) {
      void loadDir(entry.path);
      return;
    }
    try {
      const res = await apiFetch<{ path: string; content: string }>(
        `/api/incus/instances/${instance.id}/files/content?path=${encodeURIComponent(entry.path)}`
      );
      setEditingPath(res.path);
      setEditingContent(res.content);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to open file in editor', 'error');
    }
  }

  async function handleSaveFile() {
    if (!editingPath) return;
    setSavingFile(true);
    try {
      await apiFetch(`/api/incus/instances/${instance.id}/files/content`, {
        method: 'PUT',
        body: JSON.stringify({ path: editingPath, content: editingContent }),
      });
      onNotify(`Saved ${editingPath}`);
      void loadDir(currentPath);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save file', 'error');
    } finally {
      setSavingFile(false);
    }
  }

  async function handleCreateEntry(e: FormEvent) {
    e.preventDefault();
    if (!createModalType) return;
    const clean = createName.trim().replace(/^\/+/, '');
    if (!clean) return;
    const fullPath = currentPath === '/' ? `/${clean}` : `${currentPath}/${clean}`;
    try {
      await apiFetch(`/api/incus/instances/${instance.id}/files/entry`, {
        method: 'POST',
        body: JSON.stringify({ path: fullPath, type: createModalType }),
      });
      setCreateModalType(null);
      setCreateName('');
      await loadDir(currentPath);
      onNotify(`Created ${createModalType}: ${fullPath}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Creation failed', 'error');
    }
  }

  async function handleUploadFiles(e: ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('dir', currentPath);
      for (const f of Array.from(fileList)) {
        form.append('files', f);
      }
      const token = getAuthToken();
      const res = await fetch(`/api/incus/instances/${instance.id}/files/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      const json = (await res.json()) as { uploaded?: string[]; error?: string };
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      await loadDir(currentPath);
      onNotify(`Uploaded ${json.uploaded?.length || 0} file(s) to ${currentPath}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Upload failed', 'error');
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  }

  async function handleMoveSubmit(e: FormEvent) {
    e.preventDefault();
    if (!moveTarget) return;
    try {
      await apiFetch(`/api/incus/instances/${instance.id}/files/move`, {
        method: 'POST',
        body: JSON.stringify({ sourcePath: moveTarget.path, destPath: moveDest.trim() }),
      });
      setMoveTarget(null);
      await loadDir(currentPath);
      onNotify('Moved / renamed entry.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Rename/move failed', 'error');
    }
  }

  async function handleChmodSubmit(e: FormEvent) {
    e.preventDefault();
    if (!chmodTarget) return;
    try {
      await apiFetch(`/api/incus/instances/${instance.id}/files/chmod`, {
        method: 'POST',
        body: JSON.stringify({ path: chmodTarget.path, mode: chmodMode.trim() }),
      });
      setChmodTarget(null);
      await loadDir(currentPath);
      onNotify(`Updated permissions on ${chmodTarget.name} -> ${chmodMode}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'chmod failed', 'error');
    }
  }

  async function handleDeleteEntry(entry: VpsFileEntry) {
    try {
      await apiFetch(
        `/api/incus/instances/${instance.id}/files/entry?path=${encodeURIComponent(entry.path)}`,
        { method: 'DELETE' }
      );
      await loadDir(currentPath);
      onNotify(`Deleted ${entry.path}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  const breadcrumbs = currentPath.split('/').filter(Boolean);

  return (
    <div className="space-y-4">
      {/* Toolbar & Quick Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-500/20 bg-[#090714]/65 p-3.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={() => void loadDir('/')}
            className="rounded border border-violet-500/25 px-2 py-1 font-mono text-violet-200 hover:bg-violet-600/20"
          >
            /
          </button>
          {breadcrumbs.map((seg, idx) => {
            const full = '/' + breadcrumbs.slice(0, idx + 1).join('/');
            return (
              <span key={full} className="inline-flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
                <button
                  type="button"
                  onClick={() => void loadDir(full)}
                  className="rounded px-1.5 py-0.5 font-mono text-slate-200 hover:bg-violet-600/20 hover:text-white"
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {QUICK_PATHS.map((qp) => (
            <button
              key={qp}
              type="button"
              onClick={() => void loadDir(qp)}
              className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors whitespace-nowrap shrink-0 ${
                currentPath === qp
                  ? 'border-violet-400 bg-violet-600/25 text-white'
                  : 'border-violet-500/20 text-slate-400 hover:text-white'
              }`}
            >
              {qp}
            </button>
          ))}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setCreateName('');
              setCreateModalType('file');
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            New File
          </button>
          <button
            type="button"
            onClick={() => {
              setCreateName('');
              setCreateModalType('folder');
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New Folder
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            onChange={(e) => void handleUploadFiles(e)}
            className="hidden"
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => uploadInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Upload className="h-3.5 w-3.5" />
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              void apiDownloadFile(
                `/api/incus/instances/${instance.id}/files/download?path=${encodeURIComponent(
                  currentPath
                )}&format=tar.gz`,
                `${instance.instance_name}-${currentPath.replace(/\W+/g, '_')}.tar.gz`
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/25 px-3 py-1.5 text-xs text-slate-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
          >
            <Archive className="h-3.5 w-3.5" />
            Archive .tar.gz
          </button>
          <button
            type="button"
            onClick={() =>
              void apiDownloadFile(
                `/api/incus/instances/${instance.id}/files/download?path=${encodeURIComponent(
                  currentPath
                )}&format=zip`,
                `${instance.instance_name}-${currentPath.replace(/\W+/g, '_')}.zip`
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/25 px-3 py-1.5 text-xs text-slate-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" />
            Archive .zip
          </button>
          <button
            type="button"
            onClick={() => void loadDir(currentPath)}
            className="rounded-lg border border-violet-500/25 p-1.5 text-slate-300 hover:text-white"
            title="Refresh directory"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Inline CodeMirror Editor */}
      {editingPath && (
        <div className="space-y-2 rounded-xl border border-violet-500/30 bg-[#090714]/80 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs text-violet-200">Editing: {editingPath}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={savingFile}
                onClick={() => void handleSaveFile()}
                className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Save className="h-3.5 w-3.5" />
                {savingFile ? 'Saving...' : 'Save File'}
              </button>
              <button
                type="button"
                onClick={() => setEditingPath(null)}
                className="rounded-lg border border-violet-500/25 px-3 py-1.5 text-xs text-slate-300 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
          <CodeEditorView
            filename={editingPath}
            initialValue={editingContent}
            onChange={setEditingContent}
            onSave={() => void handleSaveFile()}
          />
        </div>
      )}

      {/* Directory Listing */}
      {errorMsg ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-6 text-center text-xs text-amber-200">
          {errorMsg}
        </div>
      ) : loading ? (
        <div className="space-y-2 py-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-violet-950/35" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-violet-500/15 bg-[#090714]/45 py-10 text-center text-xs text-slate-400">
          Directory <code className="text-violet-300">{currentPath}</code> is empty.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-violet-500/20 bg-[#090714]/60">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-violet-500/15 text-slate-400">
                <th className="px-3.5 py-2.5 font-medium">Name</th>
                <th className="px-3.5 py-2.5 font-medium">Permissions</th>
                <th className="px-3.5 py-2.5 font-medium">Owner</th>
                <th className="px-3.5 py-2.5 font-medium text-right">Size</th>
                <th className="px-3.5 py-2.5 font-medium">Modified</th>
                <th className="px-3.5 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-violet-500/10">
              {entries.map((entry) => (
                <tr key={entry.path} className="hover:bg-violet-500/10">
                  <td className="px-3.5 py-2">
                    <button
                      type="button"
                      onClick={() => void handleOpenFile(entry)}
                      className="inline-flex items-center gap-2 font-mono text-xs text-slate-100 hover:text-violet-300"
                    >
                      {entry.isDirectory ? (
                        <Folder className="h-4 w-4 text-violet-400" />
                      ) : (
                        <FileCode2 className="h-4 w-4 text-cyan-400" />
                      )}
                      <span>{entry.name}</span>
                    </button>
                  </td>
                  <td className="px-3.5 py-2 font-mono text-slate-300 tabular-nums">
                    {entry.permissions} ({entry.permissionsOctal})
                  </td>
                  <td className="px-3.5 py-2 font-mono text-slate-400">{entry.owner}</td>
                  <td className="px-3.5 py-2 text-right font-mono text-slate-300 tabular-nums">
                    {entry.isDirectory ? '--' : formatBytes(entry.size)}
                  </td>
                  <td className="px-3.5 py-2 font-mono text-slate-400 tabular-nums">
                    {entry.modifiedAt}
                  </td>
                  <td className="px-3.5 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        title={entry.isDirectory ? 'Download .tar.gz archive' : 'Download file'}
                        onClick={() =>
                          void apiDownloadFile(
                            `/api/incus/instances/${instance.id}/files/download?path=${encodeURIComponent(
                              entry.path
                            )}&format=tar.gz`,
                            entry.isDirectory ? `${entry.name}.tar.gz` : entry.name
                          )
                        }
                        className="rounded p-1 text-slate-400 hover:bg-violet-600/20 hover:text-white"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Rename / Move"
                        onClick={() => {
                          setMoveTarget(entry);
                          setMoveDest(entry.path);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-violet-600/20 hover:text-white"
                      >
                        <MoveRight className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Change Permissions (chmod)"
                        onClick={() => {
                          setChmodTarget(entry);
                          setChmodMode(entry.permissionsOctal);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-violet-600/20 hover:text-white"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        onClick={() => void handleDeleteEntry(entry)}
                        className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create File/Folder Modal */}
      {createModalType && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-sm rounded-2xl p-5">
            <div className="mb-3 flex items-center justify-between border-b border-violet-500/15 pb-2.5">
              <h4 className="text-sm font-semibold text-white">
                {createModalType === 'folder' ? 'Create Directory' : 'Create Empty File'}
              </h4>
              <button
                type="button"
                onClick={() => setCreateModalType(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateEntry} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">
                  Name inside <code className="text-violet-300">{currentPath}</code>
                </label>
                <input
                  type="text"
                  required
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder={createModalType === 'folder' ? 'app-data' : 'docker-compose.yml'}
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-xs text-white"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreateModalType(null)}
                  className="rounded-lg border border-violet-500/25 px-3 py-1.5 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cyber-glow-btn rounded-lg px-4 py-1.5 text-xs font-semibold text-white"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Rename / Move Modal */}
      {moveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-md rounded-2xl p-5">
            <div className="mb-3 flex items-center justify-between border-b border-violet-500/15 pb-2.5">
              <h4 className="text-sm font-semibold text-white">Rename / Move {moveTarget.name}</h4>
              <button
                type="button"
                onClick={() => setMoveTarget(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleMoveSubmit} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Destination Absolute Path</label>
                <input
                  type="text"
                  required
                  value={moveDest}
                  onChange={(e) => setMoveDest(e.target.value)}
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-xs text-white"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setMoveTarget(null)}
                  className="rounded-lg border border-violet-500/25 px-3 py-1.5 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cyber-glow-btn rounded-lg px-4 py-1.5 text-xs font-semibold text-white"
                >
                  Move / Rename
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Chmod Modal */}
      {chmodTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-sm rounded-2xl p-5">
            <div className="mb-3 flex items-center justify-between border-b border-violet-500/15 pb-2.5">
              <h4 className="text-sm font-semibold text-white">chmod · {chmodTarget.name}</h4>
              <button
                type="button"
                onClick={() => setChmodTarget(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleChmodSubmit} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Octal Mode (e.g. 644, 755)</label>
                <input
                  type="text"
                  required
                  pattern="[0-7]{3,4}"
                  value={chmodMode}
                  onChange={(e) => setChmodMode(e.target.value)}
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-xs text-white"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setChmodTarget(null)}
                  className="rounded-lg border border-violet-500/25 px-3 py-1.5 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cyber-glow-btn rounded-lg px-4 py-1.5 text-xs font-semibold text-white"
                >
                  Apply chmod
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
