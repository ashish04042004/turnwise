/** A time of day as the centre's staff and patients read it (centre locale and timezone). */
export const fmtTime = (d, centre) => new Date(d).toLocaleTimeString(centre.locale, { hour: '2-digit', minute: '2-digit', timeZone: centre.timezone });

/**
 * Fills a message template (message_templates table, centre wording over the
 * global default). `{centre}` is always available; unknown placeholders are
 * left as written so a typo in a template is visible rather than silent.
 */
export function renderMessage(centre, key, vars = {}) {
  const body = centre.templates[key];
  if (!body) throw new Error(`No message template "${key}" for ${centre.name}`);
  const values = { centre: centre.name, ...vars };
  return body.replace(/\{(\w+)\}/g, (placeholder, name) => (values[name] == null ? placeholder : String(values[name])));
}
