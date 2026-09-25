/**
 * The agent's reference material: a compact index that goes into every
 * system prompt, and the full component reference and guides the
 * lookup_components and read_docs tools answer from. All of it is generated
 * from the component manifest and the published docs
 * (scripts/generate-agent-knowledge.mjs); the large parts load on first use.
 */

import { COMPONENT_INDEX, DOC_INDEX } from './index.generated';

export { COMPONENT_INDEX, DOC_INDEX };

/** Every registered component, grouped, one line each: for the system prompt. */
export function componentIndexText(): string {
  const groups = new Map<string, string[]>();
  for (const entry of COMPONENT_INDEX) {
    if (!entry.registered) continue;
    const list = groups.get(entry.category) ?? [];
    list.push(`- ${entry.name}: ${entry.purpose}`);
    groups.set(entry.category, list);
  }
  return [...groups].map(([group, lines]) => `**${group}**\n${lines.join('\n')}`).join('\n');
}

const OTHER_LANGUAGE = /python|torch/i;

/**
 * The guides by slug, one line each: for the system prompt. A JavaScript
 * project is not pointed at the Python guides — its prompt teaches the one
 * language it writes — though read_docs still serves every guide.
 */
export function docIndexText(python = true): string {
  return DOC_INDEX.filter((d) => python || !OTHER_LANGUAGE.test(`${d.slug} ${d.title.replace(/ or Python$/, '')}`))
    .map((d) => {
      const title = python ? d.title : d.title.replace(/ (or|and) Python\b/g, '');
      const sections = python ? d.sections : d.sections.filter((s) => !OTHER_LANGUAGE.test(s));
      return `- ${d.slug}: ${title} — sections: ${sections.join(', ')}`;
    })
    .join('\n');
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export async function lookupComponents(names: string[]): Promise<{ ok: boolean; text: string }> {
  const { COMPONENT_REFERENCE } = await import('./components.generated');
  const byNorm = new Map(Object.keys(COMPONENT_REFERENCE).map((n) => [norm(n), n]));
  const found: string[] = [];
  const unknown: string[] = [];
  for (const raw of names.slice(0, 12)) {
    const name = byNorm.get(norm(raw.replace(/[<>/]/g, '')));
    if (name) found.push(COMPONENT_REFERENCE[name]);
    else unknown.push(raw);
  }
  const parts = [...found];
  if (unknown.length > 0) {
    const all = COMPONENT_INDEX.filter((c) => c.registered).map((c) => c.name);
    parts.push(`Not components: ${unknown.join(', ')}. The registered components are: ${all.join(', ')}.`);
  }
  if (names.length > 12) parts.push(`Only the first 12 names were looked up; ask again for the rest.`);
  return { ok: found.length > 0, text: parts.join('\n\n') };
}

export async function readDocs(topic: string): Promise<{ ok: boolean; text: string }> {
  const { DOC_PAGES } = await import('./docs.generated');
  const [pagePart, sectionPart] = topic.trim().replace(/^\/+/, '').split('#');
  const page = DOC_PAGES.find((p) => p.slug === pagePart) ?? DOC_PAGES.find((p) => norm(p.slug) === norm(pagePart) || norm(p.title) === norm(pagePart));
  if (!page) {
    return { ok: false, text: `There is no guide "${pagePart}". The guides are:\n${docIndexText()}` };
  }
  const sections = sectionPart ? page.sections.filter((s) => s.id === sectionPart || norm(s.title) === norm(sectionPart)) : page.sections;
  if (sections.length === 0) {
    return { ok: false, text: `${page.slug} has no section "${sectionPart}". Its sections: ${page.sections.map((s) => s.id).join(', ')}.` };
  }
  const text = `# ${page.title}\n${page.summary}\n\n${sections.map((s) => `## ${s.title} (#${s.id})\n${s.text}`).join('\n\n')}`;
  return { ok: true, text: text.length > 24_000 ? `${text.slice(0, 24_000)}\n… (cut; ask for one section with ${page.slug}#section)` : text };
}
