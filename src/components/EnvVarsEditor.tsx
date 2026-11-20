import { useState } from 'react';
import { ClipboardPaste, Eye, EyeOff, Lock, Plus, Trash2 } from 'lucide-react';
import type { EnvVarEntry } from '../types/lyrihost';

interface EnvVarsEditorProps {
  envVars: EnvVarEntry[];
  onChange: (next: EnvVarEntry[]) => void;
}

export function EnvVarsEditor({ envVars, onChange }: EnvVarsEditorProps) {
  const [revealedKeys, setRevealedKeys] = useState<Record<number, boolean>>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');

  const updateRow = (index: number, patch: Partial<EnvVarEntry>) => {
    const next = envVars.map((row, idx) => (idx === index ? { ...row, ...patch } : row));
    onChange(next);
  };

  const addRow = () => {
    onChange([...envVars, { key: '', value: '', isSecret: true, detectedFrom: 'Manual' }]);
  };

  const removeRow = (index: number) => {
    onChange(envVars.filter((_, idx) => idx !== index));
  };

  const toggleReveal = (index: number) => {
    setRevealedKeys((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const importBulkEnv = () => {
    const parsed: EnvVarEntry[] = [];
    for (const raw of bulkText.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim().replace(/^export\s+/, '');
      let value = line.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!key) continue;
      parsed.push({
        key,
        value,
        isSecret: /(TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH|URI|DSN)/i.test(key),
        detectedFrom: 'Bulk .env import',
      });
    }

    if (parsed.length > 0) {
      const merged = [...envVars];
      for (const item of parsed) {
        const existingIdx = merged.findIndex((e) => e.key === item.key);
        if (existingIdx >= 0) {
          merged[existingIdx] = { ...merged[existingIdx], value: item.value, isSecret: item.isSecret };
        } else {
          merged.push(item);
        }
      }
      onChange(merged);
    }
    setBulkText('');
    setBulkOpen(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-slate-100">Environment Variables & Secrets</h4>
          <p className="text-xs text-slate-400">
            Injected into the bot container at startup. Secret values are masked in logs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setBulkOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition-colors hover:bg-red-500/20 whitespace-nowrap shrink-0"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            {bulkOpen ? 'Close .env Paste' : 'Paste .env'}
          </button>
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-600/20 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-600/30 whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Variable
          </button>
        </div>
      </div>

      {bulkOpen && (
        <div className="rounded-lg border border-red-500/30 bg-[#0a0406] p-3 space-y-2.5">
          <textarea
            rows={4}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={`DISCORD_TOKEN=your_token_here\nGUILD_ID=1234567890\nLOG_LEVEL=info`}
            className="w-full rounded-lg border border-red-950/90 bg-[#12070a] p-2.5 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-red-400 focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setBulkOpen(false)}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={importBulkEnv}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500"
            >
              Import Variables
            </button>
          </div>
        </div>
      )}

      {envVars.length === 0 ? (
        <div className="rounded-lg border border-dashed border-red-950/80 bg-[#0a0406]/70 px-4 py-5 text-center text-xs text-slate-400">
          No environment variables defined. Add keys like <span className="font-mono text-red-300">DISCORD_TOKEN</span> or <span className="font-mono text-red-300">BOT_TOKEN</span>.
        </div>
      ) : (
        <div className="divide-y divide-red-950/70 rounded-lg border border-red-950/80 bg-[#0a0406]">
          {envVars.map((entry, idx) => {
            const isRevealed = Boolean(revealedKeys[idx]);
            return (
              <div key={`${idx}-${entry.detectedFrom || 'row'}`} className="grid grid-cols-1 gap-2 p-2.5 sm:grid-cols-12 sm:items-center">
                <div className="sm:col-span-4">
                  <input
                    type="text"
                    value={entry.key}
                    onChange={(e) => updateRow(idx, { key: e.target.value.toUpperCase().replace(/\s+/g, '_') })}
                    placeholder="KEY_NAME"
                    className="w-full rounded-md border border-red-950/80 bg-[#12070a] px-2.5 py-1.5 font-mono text-xs text-red-300 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                  />
                </div>
                <div className="relative sm:col-span-5">
                  <input
                    type={entry.isSecret && !isRevealed ? 'password' : 'text'}
                    value={entry.value}
                    onChange={(e) => updateRow(idx, { value: e.target.value })}
                    placeholder={entry.isSecret ? 'Enter secret value...' : 'Enter value...'}
                    className="w-full rounded-md border border-red-950/80 bg-[#12070a] py-1.5 pl-2.5 pr-8 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                  />
                  {entry.isSecret && (
                    <button
                      type="button"
                      onClick={() => toggleReveal(idx)}
                      title={isRevealed ? 'Hide secret' : 'Reveal secret'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-red-300"
                    >
                      {isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 sm:col-span-3 sm:justify-end">
                  <button
                    type="button"
                    onClick={() => updateRow(idx, { isSecret: !entry.isSecret })}
                    title="Toggle secret masking"
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                      entry.isSecret
                        ? 'border-red-500/40 bg-red-500/15 text-red-300'
                        : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Lock className="h-3 w-3" />
                    {entry.isSecret ? 'Secret' : 'Plain'}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    title="Remove variable"
                    className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-red-500/15 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
