/**
 * The code, Markdown and rich-text editors. About 17 KB minified; an app
 * that edits text is the exception, not the rule.
 */
export * from '../editors';

import { CodeEditor } from '../editors/CodeEditor';
import { MarkdownEditor } from '../editors/MarkdownEditor';
import { RichTextEditor } from '../editors/RichTextEditor';

export const editorComponents = { CodeEditor, MarkdownEditor, RichTextEditor };
