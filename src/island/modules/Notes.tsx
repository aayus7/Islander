// Quick Notes (iOS Notes scratchpad) and To-Do (iOS Reminders-style list).
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { bridge } from "../../bridge";
import { persistent, uid, useStore } from "../../lib/persist";
import { Glyph, Segmented } from "./ui";

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  at: number;
}

export const notesStore = persistent<{ text: string; view: "notes" | "todo" }>("notes", { text: "", view: "todo" });
export const todoStore = persistent<Todo[]>("todos", []);

/** Typing needs the island to take keyboard focus (it normally never does). */
export function keyboardProps() {
  return {
    onFocus: () => bridge.aiFocus(true),
    onBlur: () => bridge.aiFocus(false),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  };
}

export function NotesPanel({ width, height }: { width: number; height: number }) {
  const n = useStore(notesStore);
  return (
    <div className="mod" style={{ width, height }}>
      <Segmented
        value={n.view}
        onChange={(view) => notesStore.set((s) => ({ ...s, view }))}
        options={[
          { value: "todo", label: "To-Do" },
          { value: "notes", label: "Notes" },
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={n.view}
          className="notes-body"
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, filter: "blur(4px)" }}
          transition={{ duration: 0.16 }}
        >
          {n.view === "notes" ? <Scratchpad text={n.text} /> : <TodoList />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Scratchpad({ text }: { text: string }) {
  return (
    <textarea
      className="scratch"
      value={text}
      placeholder="Jot something down…"
      spellCheck={false}
      onChange={(e) => notesStore.set((s) => ({ ...s, text: e.target.value }))}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
      }}
      {...keyboardProps()}
    />
  );
}

function TodoList() {
  const todos = useStore(todoStore);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    todoStore.set((ts) => [...ts, { id: uid(), text, done: false, at: Date.now() }]);
    setDraft("");
  };

  return (
    <div className="todo">
      <div className="todo-list fade-y">
        <AnimatePresence initial={false}>
          {[...open, ...done.slice(-3)].map((t) => (
            <TodoRow key={t.id} t={t} />
          ))}
        </AnimatePresence>
        {todos.length === 0 && <div className="dim todo-empty">Nothing to do. Add something below.</div>}
      </div>
      <div className="todo-add" onClick={() => input.current?.focus()}>
        <span className="todo-plus">
          <Glyph.plus size={13} />
        </span>
        <input
          ref={input}
          className="todo-input"
          value={draft}
          placeholder="New Reminder"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          {...keyboardProps()}
        />
        {done.length > 0 && (
          <button
            className="todo-clear"
            onClick={(e) => {
              e.stopPropagation();
              todoStore.set((ts) => ts.filter((t) => !t.done));
            }}
          >
            Clear done
          </button>
        )}
      </div>
    </div>
  );
}

function TodoRow({ t }: { t: Todo }) {
  return (
    <motion.div
      layout
      className="todo-row"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 32 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 36, opacity: { duration: 0.18 } }}
    >
      <button
        className="todo-check"
        onClick={(e) => {
          e.stopPropagation();
          todoStore.set((ts) => ts.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)));
        }}
      >
        <motion.span className="todo-check-fill" initial={false} animate={{ scale: t.done ? 1 : 0, opacity: t.done ? 1 : 0 }} transition={{ type: "spring", stiffness: 520, damping: 28 }} />
        <motion.span className="todo-check-mark" initial={false} animate={{ opacity: t.done ? 1 : 0 }}>
          <Glyph.check size={11} />
        </motion.span>
      </button>
      <motion.span className="todo-text" animate={{ opacity: t.done ? 0.45 : 1 }} style={{ textDecoration: t.done ? "line-through" : "none" }}>
        {t.text}
      </motion.span>
      <button
        className="todo-del"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          todoStore.set((ts) => ts.filter((x) => x.id !== t.id));
        }}
      >
        <Glyph.x size={11} />
      </button>
    </motion.div>
  );
}
