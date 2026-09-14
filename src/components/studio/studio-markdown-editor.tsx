'use client';

import { useEffect } from 'react';
import Link from '@tiptap/extension-link';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import styles from './studio-markdown-editor.module.css';

export function StudioMarkdownEditor({
  markdown,
  onChange,
  editable,
}: {
  markdown: string;
  onChange: (markdown: string) => void;
  editable: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({
        openOnClick: !editable,
        HTMLAttributes: { class: 'underline underline-offset-2' },
      }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    ],
    content: markdown,
    contentType: 'markdown',
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor: current }) => onChange(current.getMarkdown()),
    editorProps: {
      attributes: {
        class: 'prose-editor focus:outline-none min-h-[55vh]',
      },
    },
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);

  useEffect(() => {
    if (!editor || markdown === editor.getMarkdown()) return;
    editor.commands.setContent(markdown, { contentType: 'markdown' });
  }, [editor, markdown]);

  if (!editor) {
    return <div className="min-h-[55vh] animate-pulse rounded-lg bg-minimal-row" />;
  }

  return (
    <div className={styles.editor}>
      {editable && (
        <div className="sticky top-0 z-10 mb-8 flex flex-wrap items-center gap-1 border-b border-minimal-border bg-minimal-bg/95 pb-4 pt-1 backdrop-blur">
          <ToolbarButton
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            label="H2"
          />
          <ToolbarButton
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            label="H3"
          />
          <Divider />
          <ToolbarButton
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
            label="B"
            className="font-bold"
          />
          <ToolbarButton
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            label="I"
            className="italic"
          />
          <Divider />
          <ToolbarButton
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            label="List"
          />
          <ToolbarButton
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            label="1."
          />
          <Divider />
          <ToolbarButton
            active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            label="Quote"
          />
          <ToolbarButton
            active={editor.isActive('link')}
            onClick={() => {
              const previous = editor.getAttributes('link').href as string | undefined;
              const url = window.prompt('URL:', previous ?? 'https://');
              if (url === null) return;
              if (!url.trim()) editor.chain().focus().unsetLink().run();
              else editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
            }}
            label="Link"
          />
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

function Divider() {
  return <div className="mx-2 h-4 w-px bg-minimal-border" />;
}

function ToolbarButton({
  active,
  onClick,
  label,
  className = '',
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
        active ? 'bg-minimal-accent text-minimal-bg' : 'text-minimal-muted hover:text-minimal-accent'
      } ${className}`}
    >
      {label}
    </button>
  );
}
