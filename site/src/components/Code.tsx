import { useState, type ReactNode } from "react";
import { IconCheck, IconCopy, IconDownload } from "./icons";
import "./code.css";

type Lang = "python" | "rust" | "qasm" | "json" | "shell" | "text" | "lp";

const KEYWORDS: Record<Lang, string[]> = {
  python: ["import", "from", "as", "def", "return", "for", "in", "if", "else", "elif", "print", "range", "None", "True", "False", "with", "lambda", "and", "or", "not"],
  rust: ["use", "let", "mut", "fn", "pub", "struct", "impl", "for", "in", "if", "else", "match", "return", "as", "const", "crate", "self", "Some", "None", "Ok", "Err"],
  qasm: ["OPENQASM", "include", "qreg", "creg", "qubit", "bit", "gate", "measure", "barrier", "ctrl", "negctrl", "inv", "pow", "reset"],
  json: ["true", "false", "null"],
  shell: ["cargo", "npm", "pip", "git", "cd"],
  lp: ["Minimize", "Maximize", "Subject", "To", "Bounds", "Binaries", "Binary", "General", "End", "obj"],
  text: [],
};

const COMMENT: Record<Lang, RegExp | null> = {
  python: /#.*$/,
  shell: /#.*$/,
  rust: /\/\/.*$/,
  qasm: /\/\/.*$/,
  lp: /\\.*$/,
  json: null,
  text: null,
};

/** A small, dependency-free line highlighter: comments, strings, numbers, keywords, calls. */
function highlight(code: string, lang: Lang): ReactNode[] {
  if (lang === "text") return [code];
  const kw = new Set(KEYWORDS[lang]);
  const out: ReactNode[] = [];
  const lines = code.split("\n");
  lines.forEach((line, li) => {
    let rest = line;
    let comment = "";
    const cm = COMMENT[lang]?.exec(line);
    if (cm && !insideString(line, cm.index)) {
      rest = line.slice(0, cm.index);
      comment = line.slice(cm.index);
    }
    const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let k = 0;
    while ((m = re.exec(rest))) {
      if (m.index > last) out.push(rest.slice(last, m.index));
      if (m[1]) out.push(<span key={`${li}-${k++}`} className="tok-s">{m[1]}</span>);
      else if (m[2]) out.push(<span key={`${li}-${k++}`} className="tok-n">{m[2]}</span>);
      else if (m[3]) {
        if (kw.has(m[3])) out.push(<span key={`${li}-${k++}`} className="tok-k">{m[3]}</span>);
        else if (m[4]) out.push(<span key={`${li}-${k++}`} className="tok-f">{m[3]}</span>);
        else out.push(m[3]);
        if (m[4]) out.push(m[4]);
      }
      last = re.lastIndex;
    }
    if (last < rest.length) out.push(rest.slice(last));
    if (comment) out.push(<span key={`${li}-c`} className="tok-c">{comment}</span>);
    if (li < lines.length - 1) out.push("\n");
  });
  return out;
}

function insideString(line: string, idx: number): boolean {
  let q: string | null = null;
  for (let i = 0; i < idx; i++) {
    const c = line[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
  }
  return q !== null;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function download(filename: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CopyButton({ text, label = "Copy", small = true }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`btn ${small ? "sm" : ""} copy-btn${done ? " is-done" : ""}`}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }
      }}
    >
      {/* both icons share one cell and trade places, so the confirmation can morph instead of swap */}
      <span className="cp-ico"><IconCopy size={14} /><IconCheck size={14} /></span> {done ? "Copied" : label}
    </button>
  );
}

const LANG_LABEL: Record<Lang, string> = { python: "Python", rust: "Rust", qasm: "OpenQASM", json: "JSON", shell: "Shell", text: "Text", lp: "LP" };

export function CodeBlock({ code, lang = "text", filename, maxHeight }: { code: string; lang?: Lang; filename?: string; maxHeight?: number }) {
  return (
    <div className="code">
      <div className="code-bar">
        <span className="code-name">{filename ?? LANG_LABEL[lang]}</span>
        <div style={{ display: "flex", gap: 6 }}>
          {filename && (
            <button className="btn sm icon ghost dl-btn" title={`Download ${filename}`} aria-label={`Download ${filename}`} onClick={() => download(filename, code)}>
              <IconDownload size={14} />
            </button>
          )}
          <CopyButton text={code} />
        </div>
      </div>
      <pre style={maxHeight ? { maxHeight } : undefined}><code>{highlight(code, lang)}</code></pre>
    </div>
  );
}
