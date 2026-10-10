import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useConfig } from '../config.jsx';
import { useLive } from '../live.jsx';
import { useAction } from '../toast.jsx';

const KINDS = [
  ['equipment', 'Equipment'],
  ['room', 'Room'],
  ['staff', 'Person'],
];
const kindLabel = (k) => KINDS.find(([v]) => v === k)?.[1] ?? k;
const validCode = (c) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(c);
/** "Chest X-ray" → "chest_x_ray", a starting point the manager can edit. */
const suggestCode = (name) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40);
const patch = (path, body) => api(path, { method: 'PATCH', body });
const remove = (path) => api(path, { method: 'DELETE' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Chosen capabilities as removable chips, plus a menu to add more. Services may need the same capability twice. */
function CapabilityPicker({ capabilities, value, onChange, allowRepeat = false }) {
  const name = (code) => capabilities.find((c) => c.code === code)?.name ?? code;
  const options = capabilities.filter((c) => allowRepeat || !value.includes(c.code));
  return (
    <div className="cap-picker">
      {value.map((code, i) => (
        <span key={`${code}-${i}`} className="chip cap-chip">
          {name(code)}
          <button type="button" aria-label={`Remove ${name(code)}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ×
          </button>
        </span>
      ))}
      <select value="" aria-label="Add capability" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">+ Add…</option>
        {options.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// Resources -------------------------------------------------------------------

function AddResource({ catalogue, onDone }) {
  const run = useAction();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('equipment');
  const [caps, setCaps] = useState([]);
  const valid = name.trim() && caps.length;
  const submit = async (e) => {
    e.preventDefault();
    if (await run(() => post('/catalogue/resources', { name: name.trim(), kind, capabilities: caps }), `${name.trim()} added`)) {
      setName('');
      setCaps([]);
      onDone();
    }
  };
  return (
    <form className="form-row" onSubmit={submit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. USG Room 3" />
      </label>
      <label className="narrow">
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="grow">
        Can provide
        <CapabilityPicker capabilities={catalogue.capabilities} value={caps} onChange={setCaps} />
      </label>
      <button className="btn btn-primary" disabled={!valid}>
        Add resource
      </button>
    </form>
  );
}

function ResourceRow({ resource, catalogue, onDone }) {
  const run = useAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: resource.name, kind: resource.kind, capabilities: resource.capabilities });
  const dirty = !same(draft, { name: resource.name, kind: resource.kind, capabilities: resource.capabilities });
  const capName = (code) => catalogue.capabilities.find((c) => c.code === code)?.name ?? code;

  const save = async (body, success) => {
    const r = await run(() => patch(`/catalogue/resources/${resource.id}`, body), (x) =>
      x.displaced ? `${success}. ${x.displaced} booking(s) need a new time: review the re-plan on the Floor` : success,
    );
    if (r) {
      setEditing(false);
      onDone();
    }
  };
  const toggleActive = () => {
    if (resource.active) {
      const warn = resource.upcomingBookings ? ` Its ${resource.upcomingBookings} upcoming booking(s) will need a new time.` : '';
      if (!window.confirm(`Take ${resource.name} out of service?${warn}`)) return;
      return save({ active: false }, `${resource.name} taken out of service`);
    }
    return save({ active: true }, `${resource.name} back in service`);
  };

  return (
    <>
      <tr className={resource.active ? '' : 'inactive'}>
        <td>
          <strong>{resource.name}</strong>
        </td>
        <td>{kindLabel(resource.kind)}</td>
        <td>
          {resource.capabilities.map((c) => (
            <span key={c} className="chip cap-chip">
              {capName(c)}
            </span>
          ))}
        </td>
        <td>{resource.upcomingBookings || <span className="muted">–</span>}</td>
        <td>{resource.active ? <span className="status status-in_progress">In service</span> : <span className="status status-cancelled">Out of service</span>}</td>
        <td>
          <div className="staff-actions">
            <button className="btn btn-sm" onClick={() => setEditing(!editing)}>
              {editing ? 'Close' : 'Edit'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={toggleActive}>
              {resource.active ? 'Take out of service' : 'Return to service'}
            </button>
          </div>
        </td>
      </tr>
      {editing && (
        <tr className="edit-row">
          <td colSpan={6}>
            <div className="form-row">
              <label>
                Name
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="narrow">
                Kind
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                  {KINDS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grow">
                Can provide
                <CapabilityPicker capabilities={catalogue.capabilities} value={draft.capabilities} onChange={(capabilities) => setDraft({ ...draft, capabilities })} />
              </label>
              <button
                className="btn btn-primary"
                disabled={!dirty || !draft.name.trim() || !draft.capabilities.length}
                onClick={() => save({ ...draft, name: draft.name.trim() }, `${draft.name.trim()} saved`)}
              >
                Save
              </button>
            </div>
            <p className="muted small">Removing a capability moves only the upcoming bookings that relied on it into the re-plan proposal. Services already running finish.</p>
          </td>
        </tr>
      )}
    </>
  );
}

function ResourcesTab({ catalogue, onDone }) {
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Add a machine, room or person</h2>
        </div>
        <AddResource catalogue={catalogue} onDone={onDone} />
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Resources</h2>
          <span className="muted">Anything with limited capacity. A booking holds every resource it needs at the same time.</span>
        </div>
        <table className="mini staff-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Can provide</th>
              <th>Upcoming</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {catalogue.resources.map((r) => (
              <ResourceRow key={`${r.id}:${r.name}:${r.kind}:${r.capabilities.join()}:${r.active}`} resource={r} catalogue={catalogue} onDone={onDone} />
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

// Services --------------------------------------------------------------------

function PrerequisiteEditor({ service, catalogue, value, onChange }) {
  const [pick, setPick] = useState('');
  const [gap, setGap] = useState('0');
  const nameOf = (id) => catalogue.services.find((s) => s.id === id)?.name ?? 'Unknown';
  const choices = catalogue.services.filter((s) => s.id !== service?.id && !value.some((p) => p.requiresServiceId === s.id));
  return (
    <div className="prereqs">
      {value.length === 0 && <span className="muted small">None</span>}
      {value.map((p) => (
        <span key={p.requiresServiceId} className="chip cap-chip">
          after {nameOf(p.requiresServiceId)}
          {p.minGapMin ? ` (≥ ${p.minGapMin} min)` : ''}
          <button type="button" aria-label={`Remove ${nameOf(p.requiresServiceId)}`} onClick={() => onChange(value.filter((x) => x !== p))}>
            ×
          </button>
        </span>
      ))}
      <select value={pick} aria-label="Must come after" onChange={(e) => setPick(e.target.value)}>
        <option value="">Must come after…</option>
        {choices.map((s) => (
          <option key={s.id} value={s.id}>
            {s.code} · {s.name}
          </option>
        ))}
      </select>
      <input className="setting-number" type="number" min={0} max={1440} value={gap} aria-label="Minimum gap in minutes" onChange={(e) => setGap(e.target.value)} />
      <span className="muted small">min gap</span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={!pick || !(Number(gap) >= 0)}
        onClick={() => {
          onChange([...value, { requiresServiceId: pick, minGapMin: Number(gap) }]);
          setPick('');
          setGap('0');
        }}
      >
        Add
      </button>
    </div>
  );
}

function ServiceFields({ draft, setDraft, catalogue, service }) {
  return (
    <>
      <div className="form-row">
        <label>
          Name
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Chest X-ray" />
        </label>
        <label className="narrow">
          Category
          <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
            <option value="" disabled>
              Choose…
            </option>
            {catalogue.categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="narrow">
          Duration (min)
          <input type="number" min={1} max={480} value={draft.durationMin} onChange={(e) => setDraft({ ...draft, durationMin: e.target.value })} />
        </label>
      </div>
      <div className="form-row">
        <label className="grow">
          Needs (one free resource for each, at the same time)
          <CapabilityPicker capabilities={catalogue.capabilities} value={draft.requirements} onChange={(requirements) => setDraft({ ...draft, requirements })} allowRepeat />
        </label>
      </div>
      <div className="form-row">
        <label className="grow">
          Ordering rules
          <PrerequisiteEditor service={service} catalogue={catalogue} value={draft.prerequisites} onChange={(prerequisites) => setDraft({ ...draft, prerequisites })} />
        </label>
      </div>
    </>
  );
}

const serviceBody = (d) => ({
  name: d.name.trim(),
  category: d.category,
  durationMin: Number(d.durationMin),
  requirements: d.requirements,
  prerequisites: d.prerequisites,
});
const serviceValid = (d) => d.name.trim() && d.category && Number.isInteger(Number(d.durationMin)) && Number(d.durationMin) >= 1 && d.requirements.length;

function AddService({ catalogue, onDone }) {
  const run = useAction();
  const blank = { code: '', name: '', category: '', durationMin: '15', requirements: [], prerequisites: [] };
  const [draft, setDraft] = useState(blank);
  const [codeTouched, setCodeTouched] = useState(false);
  const code = codeTouched ? draft.code : suggestCode(draft.name).toUpperCase();
  const submit = async (e) => {
    e.preventDefault();
    if (await run(() => post('/catalogue/services', { code, ...serviceBody(draft) }), `${draft.name.trim()} added`)) {
      setDraft(blank);
      setCodeTouched(false);
      onDone();
    }
  };
  return (
    <form onSubmit={submit}>
      <ServiceFields draft={draft} setDraft={setDraft} catalogue={catalogue} />
      <div className="form-row">
        <label className="narrow">
          Code (short, permanent)
          <input
            value={code}
            onChange={(e) => {
              setCodeTouched(true);
              setDraft({ ...draft, code: e.target.value });
            }}
            placeholder="e.g. CXR"
          />
        </label>
        <button className="btn btn-primary" disabled={!serviceValid(draft) || !validCode(code)}>
          Add service
        </button>
        {code && !validCode(code) && <span className="bad small">Start with a letter; letters, digits and _ only.</span>}
      </div>
    </form>
  );
}

function ServiceRow({ service, catalogue, onDone }) {
  const run = useAction();
  const { categoryName, categoryClass } = useConfig();
  const [editing, setEditing] = useState(false);
  const initial = {
    name: service.name,
    category: service.category,
    durationMin: String(service.durationMin),
    requirements: service.requirements,
    prerequisites: service.prerequisites,
  };
  const [draft, setDraft] = useState(initial);
  const capName = (code) => catalogue.capabilities.find((c) => c.code === code)?.name ?? code;
  const nameOf = (id) => catalogue.services.find((s) => s.id === id)?.code ?? '?';

  const save = async (body, success) => {
    if (await run(() => patch(`/catalogue/services/${service.id}`, body), success)) {
      setEditing(false);
      onDone();
    }
  };

  return (
    <>
      <tr className={service.active ? '' : 'inactive'}>
        <td>
          <span className={`chip ${categoryClass(service.category)}`}>{service.code}</span>
        </td>
        <td>
          <strong>{service.name}</strong>
          <div className="muted small">{categoryName(service.category)}</div>
        </td>
        <td>{service.durationMin} min</td>
        <td>
          {service.requirements.map((c, i) => (
            <span key={`${c}-${i}`} className="chip cap-chip">
              {capName(c)}
            </span>
          ))}
          {service.unmet.map((u) => (
            <div key={u.capability} className="bad small">
              Needs {u.needed} × {capName(u.capability)}, only {u.available} in service
            </div>
          ))}
        </td>
        <td className="small">
          {service.prerequisites.map((p) => (
            <div key={p.requiresServiceId}>
              after {nameOf(p.requiresServiceId)}
              {p.minGapMin ? ` ≥ ${p.minGapMin} min` : ''}
            </div>
          ))}
        </td>
        <td>{service.active ? <span className="status status-in_progress">Offered</span> : <span className="status status-cancelled">Retired</span>}</td>
        <td>
          <div className="staff-actions">
            <button className="btn btn-sm" onClick={() => setEditing(!editing)}>
              {editing ? 'Close' : 'Edit'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() =>
                service.active
                  ? window.confirm(`Stop offering ${service.name}? Existing bookings keep their slots.`) && save({ active: false }, `${service.name} retired`)
                  : save({ active: true }, `${service.name} offered again`)
              }
            >
              {service.active ? 'Retire' : 'Offer again'}
            </button>
          </div>
        </td>
      </tr>
      {editing && (
        <tr className="edit-row">
          <td colSpan={7}>
            <ServiceFields draft={draft} setDraft={setDraft} catalogue={catalogue} service={service} />
            <div className="form-row">
              <button className="btn btn-primary" disabled={same(draft, initial) || !serviceValid(draft)} onClick={() => save(serviceBody(draft), `${draft.name.trim()} saved`)}>
                Save
              </button>
              <span className="muted small">New duration and needs apply to bookings made from now on; existing bookings keep their slots.</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ServicesTab({ catalogue, onDone }) {
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Add a service</h2>
        </div>
        {catalogue.categories.length === 0 || catalogue.capabilities.length === 0 ? (
          <p className="muted">Add at least one category and one capability first.</p>
        ) : (
          <AddService catalogue={catalogue} onDone={onDone} />
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Services</h2>
          <span className="muted">Tests and procedures patients can be booked for.</span>
        </div>
        <table className="mini staff-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Service</th>
              <th>Duration</th>
              <th>Needs</th>
              <th>Order</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {catalogue.services.map((s) => (
              <ServiceRow key={`${s.id}:${JSON.stringify([s.name, s.category, s.durationMin, s.requirements, s.prerequisites, s.active])}`} service={s} catalogue={catalogue} onDone={onDone} />
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

// Categories, capabilities and priority levels ---------------------------------

/** One editable line of a simple code + name list. */
function NamedRow({ item, usage, onSave, onDelete, deleteTitle }) {
  const [name, setName] = useState(item.name);
  const [order, setOrder] = useState(item.sortOrder);
  const dirty = name.trim() !== item.name || (order !== undefined && Number(order) !== item.sortOrder);
  return (
    <tr>
      <td>
        <code>{item.code}</code>
      </td>
      <td>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label={`Name for ${item.code}`} />
      </td>
      {order !== undefined && (
        <td>
          <input className="setting-number" type="number" min={0} value={order} aria-label={`Order for ${item.code}`} onChange={(e) => setOrder(e.target.value)} />
        </td>
      )}
      <td className="muted small">{usage}</td>
      <td>
        <div className="staff-actions">
          <button className="btn btn-sm btn-primary" disabled={!dirty || !name.trim()} onClick={() => onSave({ name: name.trim(), ...(order !== undefined && { sortOrder: Number(order) }) })}>
            Save
          </button>
          <button className="btn btn-sm btn-ghost" disabled={Boolean(deleteTitle)} title={deleteTitle} onClick={onDelete}>
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}

function AddNamed({ label, codeHint, onAdd }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState(null);
  const shown = code ?? suggestCode(name);
  const submit = async (e) => {
    e.preventDefault();
    if (await onAdd({ code: shown, name: name.trim() })) {
      setName('');
      setCode(null);
    }
  };
  return (
    <form className="form-row" onSubmit={submit}>
      <label>
        {label}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="narrow">
        Code (permanent)
        <input value={shown} onChange={(e) => setCode(e.target.value)} placeholder={codeHint} />
      </label>
      <button className="btn btn-primary" disabled={!name.trim() || !validCode(shown)}>
        Add
      </button>
    </form>
  );
}

function CategoriesTab({ catalogue, onDone }) {
  const run = useAction();
  const done = (r) => (r && onDone(), r);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Categories</h2>
        <span className="muted">Departments services are grouped under. Order is the route a token system would send patients along.</span>
      </div>
      <AddNamed label="New category" codeHint="e.g. cardiology" onAdd={(body) => run(() => post('/catalogue/categories', body), `${body.name} added`).then(done)} />
      <table className="mini staff-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Order</th>
            <th>Used by</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {catalogue.categories.map((c) => (
            <NamedRow
              key={`${c.code}:${c.name}:${c.sortOrder}`}
              item={c}
              usage={`${c.services} service(s)`}
              deleteTitle={c.services ? 'Move its services to another category first' : undefined}
              onSave={(body) => run(() => patch(`/catalogue/categories/${c.code}`, body), `${body.name} saved`).then(done)}
              onDelete={() => window.confirm(`Remove ${c.name}?`) && run(() => remove(`/catalogue/categories/${c.code}`), `${c.name} removed`).then(done)}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CapabilitiesTab({ catalogue, onDone }) {
  const run = useAction();
  const done = (r) => (r && onDone(), r);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Capabilities</h2>
        <span className="muted">What a resource can do (“ultrasound”, “radiologist”). Services list the capabilities they need.</span>
      </div>
      <AddNamed label="New capability" codeHint="e.g. ecg" onAdd={(body) => run(() => post('/catalogue/capabilities', body), `${body.name} added`).then(done)} />
      <table className="mini staff-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Used by</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {catalogue.capabilities.map((c) => (
            <NamedRow
              key={`${c.code}:${c.name}`}
              item={c}
              usage={
                <>
                  {c.activeResources} of {c.resources} resource(s) in service · {c.services} service(s)
                  {c.services > 0 && c.activeResources === 0 && <div className="bad">No resource in service provides this</div>}
                </>
              }
              deleteTitle={c.resources || c.services ? 'Remove it from resources and services first' : undefined}
              onSave={(body) => run(() => patch(`/catalogue/capabilities/${c.code}`, body), `${body.name} saved`).then(done)}
              onDelete={() => window.confirm(`Remove ${c.name}?`) && run(() => remove(`/catalogue/capabilities/${c.code}`), `${c.name} removed`).then(done)}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PriorityRow({ level, onDone }) {
  const run = useAction();
  const [label, setLabel] = useState(level.label);
  const [description, setDescription] = useState(level.description ?? '');
  const dirty = label.trim() !== level.label || description.trim() !== (level.description ?? '');
  const save = () => run(() => api(`/catalogue/priority-levels/${level.level}`, { method: 'PUT', body: { label: label.trim(), description: description.trim() || null } }), `${label.trim()} saved`);
  return (
    <tr>
      <td>{level.level}</td>
      <td>
        <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label={`Label for level ${level.level}`} />
      </td>
      <td>
        <input className="setting-text" value={description} onChange={(e) => setDescription(e.target.value)} aria-label={`Description for level ${level.level}`} />
      </td>
      <td>
        <div className="staff-actions">
          <button className="btn btn-sm btn-primary" disabled={!dirty || !label.trim()} onClick={async () => (await save()) && onDone()}>
            Save
          </button>
          <button
            className="btn btn-sm btn-ghost"
            disabled={level.level === 0}
            title={level.level === 0 ? 'Every visit starts at level 0' : undefined}
            onClick={async () => window.confirm(`Remove “${level.label}”?`) && (await run(() => remove(`/catalogue/priority-levels/${level.level}`), `${level.label} removed`)) && onDone()}
          >
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}

function PrioritiesTab({ catalogue, onDone }) {
  const run = useAction();
  const free = Array.from({ length: 11 }, (_, i) => i).filter((l) => !catalogue.priorityLevels.some((p) => p.level === l));
  const [level, setLevel] = useState('');
  const [label, setLabel] = useState('');
  const add = async (e) => {
    e.preventDefault();
    if (await run(() => api(`/catalogue/priority-levels/${level}`, { method: 'PUT', body: { label: label.trim() } }), `${label.trim()} added`)) {
      setLevel('');
      setLabel('');
      onDone();
    }
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Priority levels</h2>
        <span className="muted">Operational urgency front desk can choose. Higher levels are placed first. Clinical priority stays a staff decision.</span>
      </div>
      <form className="form-row" onSubmit={add}>
        <label className="narrow">
          Level
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="" disabled>
              Choose…
            </option>
            {free.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Same hour" />
        </label>
        <button className="btn btn-primary" disabled={level === '' || !label.trim()}>
          Add
        </button>
      </form>
      <table className="mini staff-table">
        <thead>
          <tr>
            <th>Level</th>
            <th>Label</th>
            <th>Description</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {catalogue.priorityLevels.map((p) => (
            <PriorityRow key={`${p.level}:${p.label}:${p.description}`} level={p} onDone={onDone} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Centre ----------------------------------------------------------------------

function CentreTab({ catalogue, onDone }) {
  const run = useAction();
  const c = catalogue.centre;
  const [draft, setDraft] = useState({ name: c.name, city: c.city, opensAt: c.opensAt, closesAt: c.closesAt });
  const dirty = !same(draft, { name: c.name, city: c.city, opensAt: c.opensAt, closesAt: c.closesAt });
  const hoursOk = draft.opensAt < draft.closesAt;
  const save = async (e) => {
    e.preventDefault();
    if (await run(() => patch('/catalogue/centre', { ...draft, name: draft.name.trim(), city: draft.city.trim() }), 'Centre details saved')) onDone();
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Centre</h2>
        <span className="muted">Time zone {c.timezone}</span>
      </div>
      <form onSubmit={save}>
        <div className="form-row">
          <label>
            Name
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            City
            <input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
          </label>
        </div>
        <div className="form-row">
          <label className="narrow">
            Opens
            <input type="time" value={draft.opensAt} onChange={(e) => setDraft({ ...draft, opensAt: e.target.value })} />
          </label>
          <label className="narrow">
            Closes
            <input type="time" value={draft.closesAt} onChange={(e) => setDraft({ ...draft, closesAt: e.target.value })} />
          </label>
          <button className="btn btn-primary" disabled={!dirty || !hoursOk || !draft.name.trim() || !draft.city.trim()}>
            Save
          </button>
          {!hoursOk && <span className="bad small">Opening must be before closing.</span>}
        </div>
        <p className="muted small">Nothing is booked past closing time. Bookings already made outside new hours keep their slots.</p>
      </form>
    </section>
  );
}

// Page ------------------------------------------------------------------------

const TABS = [
  ['resources', 'Resources', ResourcesTab],
  ['services', 'Services', ServicesTab],
  ['categories', 'Categories', CategoriesTab],
  ['capabilities', 'Capabilities', CapabilitiesTab],
  ['priorities', 'Priority levels', PrioritiesTab],
  ['centre', 'Centre & hours', CentreTab],
];

function CatalogueEditor() {
  const { lastEvent } = useLive();
  const { config, reload: reloadConfig } = useConfig();
  const [catalogue, setCatalogue] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('resources');

  const load = useCallback(
    () =>
      api('/catalogue').then(
        (c) => (setCatalogue(c), setError(null)),
        (e) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  // Another manager's edits (or the worker's) show up without a refresh.
  useEffect(() => {
    if (lastEvent?.type === 'catalogue.changed') load();
  }, [lastEvent, load]);

  const onDone = useCallback(() => {
    load();
    reloadConfig();
  }, [load, reloadConfig]);

  if (error) return <div className="empty bad">{error}</div>;
  if (!catalogue) return <div className="empty">Loading the catalogue…</div>;
  const Tab = TABS.find(([key]) => key === tab)[2];
  return (
    <div className="staff-page catalogue-page">
      <p className="muted">
        What <strong>{catalogue.centre.name}</strong> offers and the capacity it has to offer it. Changes apply to new bookings at once and are recorded in the audit trail.
        {config?.simulator && ' This is a synthetic demo centre, so it is regenerated each day.'}
      </p>
      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <Tab catalogue={catalogue} onDone={onDone} />
    </div>
  );
}

export default function CataloguePage() {
  const { can } = useAuth();
  if (!can('settings')) {
    return (
      <div className="empty">
        <h2>Managers only</h2>
        <p className="muted">Ask a manager to change services, resources or opening hours.</p>
      </div>
    );
  }
  return <CatalogueEditor />;
}
