import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useConfig } from '../config.jsx';
import { time } from '../format.js';
import { useAction } from '../toast.jsx';

const humanise = (key) => {
  const words = key.replace(/_min$/, '').replace(/_/g, ' ');
  return `${words[0].toUpperCase()}${words.slice(1)}${key.endsWith('_min') ? ' (minutes)' : ''}`;
};
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parseInput(def, raw) {
  if (def.valueType === 'boolean') return raw;
  if (def.valueType === 'text') return raw;
  return raw === '' ? NaN : Number(raw);
}

function problemWith(def, value) {
  if (def.valueType === 'integer' || def.valueType === 'number') {
    if (!Number.isFinite(value)) return 'Enter a number';
    if (def.valueType === 'integer' && !Number.isInteger(value)) return 'Whole numbers only';
    if (def.min != null && value < def.min) return `At least ${def.min}`;
    if (def.max != null && value > def.max) return `At most ${def.max}`;
  }
  if (def.valueType === 'text' && value.length > 500) return 'Up to 500 characters';
  return null;
}

function SettingRow({ def, current, override, onSaved }) {
  const run = useAction();
  const [draft, setDraft] = useState(current);
  const value = parseInput(def, draft);
  const problem = problemWith(def, value);
  const dirty = !sameValue(value, current);

  const save = async () => {
    if (await run(() => api(`/settings/${def.key}`, { method: 'PUT', body: { value } }), `${humanise(def.key)} saved`)) onSaved();
  };
  const reset = async () => {
    const r = await run(() => api(`/settings/${def.key}`, { method: 'DELETE' }), `${humanise(def.key)} back to the default`);
    if (r) {
      setDraft(r.value);
      onSaved();
    }
  };

  const input =
    def.valueType === 'boolean' ? (
      <input type="checkbox" checked={Boolean(draft)} onChange={(e) => setDraft(e.target.checked)} />
    ) : def.valueType === 'text' ? (
      <input className="setting-text" value={draft ?? ''} onChange={(e) => setDraft(e.target.value)} />
    ) : (
      <input
        className="setting-number"
        type="number"
        step={def.valueType === 'integer' ? 1 : 'any'}
        min={def.min ?? undefined}
        max={def.max ?? undefined}
        value={draft ?? ''}
        onChange={(e) => setDraft(e.target.value)}
      />
    );

  return (
    <tr>
      <td>
        <strong>{humanise(def.key)}</strong>
        <div className="muted small">{def.description}</div>
      </td>
      <td>
        {input}
        {problem && <div className="bad small">{problem}</div>}
      </td>
      <td className="muted small">
        Default {JSON.stringify(def.defaultValue)}
        {override && (
          <div>
            <span className="badge badge-rec">Changed</span> {override.updated_by ?? ''} {time(override.updated_at)}
          </div>
        )}
      </td>
      <td>
        <div className="staff-actions">
          <button className="btn btn-sm btn-primary" disabled={!dirty || Boolean(problem)} onClick={save}>
            Save
          </button>
          {override && (
            <button className="btn btn-sm btn-ghost" onClick={reset}>
              Use default
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function SettingsEditor() {
  const { config, reload } = useConfig();
  if (!config) return <div className="empty">Loading settings…</div>;
  const overrides = new Map(config.overrides.map((o) => [o.key, o]));
  const groups = new Map();
  for (const d of config.settingDefinitions) groups.set(d.category, [...(groups.get(d.category) ?? []), d]);

  return (
    <div className="staff-page">
      <p className="muted">
        Settings for <strong>{config.centre.name}</strong>. Changes apply to every screen and the background worker within seconds, and are recorded in the audit trail.
      </p>
      {[...groups].map(([category, defs]) => (
        <section key={category} className="panel">
          <div className="panel-head">
            <h2>{humanise(category)}</h2>
          </div>
          <table className="mini staff-table settings-table">
            <tbody>
              {defs.map((d) => (
                <SettingRow
                  key={`${d.key}:${JSON.stringify(config.settings[d.key])}`}
                  def={d}
                  current={config.settings[d.key]}
                  override={overrides.get(d.key)}
                  onSaved={reload}
                />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const { can } = useAuth();
  if (!can('settings')) {
    return (
      <div className="empty">
        <h2>Managers only</h2>
        <p className="muted">Ask a manager to change how this centre is configured.</p>
      </div>
    );
  }
  return <SettingsEditor />;
}
