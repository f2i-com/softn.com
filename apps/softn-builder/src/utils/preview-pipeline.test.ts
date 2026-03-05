/**
 * Test: Preview pipeline round-trip for GlamourStudio
 *
 * Traces the exact data flow: original source → parseSource → elements
 * → generateSource → mergeGeneratedTemplateIntoSource → final source
 *
 * This is the same path the LivePreview takes for the active file.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseSource } from './sourceParser';
import { generateSource } from './sourceGenerator';

// ─── Helpers copied from LivePreview ───

function extractFirstBlock(source: string, regex: RegExp): string | null {
  const m = source.match(regex);
  return m ? m[0].trim() : null;
}

function extractAllBlocks(source: string, regex: RegExp): string[] {
  return Array.from(source.matchAll(regex))
    .map((m) => m[0].trim())
    .filter(Boolean);
}

function mergeGeneratedTemplateIntoSource(
  originalSource: string | undefined,
  generatedSource: string
): string {
  const generatedDataBlock = extractFirstBlock(
    generatedSource,
    /<data>[\s\S]*?<\/data>/i
  );
  const generatedLogicBlock = extractFirstBlock(
    generatedSource,
    /<logic>[\s\S]*?<\/logic>/i
  );
  const templateOnly = generatedSource
    .replace(/<data>[\s\S]*?<\/data>/gi, '')
    .replace(/<logic>[\s\S]*?<\/logic>/gi, '')
    .trim();

  if (!originalSource) {
    return generatedSource;
  }

  const preservedLogicSrc = extractFirstBlock(
    originalSource,
    /<logic\s+src=["'][^"']+["']\s*\/>/i
  );
  const preservedInlineLogic = extractFirstBlock(
    originalSource,
    /<logic>[\s\S]*?<\/logic>/i
  );
  const preservedImports = extractAllBlocks(
    originalSource,
    /<import\s+(?:\{\s*[^}]+\s*\}|\w+)\s+from=["'][^"']+["']\s*\/>/gi
  );
  const preservedData = extractFirstBlock(
    originalSource,
    /<data>[\s\S]*?<\/data>/i
  );
  const preservedStyles = extractAllBlocks(
    originalSource,
    /<style>[\s\S]*?<\/style>/gi
  );

  const logicBlock =
    preservedLogicSrc || preservedInlineLogic || generatedLogicBlock;
  const dataBlock = preservedData || generatedDataBlock;

  const headerBlocks = [
    logicBlock,
    preservedImports.length > 0 ? preservedImports.join('\n') : null,
    dataBlock,
    ...preservedStyles,
  ].filter((block): block is string => Boolean(block && block.trim()));

  return [headerBlocks.join('\n\n'), templateOnly]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function stripComments(source: string): string {
  return source
    .replace(/^\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

// ─── Tests ───

const GLAMOUR_DIR = path.resolve(
  __dirname,
  '../../../demo/bundles/GlamourStudio'
);

describe('Preview pipeline round-trip', () => {
  it('parseSource succeeds for main.ui', () => {
    const source = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/main.ui'),
      'utf-8'
    );
    const parsed = parseSource(source);

    expect(parsed.elements.size).toBeGreaterThan(0);
    expect(parsed.rootId).toBeTruthy();

    console.log('[main.ui] Elements:', parsed.elements.size);
    console.log('[main.ui] Root ID:', parsed.rootId);
    console.log('[main.ui] Logic source length:', parsed.logicSource.length);
    console.log('[main.ui] Logic src:', parsed.logicSrc);
    console.log('[main.ui] Imports:', parsed.imports.length);
    console.log('[main.ui] Collections:', parsed.collections.length);

    // Should have detected the external logic reference
    expect(parsed.logicSrc).toBe('../logic/main.logic');
  });

  it('generateSource produces valid template from parsed elements', () => {
    const source = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/main.ui'),
      'utf-8'
    );
    const parsed = parseSource(source);

    // Generate with empty logic/collections (template-only, like updateUIFile)
    const generated = generateSource(parsed.elements, parsed.rootId, '', []);

    console.log('\n[main.ui] Generated template-only (first 1000 chars):');
    console.log(generated.substring(0, 1000));
    console.log('...');
    console.log('[main.ui] Generated template length:', generated.length);

    // Should have an App root element
    expect(generated).toContain('<App');
    // Should NOT have <data> or <logic> blocks (template-only)
    expect(generated).not.toMatch(/<data>/i);
    expect(generated).not.toMatch(/<logic>/i);
  });

  it('generateSource with logic and collections', () => {
    const source = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/main.ui'),
      'utf-8'
    );
    const logicSource = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'logic/main.logic'),
      'utf-8'
    );
    const parsed = parseSource(source);

    // Generate with logic (like the preview does)
    const generated = generateSource(
      parsed.elements,
      parsed.rootId,
      logicSource,
      parsed.collections
    );

    console.log(
      '\n[main.ui] Generated with logic+collections (first 500 chars):'
    );
    console.log(generated.substring(0, 500));
    console.log('...');
    console.log('[main.ui] Full generated length:', generated.length);

    // Should have logic block
    expect(generated).toContain('<logic>');
  });

  it('mergeGeneratedTemplateIntoSource preserves headers for main.ui', () => {
    const originalSource = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/main.ui'),
      'utf-8'
    );
    const logicSource = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'logic/main.logic'),
      'utf-8'
    );
    const parsed = parseSource(originalSource);
    const generated = generateSource(
      parsed.elements,
      parsed.rootId,
      logicSource,
      parsed.collections
    );

    const merged = mergeGeneratedTemplateIntoSource(originalSource, generated);

    console.log('\n[main.ui] Merged source (first 2000 chars):');
    console.log(merged.substring(0, 2000));
    console.log('...');
    console.log('[main.ui] Merged source length:', merged.length);

    // Should preserve logic src reference (NOT inline logic)
    expect(merged).toContain('<logic src="../logic/main.logic" />');
    expect(merged).not.toContain('<logic>\n');

    // Should preserve imports
    expect(merged).toContain(
      '<import Sidebar from="./components/Sidebar.ui" />'
    );
    expect(merged).toContain(
      '<import SyncModal from="./modals/SyncModal.ui" />'
    );

    // Should preserve data block with original format
    expect(merged).toContain('<collection name="clients" as="clients" />');
    expect(merged).toContain('sort="time:asc"');

    // Should preserve style block
    expect(merged).toContain('<style>');
    expect(merged).toContain('glamour-fade-up');
    expect(merged).toContain('</style>');

    // Should have template content
    expect(merged).toContain('<App');
  });

  it('stripComments does not break the merged source', () => {
    const originalSource = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/main.ui'),
      'utf-8'
    );
    const logicSource = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'logic/main.logic'),
      'utf-8'
    );
    const parsed = parseSource(originalSource);
    const generated = generateSource(
      parsed.elements,
      parsed.rootId,
      logicSource,
      parsed.collections
    );
    const merged = mergeGeneratedTemplateIntoSource(originalSource, generated);
    const cleaned = stripComments(merged);

    console.log('\n[main.ui] After stripComments (first 2000 chars):');
    console.log(cleaned.substring(0, 2000));
    console.log('...');
    console.log('[main.ui] Cleaned source length:', cleaned.length);

    // stripComments should NOT remove CSS inside <style>
    expect(cleaned).toContain('<style>');
    expect(cleaned).toContain('glamour-fade-up');
    // But should remove // comments
    expect(cleaned).not.toMatch(/^\/\/ main\.ui/m);
  });

  it('round-trip for simple component: Header.ui', () => {
    const source = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/components/Header.ui'),
      'utf-8'
    );
    const parsed = parseSource(source);
    const generated = generateSource(parsed.elements, parsed.rootId, '', []);

    console.log('\n[Header.ui] Original (first 500 chars):');
    console.log(source.substring(0, 500));
    console.log('\n[Header.ui] Generated (first 500 chars):');
    console.log(generated.substring(0, 500));
    console.log('\n[Header.ui] Elements:', parsed.elements.size);

    // Should preserve key elements (Header.ui root is Box, not Container)
    expect(generated).toContain('<Box');
    // Key: does it preserve expression props like conditional attributes?
    for (const [, el] of parsed.elements) {
      if (el.conditionalIf) {
        console.log(
          `[Header.ui] Element ${el.componentType} has if={${el.conditionalIf}}`
        );
      }
      if (el.events && Object.keys(el.events).length > 0) {
        console.log(
          `[Header.ui] Element ${el.componentType} has events:`,
          el.events
        );
      }
      if (el.expressionProps && el.expressionProps.length > 0) {
        console.log(
          `[Header.ui] Element ${el.componentType} has expression props:`,
          el.expressionProps,
          'values:',
          Object.fromEntries(
            el.expressionProps.map((p) => [p, el.props[p]])
          )
        );
      }
    }
  });

  it('round-trip for Dashboard.ui', () => {
    const source = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/pages/Dashboard.ui'),
      'utf-8'
    );
    const parsed = parseSource(source);
    const generated = generateSource(parsed.elements, parsed.rootId, '', []);

    console.log('\n[Dashboard.ui] Original length:', source.length);
    console.log('[Dashboard.ui] Generated length:', generated.length);
    console.log('[Dashboard.ui] Elements:', parsed.elements.size);

    // The dashboard uses if={currentPage === "dashboard"} - check it's preserved
    const rootElement = parsed.elements.get(parsed.rootId);
    console.log(
      '[Dashboard.ui] Root element:',
      rootElement?.componentType,
      'if:',
      rootElement?.conditionalIf
    );

    // Check generated output preserves the conditional
    if (rootElement?.conditionalIf) {
      expect(generated).toContain(`if={${rootElement.conditionalIf}}`);
    }
  });

  it('CRITICAL: generateSource preserves all explicit props (no default stripping)', () => {
    // Header.ui has variant=primary on some buttons and variant=ghost on others
    const source = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/components/Header.ui'),
      'utf-8'
    );
    const parsed = parseSource(source);
    const generated = generateSource(parsed.elements, parsed.rootId, '', []);

    // Count variant props in parsed elements
    const variants: Record<string, number> = {};
    for (const [, el] of parsed.elements) {
      if (el.props.variant !== undefined) {
        const v = String(el.props.variant);
        variants[v] = (variants[v] || 0) + 1;
      }
    }
    console.log('\n[Header.ui] Variant distribution in parsed elements:', variants);

    // The generated source MUST preserve variant=primary even though it matches
    // the Button component's default value. Stripping defaults corrupts the
    // source on file-switch round-trips.
    const variantPrimaryCount = (generated.match(/variant="primary"/g) || []).length;
    const variantGhostCount = (generated.match(/variant="ghost"/g) || []).length;

    console.log('[Header.ui] variant="primary" in generated:', variantPrimaryCount);
    console.log('[Header.ui] variant="ghost" in generated:', variantGhostCount);

    // Header.ui has 4 primary buttons and 4 ghost buttons
    expect(variantGhostCount).toBeGreaterThan(0);
    // THIS IS THE BUG: variant=primary gets stripped because it matches the
    // Button component default. This test will FAIL until we fix the
    // default-stripping logic in sourceGenerator.ts.
    expect(variantPrimaryCount).toBeGreaterThan(0);
  });

  it('CRITICAL: round-trip does not inject App wrapper into component files', () => {
    // Dashboard.ui starts with <Stack>, not <App>.
    // After parseSource → generateSource round-trip, it must NOT have an <App> wrapper.
    const source = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/pages/Dashboard.ui'),
      'utf-8'
    );
    const parsed = parseSource(source);

    // Generate with skipRootAppWrapper (what updateUIFile would use)
    const generated = generateSource(parsed.elements, parsed.rootId, '', [], {
      skipRootAppWrapper: true,
    });

    console.log(
      '\n[Dashboard.ui] Generated (skipRootApp) first 200 chars:',
      generated.substring(0, 200)
    );

    // The generated output should NOT start with <App>
    expect(generated.trim()).not.toMatch(/^<App[\s>]/);
    // It SHOULD start with the original root element type (<Stack>)
    expect(generated.trim()).toMatch(/^<Stack[\s>]/);
  });

  it('full pipeline simulation: main.ui → resolved preview source', () => {
    // Load all source files
    const mainSource = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'ui/main.ui'),
      'utf-8'
    );
    const logicSource = fs.readFileSync(
      path.join(GLAMOUR_DIR, 'logic/main.logic'),
      'utf-8'
    );

    // Load all imported component files
    const componentFiles = new Map<string, string>();
    const uiDir = path.join(GLAMOUR_DIR, 'ui');
    function walkDir(dir: string, prefix: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walkDir(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        } else if (entry.name.endsWith('.ui')) {
          const filePath = `${prefix}${entry.name}`;
          componentFiles.set(
            filePath,
            fs.readFileSync(path.join(dir, entry.name), 'utf-8')
          );
        }
      }
    }
    walkDir(uiDir, '');
    console.log(
      '\n[Pipeline] Component files:',
      Array.from(componentFiles.keys())
    );

    // Step 1: Parse main.ui
    const parsed = parseSource(mainSource);
    expect(parsed.elements.size).toBeGreaterThan(0);

    // Step 2: Generate source with logic
    const generated = generateSource(
      parsed.elements,
      parsed.rootId,
      logicSource,
      parsed.collections
    );

    // Step 3: Merge with original
    const merged = mergeGeneratedTemplateIntoSource(mainSource, generated);

    // Step 4: Resolve external logic
    let resolved = merged.replace(
      /<logic\s+src=["']([^"']+)["']\s*\/>/g,
      () => `<logic>\n${logicSource}\n</logic>`
    );

    // Step 5: Resolve imports (simplified - just inline component templates)
    const importRegex =
      /<import\s+(\w+)\s+from=["']([^"']+)["']\s*\/>/g;
    const imports: { name: string; path: string }[] = [];
    let m;
    while ((m = importRegex.exec(resolved)) !== null) {
      imports.push({ name: m[1], path: m[2] });
    }
    // Remove import tags
    resolved = resolved.replace(/<import\s+[^>]+\/>/g, '');

    // Inline each imported component
    for (const imp of imports) {
      // Resolve path: ./components/X.ui → components/X.ui
      const normalizedPath = imp.path.replace(/^\.\//, '');
      const componentSource = componentFiles.get(normalizedPath);
      if (componentSource) {
        const template = componentSource
          .replace(/<data>[\s\S]*?<\/data>/g, '')
          .replace(/<logic>[\s\S]*?<\/logic>/g, '')
          .replace(/<logic\s+[^>]*\/>/g, '')
          .replace(/<import\s+[^>]+\/>/g, '')
          .trim();

        const selfClosing = new RegExp(`<${imp.name}\\s*/>`, 'g');
        resolved = resolved.replace(selfClosing, template);
      }
    }

    // Step 6: Strip comments
    const final = stripComments(resolved);

    console.log('[Pipeline] Final source length:', final.length);
    console.log('[Pipeline] First 500 chars:');
    console.log(final.substring(0, 500));

    // Verify the final source is complete
    expect(final).toContain('<logic>');
    expect(final).toContain('</logic>');
    expect(final).toContain('<data>');
    expect(final).toContain('</data>');
    expect(final).toContain('<style>');
    expect(final).toContain('</style>');
    expect(final).toContain('<App');
    expect(final).toContain('</App>');

    // Verify logic content is present
    expect(final).toContain('let currentPage');
    expect(final).toContain('function navigate');

    // Verify inlined components are present (Header.ui contains Stack, Button, etc.)
    expect(final).toContain('<Stack');
    expect(final).toContain('<Button');

    // Verify style animations are preserved
    expect(final).toContain('glamour-fade-up');
  });
});
